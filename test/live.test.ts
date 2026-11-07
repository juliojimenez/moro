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
import { LiveImage, lispString, nameOf, plist, stringOf } from '../src/server/live';
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
