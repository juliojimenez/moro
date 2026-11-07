/**
 * End-to-end: launch the bundled language server over stdio and exercise the
 * main requests the way a client would. Requires `npm run build` first.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
const BACKEND = path.resolve(__dirname, '..', '..', 'lisp', 'moro-backend.lisp');
const hasSbcl = spawnSync('sbcl', ['--version'], { stdio: 'ignore' }).status === 0;

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class LspClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly notifications: Message[] = [];
  private readonly waiters: Array<{ method: string; accept: (m: Message) => boolean; resolve: (m: Message) => void }> = [];

  constructor(private readonly proc: ChildProcess) {
    proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on('data', (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error(`Bad header: ${header}`);
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString();
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(JSON.parse(body) as Message);
    }
  }

  private dispatch(message: Message): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.method ?? 'request'} failed: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      // server -> client request (e.g. client/registerCapability): answer with null
      this.send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    }
    const index = this.waiters.findIndex((w) => w.method === message.method && w.accept(message));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    this.notifications.push(message);
  }

  private send(payload: object): void {
    const body = JSON.stringify(payload);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Timeout waiting for ${method}`));
      }, 10000);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  waitFor(method: string, accept: (m: Message) => boolean = () => true): Promise<Message> {
    const existing = this.notifications.findIndex((n) => n.method === method && accept(n));
    if (existing >= 0) return Promise.resolve(this.notifications.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      this.waiters.push({ method, accept, resolve });
      setTimeout(() => reject(new Error(`Timeout waiting for notification ${method}`)), 10000);
    });
  }
}

const DEMO = `(defpackage #:demo
  (:use #:cl)
  (:export #:greet))

(in-package #:demo)

(defun greet (name &optional (greeting "Hello"))
  "Greet NAME."
  (format t "~a, ~a!~%" greeting name))

(defun main ()
  (greet "world")
  (mapcar #'greet (list "a" "b")))

(defun safe-main ()
  (handler-case (main)
    (error (e) (format t "~a" e))))
`;

let workspace: string;
let proc: ChildProcess;
let client: LspClient;
let demoUri: string;
let tokenTypes: string[] = [];
let tokenModifiers: string[] = [];

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: string[];
}

/** Decodes LSP semantic token data into absolute positions with type and modifier names. */
function decodeTokens(data: number[]): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    const modifiers = tokenModifiers.filter((_, bit) => (data[i + 4] & (1 << bit)) !== 0);
    out.push({ line, character, length: data[i + 2], type: tokenTypes[data[i + 3]], modifiers });
  }
  return out;
}

before(async () => {
  assert.ok(fs.existsSync(SERVER), `bundle missing: ${SERVER}; run npm run build first`);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-e2e-'));
  fs.writeFileSync(path.join(workspace, 'demo.lisp'), DEMO);
  fs.writeFileSync(path.join(workspace, 'other.lisp'), '(in-package #:demo)\n(defun helper () (greet "x"))\n');
  // Another package with its own `greet`: references and rename must keep them apart.
  fs.writeFileSync(path.join(workspace, 'elsewhere.lisp'), '(defpackage #:elsewhere (:use #:cl))\n(in-package #:elsewhere)\n(defun greet () :mine)\n(greet)\n(demo:greet "from elsewhere")\n');
  fs.writeFileSync(path.join(workspace, 'demo.asd'), '(defsystem "demo" :depends-on ("greetlib") :components ((:file "demo")))\n');
  // A dependency in a project-local ocicl registry: indexed as a dependency, not as workspace code.
  fs.writeFileSync(path.join(workspace, 'ocicl.csv'), 'greetlib, ghcr.io/ocicl/greetlib@sha256:0, greetlib-1/greetlib.asd\n');
  fs.mkdirSync(path.join(workspace, 'ocicl', 'greetlib-1'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'ocicl', 'greetlib-1', 'greetlib.asd'), '(defsystem "greetlib" :components ((:file "greetlib")))\n');
  fs.writeFileSync(
    path.join(workspace, 'ocicl', 'greetlib-1', 'greetlib.lisp'),
    '(defpackage #:greetlib (:use #:cl) (:export #:shout))\n(in-package #:greetlib)\n(defun shout (text &optional (bang "!"))\n  "Upcase TEXT and add BANG."\n  (concatenate \'string (string-upcase text) bang))\n(defun helper-not-exported () nil)\n',
  );
  demoUri = pathToFileURL(path.join(workspace, 'demo.lisp')).toString();
  proc = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  client = new LspClient(proc);
  const init = await client.request<{ capabilities: Record<string, unknown> }>('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(workspace).toString(),
    workspaceFolders: [{ uri: pathToFileURL(workspace).toString(), name: 'e2e' }],
    capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } }, workspace: { configuration: false } },
  });
  assert.ok(init.capabilities.hoverProvider);
  assert.ok(init.capabilities.semanticTokensProvider);
  const legend = (init.capabilities.semanticTokensProvider as { legend: { tokenTypes: string[]; tokenModifiers: string[] } }).legend;
  tokenTypes = legend.tokenTypes;
  tokenModifiers = legend.tokenModifiers;
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri: demoUri, languageId: 'commonlisp', version: 1, text: DEMO } });
  await new Promise((r) => setTimeout(r, 800)); // let the workspace and dependency scans finish
});

after(async () => {
  try {
    await client.request('shutdown', null);
    client.notify('exit', null);
  } finally {
    proc.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function position(needle: string, extra = 0) {
  const offset = DEMO.indexOf(needle) + extra;
  const before = DEMO.slice(0, offset);
  const line = before.split('\n').length - 1;
  const character = offset - before.lastIndexOf('\n') - 1;
  return { line, character };
}

test('document symbols', async () => {
  const symbols = await client.request<Array<{ name: string; kind: number; detail?: string }>>('textDocument/documentSymbol', { textDocument: { uri: demoUri } });
  assert.deepEqual(symbols.map((s) => s.name), ['demo', 'greet', 'main', 'safe-main']);
  assert.equal(symbols[1].detail, '(name &optional (greeting "Hello"))');
});

test('hover on a standard symbol and on a workspace definition', async () => {
  const std = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: demoUri }, position: position('mapcar', 2) });
  assert.match(std.contents.value, /\(mapcar function list &rest more-lists\)/);
  assert.match(std.contents.value, /HyperSpec\/Body\/f_mapc_\.htm/);
  const ws = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: demoUri }, position: position('(greet "world")', 3) });
  assert.match(ws.contents.value, /\(greet name &optional \(greeting "Hello"\)\)/);
  assert.match(ws.contents.value, /Greet NAME\./);
  assert.match(ws.contents.value, /demo\.lisp:7/);
});

test('go to definition and references across files', async () => {
  const links = await client.request<Array<{ targetUri: string; targetSelectionRange: { start: { line: number } } }>>('textDocument/definition', {
    textDocument: { uri: demoUri },
    position: position('(greet "world")', 3),
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].targetUri, demoUri);
  assert.equal(links[0].targetSelectionRange.start.line, 6);
  const refs = await client.request<Array<{ uri: string; range: { start: { line: number } } }>>('textDocument/references', {
    textDocument: { uri: demoUri },
    position: position('(greet "world")', 3),
    context: { includeDeclaration: true },
  });
  assert.equal(refs.length, 6, 'export, defun, two calls in demo.lisp, one in other.lisp, demo:greet in elsewhere.lisp');
  assert.ok(refs.some((r) => r.uri.endsWith('other.lisp')));
  assert.ok(!refs.some((r) => r.uri.endsWith('elsewhere.lisp') && r.range.start.line === 2), 'elsewhere::greet is a different symbol');
});

test('completion offers locals, workspace definitions and standard symbols', async () => {
  const list = await client.request<{ items: Array<{ label: string; detail?: string }> }>('textDocument/completion', {
    textDocument: { uri: demoUri },
    position: position('(format t', 1),
  });
  const labels = new Set(list.items.map((i) => i.label));
  assert.ok(labels.has('greeting'), 'local parameter');
  assert.ok(labels.has('name'));
  assert.ok(labels.has('main'), 'workspace function');
  assert.ok(labels.has('helper'), 'function from another file');
  assert.ok(labels.has('mapcar'), 'standard function');
  const resolved = await client.request<{ documentation?: { value: string } }>('completionItem/resolve', list.items.find((i) => i.label === 'mapcar'));
  assert.match(resolved.documentation?.value ?? '', /successive tuples/);
});

test('signature help', async () => {
  const help = await client.request<{ signatures: Array<{ label: string; activeParameter?: number }>; activeParameter: number }>('textDocument/signatureHelp', {
    textDocument: { uri: demoUri },
    position: position('(greet "world")', 7),
  });
  assert.equal(help.signatures[0].label, '(greet name &optional (greeting "Hello"))');
  assert.equal(help.activeParameter, 0);
  const std = await client.request<{ signatures: Array<{ label: string }> }>('textDocument/signatureHelp', {
    textDocument: { uri: demoUri },
    position: position('(list "a" "b")', 11),
  });
  assert.equal(std.signatures[0].label, '(list &rest args)');
});

test('rename across files', async () => {
  const edit = await client.request<{ changes: Record<string, Array<{ newText: string }>> }>('textDocument/rename', {
    textDocument: { uri: demoUri },
    position: position('(greet "world")', 3),
    newName: 'salute',
  });
  const uris = Object.keys(edit.changes);
  assert.equal(uris.length, 3, 'demo.lisp, other.lisp and the demo:greet call in elsewhere.lisp');
  assert.equal(edit.changes[demoUri].length, 4);
  assert.ok(edit.changes[demoUri].every((e) => e.newText === 'salute'));
  const elsewhere = Object.entries(edit.changes).find(([uri]) => uri.endsWith('elsewhere.lisp'))!;
  assert.equal(elsewhere[1].length, 1, 'only demo:greet, not elsewhere\'s own greet');
});

test('folding, selection ranges and semantic tokens', async () => {
  const folds = await client.request<Array<{ startLine: number; endLine: number }>>('textDocument/foldingRange', { textDocument: { uri: demoUri } });
  assert.ok(folds.some((f) => f.startLine === 6 && f.endLine === 8), 'defun greet folds');
  const selection = await client.request<Array<{ range: { start: { character: number } }; parent?: unknown }>>('textDocument/selectionRange', {
    textDocument: { uri: demoUri },
    positions: [position('greeting name', 2)],
  });
  assert.ok(selection[0].parent, 'selection expands outwards');
  const tokens = await client.request<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri: demoUri } });
  const decoded = decodeTokens(tokens.data);
  assert.ok(decoded.length >= 5, 'parameters, their uses and the greet calls are tokens');
  const errorClause = position('(error (e)', 1);
  const typeToken = decoded.find((t) => t.line === errorClause.line && t.character === errorClause.character);
  assert.equal(typeToken?.type, 'type', 'the handler-case clause head is a type, not a function call');
  assert.equal(typeToken?.length, 'error'.length);
  const greetCall = position('(greet "world")', 1);
  assert.equal(decoded.find((t) => t.line === greetCall.line && t.character === greetCall.character)?.type, 'function');
  const at = (needle: string, extra: number) => {
    const p = position(needle, extra);
    return decoded.find((t) => t.line === p.line && t.character === p.character);
  };
  const greetDef = at('(defun greet', 7);
  assert.equal(greetDef?.type, 'function');
  assert.deepEqual(greetDef?.modifiers, ['definition'], 'definition names carry the definition modifier');
  assert.equal(greetDef?.length, 'greet'.length);
  const pkgDef = at('(defpackage #:demo', 14);
  assert.equal(pkgDef?.type, 'namespace');
  assert.equal(pkgDef?.length, 'demo'.length, 'the #: prefix is not part of the name token');
});

test('dependency systems: hover, definition and completion, but no rename', async () => {
  const uri = pathToFileURL(path.join(workspace, 'uses.lisp')).toString();
  const text = '(in-package #:demo)\n(defun loud () (greetlib:shout "hi"))\n';
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'commonlisp', version: 1, text } });
  const shout = { line: 1, character: 27 };
  const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri }, position: shout });
  assert.match(hover.contents.value, /\(shout text &optional \(bang "!"\)\)/);
  assert.match(hover.contents.value, /Upcase TEXT and add BANG\./);
  assert.match(hover.contents.value, /greetlib\.lisp:3 \(dependency\)/);
  const links = await client.request<Array<{ targetUri: string }>>('textDocument/definition', { textDocument: { uri }, position: shout });
  assert.equal(links.length, 1);
  assert.ok(links[0].targetUri.endsWith('/ocicl/greetlib-1/greetlib.lisp'));
  const completion = await client.request<{ items: Array<{ label: string; sortText?: string }> }>('textDocument/completion', {
    textDocument: { uri },
    position: { line: 1, character: 15 },
  });
  const labels = new Set(completion.items.map((i) => i.label));
  assert.ok(labels.has('shout'), 'exported dependency symbol is offered');
  assert.ok(!labels.has('helper-not-exported'), 'internal dependency symbol is not offered');
  assert.ok(completion.items.find((i) => i.label === 'shout')!.sortText!.startsWith('3'), 'dependencies sort after workspace and standard symbols');
  const edit = await client.request<{ changes: Record<string, unknown[]> }>('textDocument/rename', { textDocument: { uri }, position: shout, newName: 'yell' });
  const changed = Object.keys(edit.changes);
  assert.deepEqual(changed, [uri], 'rename edits the workspace file only, never the library');
});

test('live image: hover, completion and signature help for what the REPL has loaded', { skip: !hasSbcl }, async () => {
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
  const tokenPath = path.join(workspace, 'token');
  fs.writeFileSync(tokenPath, 'e2e-token', { mode: 0o600 });
  const lisp = spawn(
    'sbcl',
    ['--noinform', '--non-interactive', '--load', BACKEND, '--eval', `(moro-backend:start ${port} "${tokenPath.split(path.sep).join('/')}")`, '--eval', '(progn (defun cl-user::only-in-image (x &optional y) "Only the image knows." (list x y)) (sleep 120))'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const status = client.waitFor('moro/liveStatus', (m) => (m.params as { connected: boolean }).connected);
    client.notify('moro/liveImage', { port, tokenPath });
    const connected = (await status).params as { implementation: string };
    assert.equal(connected.implementation, 'SBCL');

    const uri = pathToFileURL(path.join(workspace, 'live.lisp')).toString();
    const text = '(in-package #:cl-user)\n(only-in-image 1 2)\n(sb-ext:posix-getenv "HOME")\n';
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'commonlisp', version: 1, text } });
    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri }, position: { line: 1, character: 5 } });
    assert.match(hover.contents.value, /\(only-in-image x &optional y\)/);
    assert.match(hover.contents.value, /Only the image knows\./);
    assert.match(hover.contents.value, /live image/);
    const getenv = await client.request<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 10 } });
    assert.match(getenv.contents.value, /posix-getenv/);
    const help = await client.request<{ signatures: Array<{ label: string }> }>('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 1, character: 15 } });
    assert.equal(help.signatures[0].label, '(only-in-image x &optional y)');
    const completion = await client.request<{ items: Array<{ label: string; detail?: string }> }>('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 8 },
    });
    const item = completion.items.find((i) => i.label === 'only-in-image');
    assert.ok(item, 'the image-only function is offered');
    assert.match(item!.detail ?? '', /live/);
    const resolved = await client.request<{ documentation?: { value: string } }>('completionItem/resolve', item);
    assert.match(resolved.documentation?.value ?? '', /Only the image knows/);
    const definition = await client.request<Array<{ targetUri: string }>>('textDocument/definition', { textDocument: { uri }, position: { line: 2, character: 10 } });
    assert.ok(Array.isArray(definition), 'definition answers (SBCL source may or may not be installed)');

    const disconnected = client.waitFor('moro/liveStatus', (m) => !(m.params as { connected: boolean }).connected);
    client.notify('moro/liveImage', null);
    await disconnected;
  } finally {
    lisp.kill();
  }
});

test('diagnostics for broken structure and formatting', async () => {
  const brokenUri = pathToFileURL(path.join(workspace, 'broken.lisp')).toString();
  client.notify('textDocument/didOpen', { textDocument: { uri: brokenUri, languageId: 'commonlisp', version: 1, text: '(defun broken (x)\n  (list x))\n)\n"open' } });
  const published = await client.waitFor('textDocument/publishDiagnostics', (m) => (m.params as { uri: string }).uri === brokenUri);
  const params = published.params as { uri: string; diagnostics: Array<{ message: string }> };
  assert.equal(params.uri, brokenUri);
  assert.ok(params.diagnostics.some((d) => /Unmatched/.test(d.message)));
  assert.ok(params.diagnostics.some((d) => /Unterminated string/.test(d.message)));

  const uglyUri = pathToFileURL(path.join(workspace, 'ugly.lisp')).toString();
  client.notify('textDocument/didOpen', { textDocument: { uri: uglyUri, languageId: 'commonlisp', version: 1, text: '(defun f (x)\n(let ((y 1))\n(list x y)))\n' } });
  const edits = await client.request<Array<{ range: { start: { line: number } }; newText: string }>>('textDocument/formatting', {
    textDocument: { uri: uglyUri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map((e) => [e.range.start.line, e.newText]), [[1, '  '], [2, '    ']]);
});

test('moro.systems: an .asd outside the workspace is indexed like a dependency (settings via initializationOptions)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-e2e-systems-'));
  const lib = path.join(dir, 'lib');
  const songs = path.join(dir, 'songs');
  fs.mkdirSync(lib);
  fs.mkdirSync(songs);
  fs.writeFileSync(path.join(lib, 'lib.asd'), '(defsystem "lib" :components ((:file "lib")))\n');
  fs.writeFileSync(path.join(lib, 'lib.lisp'), '(defpackage #:lib (:use #:cl) (:export #:play))\n(in-package #:lib)\n(defun play (x)\n  "Play X."\n  x)\n');
  const songPath = path.join(songs, 'song.lisp');
  const song = '(in-package #:cl-user)\n(lib:play 1)\n';
  fs.writeFileSync(songPath, song);
  const proc2 = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client2 = new LspClient(proc2);
  try {
    await client2.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(songs).toString(),
      workspaceFolders: [{ uri: pathToFileURL(songs).toString(), name: 'songs' }],
      initializationOptions: { settings: { systems: ['../lib/lib.asd'] } },
      capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } }, workspace: { configuration: false } },
    });
    client2.notify('initialized', {});
    const uri = pathToFileURL(songPath).toString();
    client2.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'commonlisp', version: 1, text: song } });
    const position = { line: 1, character: 6 };
    let hover: { contents: { value: string } } | null = null;
    for (let i = 0; i < 40 && !hover?.contents.value.includes('Play X.'); i++) {
      await new Promise((r) => setTimeout(r, 200));
      hover = await client2.request<{ contents: { value: string } } | null>('textDocument/hover', { textDocument: { uri }, position });
    }
    assert.match(hover?.contents.value ?? '(no hover)', /\(play x\)/);
    assert.match(hover?.contents.value ?? '', /Play X\./);
    assert.match(hover?.contents.value ?? '', /lib\.lisp:3 \(dependency\)/);
    const links = await client2.request<Array<{ targetUri: string }>>('textDocument/definition', { textDocument: { uri }, position });
    assert.equal(links.length, 1);
    assert.ok(links[0].targetUri.endsWith('/lib/lib.lisp'), links[0].targetUri);
  } finally {
    try {
      await client2.request('shutdown', null);
      client2.notify('exit', null);
    } finally {
      proc2.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
