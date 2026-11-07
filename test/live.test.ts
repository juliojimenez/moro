/**
 * The live backend: lisp/moro-backend.lisp loaded into a real SBCL, talked to
 * through LiveImage. Skipped when sbcl is not on PATH.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { LiveImage, decodeEvaluation, decodeInspector, lispString, nameOf, plist, stringOf } from '../src/common/live';
import { parse } from '../src/common/reader';

const BACKEND = path.resolve(__dirname, '..', '..', 'lisp', 'moro-backend.lisp');
const hasSbcl = spawnSync('sbcl', ['--version'], { stdio: 'ignore' }).status === 0;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

test('request helpers', () => {
  assert.equal(lispString('a "b" c\\d'), '"a \\"b\\" c\\\\d"');
  const form = parse('(:ok :name "my-fn" :kinds (:function :variable) :docs ((:function "Doc \\"quoted\\".")))').forms[0];
  const fields = plist(form);
  assert.equal(stringOf(fields.get('name')), 'my-fn');
  assert.equal(nameOf(fields.get('kinds')), null);
  assert.equal(nameOf(form.kind === 'list' ? form.children[0] : undefined), 'ok');
  const docs = fields.get('docs');
  assert.ok(docs && docs.kind === 'list');
  const entry = docs.children[0];
  assert.ok(entry.kind === 'list');
  assert.equal(stringOf(entry.children[1]), 'Doc "quoted".');
});

let proc: ChildProcess | undefined;
let dir: string;
let port: number;
let tokenPath: string;
const live = new LiveImage();

before(async () => {
  if (!hasSbcl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-live-'));
  tokenPath = path.join(dir, 'token');
  fs.writeFileSync(tokenPath, 'test-token-abc', { mode: 0o600 });
  port = await freePort();
  proc = spawn(
    'sbcl',
    [
      '--noinform',
      '--non-interactive',
      '--load',
      BACKEND,
      '--eval',
      `(moro-backend:start ${port} ${lispString(tokenPath.split(path.sep).join('/'))})`,
      '--eval',
      '(progn (defun cl-user::my-live-fn (a &key b) "Live doc." (list a b)) (defvar cl-user::*live-var* 1 "A variable.") (sleep 120))',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await live.connect({ port, tokenPath });
});

after(() => {
  live.disconnect();
  proc?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('connects and reports the implementation', { skip: !hasSbcl }, () => {
  assert.equal(live.connected, true);
  assert.equal(live.status.implementation, 'SBCL');
  assert.ok(live.status.features.includes('arglists'));
});

test('arglists and documentation of standard and user symbols', { skip: !hasSbcl }, async () => {
  assert.equal(await live.arglist('MAPCAR', 'COMMON-LISP'), '(function list &rest more-lists)');
  assert.equal(await live.arglist('MY-LIVE-FN', 'COMMON-LISP-USER'), '(a &key b)');
  assert.equal(await live.arglist('NO-SUCH-FUNCTION', 'CL-USER'), null);
  const doc = await live.documentation('MY-LIVE-FN', 'CL-USER');
  assert.equal(doc?.name, 'my-live-fn');
  assert.equal(doc?.package, 'COMMON-LISP-USER');
  assert.deepEqual(doc?.kinds, ['function']);
  assert.deepEqual(doc?.docs, [{ kind: 'function', text: 'Live doc.' }]);
  const variable = await live.documentation('*LIVE-VAR*', 'CL-USER');
  assert.deepEqual(variable?.kinds, ['variable']);
  assert.equal(variable?.docs[0]?.text, 'A variable.');
});

test('completion of accessible and package-qualified symbols', { skip: !hasSbcl }, async () => {
  const mine = await live.complete('my-live', 'CL-USER');
  assert.deepEqual(mine, [{ name: 'my-live-fn', kind: 'function', package: 'COMMON-LISP-USER' }]);
  const qualified = await live.complete('sb-ext:posix-g', 'CL-USER');
  assert.ok(qualified.some((c) => c.name === 'posix-getenv' && c.kind === 'function' && c.package === 'SB-EXT'));
  const standard = (await live.complete('mapc', 'COMMON-LISP')).map((c) => c.name);
  assert.deepEqual(standard, ['mapc', 'mapcan', 'mapcar', 'mapcon']);
});

test('definitions with character offsets (SBCL)', { skip: !hasSbcl }, async () => {
  const defs = await live.definitions('MAPCAR', 'COMMON-LISP');
  assert.ok(defs.length >= 1);
  assert.ok(defs[0].file.endsWith('list.lisp'));
  assert.equal(typeof defs[0].offset, 'number');
  assert.deepEqual(await live.definitions('MY-LIVE-FN', 'CL-USER'), [], 'defined from the command line: no source');
});

test('evaluation: values, output, warnings, errors with backtraces, no debugger', { skip: !hasSbcl }, async () => {
  const defined = await live.evaluate('(defun inner (x) (+ 1 (/ 10 x))) (defun outer (x) (list (inner x)))', 'CL-USER');
  assert.deepEqual(defined && { ok: defined.ok, values: defined.values, package: defined.package }, { ok: true, values: ['OUTER'], package: 'COMMON-LISP-USER' });
  const several = await live.evaluate('(values 1 "two" :three)', 'CL-USER');
  assert.deepEqual(several?.values, ['1', '"two"', ':THREE']);
  const printed = await live.evaluate('(progn (format t "hello~%") (warn "careful") (list 1 2))', 'CL-USER');
  assert.equal(printed?.ok, true);
  assert.deepEqual(printed?.values, ['(1 2)']);
  assert.match(printed?.output ?? '', /hello\n;; careful/);
  const nothing = await live.evaluate('(values)', 'CL-USER');
  assert.deepEqual(nothing?.values, []);
  const failed = await live.evaluate('(outer 0)', 'CL-USER');
  assert.equal(failed?.ok, false);
  assert.match(failed?.error ?? '', /DIVISION-BY-ZERO/);
  assert.ok((failed?.backtrace.length ?? 0) > 0, 'a backtrace comes along');
  assert.ok(failed!.backtrace.some((frame) => /INNER/.test(frame)), 'the backtrace starts at user frames');
  assert.ok(!failed!.backtrace.some((frame) => /MORO-BACKEND/.test(frame)), 'the backend frames are trimmed');
  const broke = await live.evaluate('(break "stop here")', 'CL-USER');
  assert.deepEqual([broke?.ok, broke?.error], [false, 'stop here'], 'break is intercepted instead of entering the debugger');
  const eof = await live.evaluate('(read-line)', 'CL-USER');
  assert.equal(eof?.ok, false, 'reading from the editor has no input and fails instead of blocking');
  const unreadable = await live.evaluate('(list 1 2', 'CL-USER');
  assert.equal(unreadable?.ok, false);
  assert.equal(live.connected, true, 'the connection survives all of that');
});

test('interrupting a running evaluation from a second connection', { skip: !hasSbcl }, async () => {
  const control = new LiveImage();
  await control.connect({ port, tokenPath });
  const started = Date.now();
  const slow = live.evaluate('(sleep 30)', 'CL-USER');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await control.arglist('CAR', 'CL'), '(list)', 'the second connection is served while the evaluation runs');
  assert.equal(await control.interrupt(), true);
  const result = await slow;
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /Interrupted/);
  assert.ok(Date.now() - started < 10000, 'the evaluation stopped early');
  assert.deepEqual((await live.evaluate('(+ 1 2)', 'CL-USER'))?.values, ['3'], 'evaluation keeps working afterwards');
  assert.equal(await control.interrupt(), false, 'nothing to interrupt');
  control.disconnect();
});

test('inspector: parts, drill-down and back', { skip: !hasSbcl }, async () => {
  await live.evaluate('(defclass pt () ((x :initform 1) (y :initform (list 1 2 3)) (z)))', 'CL-USER');
  const top = await live.inspect("(make-instance 'pt)", 'CL-USER');
  assert.ok(top && 'view' in top);
  assert.equal(top.view.type, 'PT');
  assert.equal(top.view.depth, 1);
  assert.deepEqual(top.view.parts.map((p) => [p.label, p.value, p.expandable]), [['x', '1', false], ['y', '(1 2 3)', true], ['z', '#<unbound>', false]]);
  const list = await live.inspectPart(1);
  assert.ok(list && 'view' in list);
  assert.equal(list.view.type, 'CONS');
  assert.equal(list.view.depth, 2);
  assert.deepEqual(list.view.parts.map((p) => p.value), ['1', '2', '3']);
  const unbound = await live.inspectPart(5);
  assert.ok(unbound && 'error' in unbound);
  const back = await live.inspectPop();
  assert.ok(back && 'view' in back && back.view.type === 'PT');
  const table = await live.inspect('(let ((h (make-hash-table))) (setf (gethash :a h) 1) h)', 'CL-USER');
  assert.ok(table && 'view' in table);
  assert.deepEqual(table.view.parts.slice(0, 2).map((p) => p.label), ['count', 'test']);
  assert.deepEqual(table.view.parts[2], { index: 2, label: ':A', value: '1', expandable: false });
  const symbol = await live.inspect("'inner", 'CL-USER');
  assert.ok(symbol && 'view' in symbol);
  assert.deepEqual(symbol.view.parts.map((p) => p.label), ['name', 'package', 'value', 'function', 'plist']);
  const failing = await live.inspect('(error "boom")', 'CL-USER');
  assert.deepEqual(failing, { error: 'boom' });
  assert.equal(decodeEvaluation(null), null);
  assert.equal(decodeInspector(parse('(:none)').forms[0]), null);
});

test('packages, unknown requests and bad tokens', { skip: !hasSbcl }, async () => {
  const packages = await live.packages();
  assert.ok(packages.includes('COMMON-LISP') && packages.includes('MORO-BACKEND'));
  const bogus = await live.request('(:bogus)');
  assert.ok(bogus && bogus.kind === 'list' && nameOf(bogus.children[0]) === 'error');
  const readEval = await live.request('#.(quit)');
  assert.ok(readEval && readEval.kind === 'list' && nameOf(readEval.children[0]) === 'error', '#. is refused, the image is still alive');
  assert.equal(await live.arglist('CAR', 'CL'), '(list)');

  const wrongToken = path.join(dir, 'wrong');
  fs.writeFileSync(wrongToken, 'nope');
  const other = new LiveImage();
  await other.connect({ port, tokenPath: wrongToken });
  assert.equal(other.connected, false);
  other.disconnect();
});
