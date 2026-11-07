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
import { DebuggerEvent, LiveDefinition, LiveEvaluation, LiveImage, decodeEvaluation, decodeInspector, lispString, locateLiveDefinition, nameOf, plist, stringOf } from '../src/common/live';
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

test('locating live definitions: positions before or inside the form, and form indexes', () => {
  const text = '(in-package :cl-user)\n\n(defun f (a)\n  a)\n;; c\n(defvar *v* 1)\n';
  const result = parse(text);
  const f = text.indexOf('(defun');
  const v = text.indexOf('(defvar');
  const locate = (def: Partial<LiveDefinition>) => {
    const target = locateLiveDefinition(result, { file: 'x', type: 'function', ...def }, text.length);
    return target && [target.form.start, target.selection];
  };
  // SBCL and ECL report the end of the previous form, ABCL one character later, CCL the form's start.
  assert.deepEqual(locate({ offset: 21 }), [f, f]);
  assert.deepEqual(locate({ after: 21 }), [f, f]);
  assert.deepEqual(locate({ after: 22 }), [f, f]);
  assert.deepEqual(locate({ offset: f }), [f, f]);
  assert.deepEqual(locate({ offset: f + 8 }), [f, f + 8], 'inside the form keeps the position');
  assert.deepEqual(locate({ after: text.indexOf(';; c') - 1 }), [v, v], 'past the comment to the defvar');
  assert.equal(locate({ after: text.length }), null, 'nothing after the last form');
  assert.deepEqual(locate({ form: 1 }), [f, f]);
  assert.equal(locate({ form: 9 }), null);
  assert.equal(locate({}), null);
});

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

test('multi-line forms evaluate and inspect (the request spans lines)', { skip: !hasSbcl }, async () => {
  const defined = await live.evaluate('(defun two-lines (x)\n  "Doc over\n  two lines."\n  (* x 2))\n\n(two-lines 21)', 'CL-USER');
  assert.equal(defined?.ok, true, defined?.error);
  assert.deepEqual(defined?.values, ['42']);
  const doc = await live.documentation('TWO-LINES', 'CL-USER');
  assert.equal(doc?.docs[0]?.text, 'Doc over\n  two lines.');
  const inspected = await live.inspect('(list\n 1\n 2)', 'CL-USER');
  assert.ok(inspected && 'view' in inspected && inspected.view.parts.length === 2);
  assert.equal(await live.arglist('CAR', 'CL'), '(list)', 'the connection is still aligned');
});

test('backtraces show the user frames, not the evaluator machinery', { skip: !hasSbcl }, async () => {
  const failed = await live.evaluate('(in-package #:no-such-package-here)', 'CL-USER');
  assert.equal(failed?.ok, false);
  assert.match(failed?.error ?? '', /NO-SUCH-PACKAGE-HERE/);
  for (const frame of failed!.backtrace) {
    assert.ok(!/SB-C::|SB-INT:SIMPLE-EVAL|SB-IMPL::%SIMPLE-EVAL|\(EVAL |WITH-SIMPLE-CONDITION-RESTARTS|MORO-BACKEND/.test(frame), `machinery frame kept: ${frame}`);
  }
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

/**
 * Starts an evaluation with the debugger and runs `body` once the first
 * debugger event arrived. If `body` fails before the evaluation settled, the
 * debugger is aborted so the connection is usable for the next test.
 */
async function inDebugger<T>(
  text: string,
  body: (event: DebuggerEvent, done: Promise<LiveEvaluation | null>) => Promise<T>,
  onDebugError?: (message: string) => void,
): Promise<T> {
  const events: DebuggerEvent[] = [];
  let settled = false;
  const done = live.evaluate(text, 'CL-USER', { onDebug: (event) => events.push(event), onDebugError }).finally(() => {
    settled = true;
  });
  const deadline = Date.now() + 10000;
  while (!events.length && !settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  try {
    assert.ok(events.length, 'a debugger event arrived');
    return await body(events[0], done);
  } finally {
    if (!settled) {
      live.abortDebugger();
      await done;
    }
  }
}

test('debugger: the event, and restarts with values resume the evaluation', { skip: !hasSbcl }, async () => {
  await live.evaluate(
    '(defun dbg-inner (x) (list :before (restart-case (error "boom ~a" x) (use-value (v) :report "Use a value" (* v 2))) :after)) (defun dbg-outer (x) (let ((r (dbg-inner x))) (cons :outer r)))',
    'CL-USER',
  );
  assert.equal(live.debuggerActive, false);
  const errors: string[] = [];
  const result = await inDebugger(
    '(dbg-outer 1)',
    async (event, done) => {
      assert.equal(live.debuggerActive, true);
      assert.equal(event.level, 1);
      assert.equal(event.condition, 'boom 1');
      assert.equal(event.type, 'SIMPLE-ERROR');
      assert.deepEqual(event.restarts.map((r) => [r.index, r.name]), [[0, 'USE-VALUE'], [1, 'ABORT']], "the evaluation's restarts, not the thread's");
      assert.equal(event.restarts[0].description, 'Use a value');
      assert.deepEqual(event.frames.map((f) => f.text), ['(DBG-INNER 1)', '(DBG-OUTER 1)']);
      // A value form that fails to evaluate, then a bad index: the debugger stays open and reports both.
      assert.ok(live.invokeRestart(0, ['(error "no value")']));
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(live.invokeRestart(7));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(live.debuggerActive, true);
      assert.ok(live.invokeRestart(0, ['21']));
      return done;
    },
    (message) => errors.push(message),
  );
  assert.deepEqual(errors, ['no value', 'no such restart']);
  assert.deepEqual(result && { ok: result.ok, values: result.values }, { ok: true, values: ['(:OUTER :BEFORE 42 :AFTER)'] });
  assert.equal(live.debuggerActive, false);
});

test('debugger: continue, store-value and abort', { skip: !hasSbcl }, async () => {
  const continued = await inDebugger('(progn (cerror "Go on" "stop here") :went-on)', async (event, done) => {
    const cont = event.restarts.find((r) => r.name === 'CONTINUE');
    assert.ok(cont, 'a CONTINUE restart');
    assert.equal(cont.description, 'Go on');
    live.invokeRestart(cont.index);
    return done;
  });
  assert.deepEqual(continued?.values, [':WENT-ON']);

  const stored = await inDebugger('(defun dbg-triple (x) (check-type x integer) (* x 3)) (dbg-triple "a")', async (event, done) => {
    assert.match(event.condition, /INTEGER/);
    const store = event.restarts.find((r) => r.name === 'STORE-VALUE');
    assert.ok(store, 'a STORE-VALUE restart');
    live.invokeRestart(store.index, ['7']);
    return done;
  });
  assert.deepEqual(stored?.values, ['21']);

  const aborted = await inDebugger('(error "no way out")', async (_event, done) => {
    assert.ok(live.abortDebugger());
    return done;
  });
  assert.equal(aborted?.ok, false);
  assert.equal(aborted?.aborted, true);
  assert.match(aborted?.error ?? '', /no way out \(aborted\)/);
  assert.deepEqual((await live.evaluate('(+ 1 1)', 'CL-USER'))?.values, ['2'], 'evaluation works afterwards');
});

test('debugger: frame locals, inspecting a local and the condition, commands outside a debugger', { skip: !hasSbcl }, async () => {
  // At debug 3 SBCL keeps every variable for its whole scope; at the default policy a local dead after the call shows as not available.
  await live.evaluate('(declaim (optimize (debug 3))) (defun locals-demo (a) (let ((b (* a 2))) (error "here ~a" b)))', 'CL-USER');
  try {
    await inDebugger('(locals-demo 21)', async (event, done) => {
      const frame = event.frames.find((f) => /LOCALS-DEMO/.test(f.text));
      assert.ok(frame, `a LOCALS-DEMO frame in ${event.frames.map((f) => f.text).join(' | ')}`);
      const locals = await live.frameLocals(frame.index);
      const byName = new Map(locals.map((l) => [l.name, l.value]));
      assert.equal(byName.get('a'), '21');
      assert.equal(byName.get('b'), '42');
      const inspected = await live.inspectLocal(frame.index, locals.findIndex((l) => l.name === 'b'));
      assert.ok(inspected && 'view' in inspected && inspected.view.title === '42', JSON.stringify(inspected));
      const condition = await live.inspectCondition();
      assert.ok(condition && 'view' in condition && /SIMPLE-ERROR/.test(condition.view.type), JSON.stringify(condition));
      assert.deepEqual(await live.frameLocals(999), []);
      const bogus = await live.inspectLocal(frame.index, 999);
      assert.ok(bogus && 'error' in bogus);
      live.invokeRestart(event.restarts.findIndex((r) => r.name === 'ABORT'));
      const result = await done;
      assert.equal(result?.aborted, true, 'the ABORT restart abandons the evaluation');
    });
  } finally {
    await live.evaluate('(declaim (optimize (debug 1)))', 'CL-USER');
  }
  // Outside a debugger the commands are refused locally and, if they reach the image, answered in kind.
  assert.equal(live.debuggerActive, false);
  assert.equal(live.abortDebugger(), false);
  assert.equal(live.invokeRestart(0), false);
  assert.deepEqual(await live.frameLocals(0), []);
  assert.deepEqual((await live.evaluate('(* 6 7)', 'CL-USER'))?.values, ['42']);
});

test('debugger: interrupt while waiting aborts the evaluation', { skip: !hasSbcl }, async () => {
  const control = new LiveImage();
  await control.connect({ port, tokenPath });
  try {
    const result = await inDebugger('(error "waiting")', async (_event, done) => {
      assert.equal(await control.interrupt(), true);
      return done;
    });
    assert.equal(result?.aborted, true);
    assert.match(result?.error ?? '', /waiting \(aborted\)/);
    assert.deepEqual((await live.evaluate('(+ 2 2)', 'CL-USER'))?.values, ['4']);
  } finally {
    control.disconnect();
  }
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
