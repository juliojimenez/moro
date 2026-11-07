/**
 * Smoke tests of the backend on every implementation moro supports that is
 * found on PATH: SBCL, ECL, Clozure CL and ABCL. Each starts the
 * implementation with the backend and a small source file loaded, then
 * checks the connection, arglists, evaluation, the debugger loop, the
 * inspector and the definition sources of what the file defined.
 */
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DebuggerEvent, LiveImage, lispString, locateLiveDefinition } from '../src/common/live';
import { parse } from '../src/common/reader';

const BACKEND = path.resolve(__dirname, '..', '..', 'lisp', 'moro-backend.lisp');

interface Implementation {
  name: string;
  command: string;
  /** Flags that skip init files and banners; `--load` and `--eval` follow. */
  quiet: string[];
  implementation: RegExp;
  /** How this implementation reports the location of a form. */
  position: 'offset' | 'after';
  /** Whether errors come with the frames of the user's code. */
  frames: boolean;
}

const IMPLEMENTATIONS: Implementation[] = [
  { name: 'sbcl', command: 'sbcl', quiet: ['--noinform', '--non-interactive'], implementation: /SBCL/, position: 'offset', frames: true },
  { name: 'ecl', command: 'ecl', quiet: ['--norc', '-q'], implementation: /ECL/, position: 'after', frames: false },
  { name: 'ccl', command: 'ccl', quiet: ['--no-init', '--batch'], implementation: /Clozure/, position: 'offset', frames: true },
  { name: 'abcl', command: 'abcl', quiet: ['--noinit', '--noinform'], implementation: /Armed Bear/, position: 'after', frames: false },
];

function onPath(command: string): boolean {
  if (process.platform === 'win32') return false;
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      return dir && fs.statSync(path.join(dir, command)).isFile();
    } catch {
      return false;
    }
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

const SOURCE =
  '(in-package :cl-user)\n\n(defun impl-probe-fn (a &key b)\n  "Probe doc."\n  (list a b))\n\n;; a comment before the next form\n(defvar *impl-probe-var* 1)\n\n' +
  '(defun impl-probe-fail (x) (error "fail ~a" x))\n(defun impl-probe-caller (x) (let ((r (impl-probe-fail x))) (list r)))\n';
const FN_START = SOURCE.indexOf('(defun impl-probe-fn');
const VAR_START = SOURCE.indexOf('(defvar *impl-probe-var*');

for (const impl of IMPLEMENTATIONS) {
  describe(`backend on ${impl.name}`, { skip: !onPath(impl.command) }, () => {
    let proc: ChildProcess | undefined;
    let dir: string;
    let port: number;
    let tokenPath: string;
    let sourcePath: string;
    let output = '';
    const live = new LiveImage();

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `moro-${impl.name}-`));
      tokenPath = path.join(dir, 'token');
      sourcePath = path.join(dir, 'probe.lisp');
      fs.writeFileSync(tokenPath, 'test-token-abc', { mode: 0o600 });
      fs.writeFileSync(sourcePath, SOURCE);
      port = await freePort();
      proc = spawn(
        impl.command,
        [
          ...impl.quiet,
          '--load',
          BACKEND,
          '--eval',
          `(moro-backend:start ${port} ${lispString(tokenPath)})`,
          '--eval',
          `(progn (load ${lispString(sourcePath)}) (sleep 300))`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      await live.connect({ port, tokenPath });
    });

    after(() => {
      live.disconnect();
      proc?.kill();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    test('connects and advertises definitions', () => {
      assert.equal(live.connected, true, `connected (implementation output: ${output.slice(-800)})`);
      assert.match(live.status.implementation ?? '', impl.implementation);
      assert.ok(live.status.features.includes('arglists'), live.status.features.join(','));
      assert.ok(live.status.features.includes('definitions'), live.status.features.join(','));
    });

    test('arglists and documentation', async () => {
      assert.equal(await live.arglist('IMPL-PROBE-FN', 'CL-USER'), '(a &key b)');
      const doc = await live.documentation('IMPL-PROBE-FN', 'CL-USER');
      assert.deepEqual(doc?.docs, [{ kind: 'function', text: 'Probe doc.' }]);
    });

    test('evaluation with output and an error with a backtrace', async () => {
      const ok = await live.evaluate('(progn (princ "hi") (impl-probe-fn 1 :b 2))', 'CL-USER');
      assert.deepEqual(ok && { ok: ok.ok, values: ok.values, output: ok.output }, { ok: true, values: ['(1 2)'], output: 'hi' });
      const failed = await live.evaluate('(error "boom")', 'CL-USER');
      assert.equal(failed?.ok, false);
      assert.match(failed?.error ?? '', /boom/);
    });

    test('backtraces: the frames of the loaded code, without the machinery', async () => {
      const failed = await live.evaluate('(impl-probe-caller 7)', 'CL-USER');
      assert.equal(failed?.ok, false);
      assert.match(failed?.error ?? '', /fail 7/);
      const frames = failed?.backtrace ?? [];
      if (impl.frames) {
        assert.ok(frames.some((f) => /IMPL-PROBE-FAIL/.test(f)) && frames.some((f) => /IMPL-PROBE-CALLER/.test(f)), frames.join(' | '));
        assert.ok(!frames.some((f) => /CCL::|BACKTRACE-AS-LIST|MORO-BACKEND|SB-KERNEL|"7"/.test(f)), frames.join(' | '));
      } else {
        assert.deepEqual(frames, []);
      }
    });

    test('debugger: a restart with a value resumes, abort abandons', async () => {
      const events: DebuggerEvent[] = [];
      const done = live.evaluate('(list :before (restart-case (error "stop") (use-value (v) :report "Use a value" (* v 2))) :after)', 'CL-USER', {
        onDebug: (event) => events.push(event),
      });
      const deadline = Date.now() + 15000;
      while (!events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.ok(events.length, `a debugger event (${output.slice(-500)})`);
      const useValue = events[0].restarts.find((r) => r.name === 'USE-VALUE');
      assert.ok(useValue, events[0].restarts.map((r) => r.name).join(','));
      assert.ok(events[0].restarts.some((r) => r.name === 'ABORT'));
      assert.ok(live.invokeRestart(useValue.index, ['21']));
      assert.deepEqual((await done)?.values, ['(:BEFORE 42 :AFTER)']);

      const aborted = live.evaluate('(error "no way out")', 'CL-USER', { onDebug: () => setTimeout(() => live.abortDebugger(), 50) });
      const result = await aborted;
      assert.equal(result?.ok, false);
      assert.equal(result?.aborted, true);
      assert.deepEqual((await live.evaluate('(+ 1 1)', 'CL-USER'))?.values, ['2']);
    });

    test('inspector', async () => {
      const view = await live.inspect('(list 1 2 3)', 'CL-USER');
      assert.ok(view && 'view' in view, JSON.stringify(view));
      assert.deepEqual(view.view.parts.map((p) => p.value), ['1', '2', '3']);
    });

    test('definition sources point at the forms of the loaded file', async () => {
      const result = parse(SOURCE);
      const fn = await live.definitions('IMPL-PROBE-FN', 'CL-USER');
      assert.ok(fn.length >= 1, `definitions of impl-probe-fn: ${JSON.stringify(fn)}`);
      for (const def of fn) {
        assert.equal(fs.realpathSync(def.file), fs.realpathSync(sourcePath));
        assert.ok(def[impl.position] !== undefined, `${impl.position} in ${JSON.stringify(def)}`);
        const target = locateLiveDefinition(result, def, SOURCE.length);
        assert.equal(target?.form.start, FN_START, `located ${JSON.stringify(def)}`);
      }
      assert.ok(fn.some((d) => d.type === 'function'), fn.map((d) => d.type).join(','));

      const variable = await live.definitions('*IMPL-PROBE-VAR*', 'CL-USER');
      assert.ok(variable.length >= 1, `definitions of *impl-probe-var*: ${JSON.stringify(variable)}`);
      assert.equal(locateLiveDefinition(result, variable[0], SOURCE.length)?.form.start, VAR_START, JSON.stringify(variable[0]));
      assert.equal(variable[0].type, 'variable');

      // Defined from the editor: no file to go to.
      await live.evaluate('(defun impl-from-editor (x) x)', 'CL-USER');
      assert.deepEqual(await live.definitions('IMPL-FROM-EDITOR', 'CL-USER'), []);
      assert.deepEqual(await live.definitions('NO-SUCH-THING-HERE', 'CL-USER'), []);
    });
  });
}
