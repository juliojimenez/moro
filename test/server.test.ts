/**
 * End-to-end: launch the bundled language server over stdio and exercise the
 * main requests the way a client would. Requires `npm run build` first.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

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

/** Decodes LSP semantic token data into absolute (line, character, length, type). */
function decodeTokens(data: number[]): Array<{ line: number; character: number; length: number; type: string }> {
  const out: Array<{ line: number; character: number; length: number; type: string }> = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    out.push({ line, character, length: data[i + 2], type: tokenTypes[data[i + 3]] });
  }
  return out;
}

before(async () => {
  assert.ok(fs.existsSync(SERVER), `bundle missing: ${SERVER}; run npm run build first`);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-e2e-'));
  fs.writeFileSync(path.join(workspace, 'demo.lisp'), DEMO);
  fs.writeFileSync(path.join(workspace, 'other.lisp'), '(in-package #:demo)\n(defun helper () (greet "x"))\n');
  fs.writeFileSync(path.join(workspace, 'demo.asd'), '(defsystem "demo" :components ((:file "demo")))\n');
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
  tokenTypes = (init.capabilities.semanticTokensProvider as { legend: { tokenTypes: string[] } }).legend.tokenTypes;
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri: demoUri, languageId: 'commonlisp', version: 1, text: DEMO } });
  await new Promise((r) => setTimeout(r, 400)); // let the workspace scan finish
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
  const refs = await client.request<Array<{ uri: string }>>('textDocument/references', {
    textDocument: { uri: demoUri },
    position: position('(greet "world")', 3),
    context: { includeDeclaration: true },
  });
  assert.equal(refs.length, 5, 'export, defun, two calls in demo.lisp, one in other.lisp');
  assert.ok(refs.some((r) => r.uri.endsWith('other.lisp')));
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
  assert.equal(uris.length, 2);
  assert.equal(edit.changes[demoUri].length, 4);
  assert.ok(edit.changes[demoUri].every((e) => e.newText === 'salute'));
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
