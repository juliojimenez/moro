/**
 * Connection to the moro backend running inside the REPL image
 * (lisp/moro-backend.lisp). Requests are single-line s-expressions; responses
 * are s-expressions framed by parsing the stream with the reader, so strings
 * with newlines (docstrings) are fine. One request is in flight at a time.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { ListNode, Node, ParseResult, isList, isSymbol, parse, stringContent } from './reader';

export interface LiveConnectionInfo {
  port: number;
  tokenPath: string;
}

export interface LiveStatus {
  connected: boolean;
  implementation?: string;
  version?: string;
  features: string[];
}

export interface LiveDocumentation {
  name: string;
  package: string;
  kinds: string[];
  arglist: string | null;
  docs: Array<{ kind: string; text: string }>;
}

export interface LiveCompletion {
  name: string;
  kind: string;
  package: string;
}

export interface LiveDefinition {
  file: string;
  /** Character offset of the form (SBCL, CCL). */
  offset?: number;
  /** A file position at or before the form, where the reader stood when about to read it (ECL, ABCL). */
  after?: number;
  /** Index of the top-level form in the file. */
  form?: number;
  type: string;
}

export interface LiveDefinitionTarget {
  form: Node;
  /** Offset to put the cursor at. */
  selection: number;
}

/**
 * The top-level form of a parsed file that a live definition points at.
 * Implementations report where the reader stood when it was about to read
 * the form: SBCL, ECL and ABCL give the position right after the previous
 * top-level form (ABCL one whitespace character later), CCL the form's own
 * start. So: the form containing the position, else the first form after it.
 * `form` is an index into the file's top-level forms.
 */
export function locateLiveDefinition(result: ParseResult, def: LiveDefinition, textLength: number): LiveDefinitionTarget | null {
  const position = def.offset ?? def.after;
  if (position !== undefined) {
    const at = Math.max(0, Math.min(position, textLength));
    const inside = result.forms.find((f) => f.start <= at && at < f.end);
    if (inside) return { form: inside, selection: at };
    const next = result.forms.find((f) => f.start >= at);
    return next ? { form: next, selection: next.formStart } : null;
  }
  if (def.form !== undefined) {
    const form = result.forms[def.form] ?? null;
    return form ? { form, selection: form.formStart } : null;
  }
  return null;
}

export interface LiveEvaluation {
  ok: boolean;
  /** Printed return values (empty for zero values). */
  values: string[];
  /** Everything the forms printed to the standard streams. */
  output: string;
  /** Error message when `ok` is false. */
  error?: string;
  backtrace: string[];
  package?: string;
  /** True when the evaluation was abandoned from the debugger or by an interrupt while it waited there. */
  aborted?: boolean;
}

export interface InspectorPart {
  index: number;
  label: string;
  value: string;
  /** True when the part has parts of its own (can be drilled into). */
  expandable: boolean;
}

export interface InspectorView {
  title: string;
  type: string;
  depth: number;
  parts: InspectorPart[];
}

export type InspectorResult = { view: InspectorView } | { error: string } | null;

export interface DebuggerRestart {
  index: number;
  name: string;
  description: string;
}

export interface DebuggerFrame {
  index: number;
  text: string;
}

/** What the image reports when an evaluation signals an error and the debugger was requested. */
export interface DebuggerEvent {
  level: number;
  condition: string;
  type: string;
  restarts: DebuggerRestart[];
  frames: DebuggerFrame[];
}

export interface FrameLocal {
  name: string;
  value: string;
}

export interface EvaluateOptions {
  /** Open the debugger on errors instead of abandoning the evaluation; called for each debugger event. */
  onDebug?: (event: DebuggerEvent) => void;
  /** A restart or abort sent to the debugger failed (bad index, argument form that did not evaluate); the debugger is still waiting. */
  onDebugError?: (message: string) => void;
}

interface Pending {
  line: string;
  resolve: (node: Node | null) => void;
  timeoutMs: number;
  timer?: NodeJS.Timeout;
  /** Receives (:debug ...) events while this request is in flight. */
  onEvent?: (event: DebuggerEvent) => void;
  onDebugError?: (message: string) => void;
}

interface DebuggerPending {
  resolve: (node: Node | null) => void;
  timer: NodeJS.Timeout;
}

const CONNECT_ATTEMPTS = 40;
const CONNECT_INTERVAL_MS = 500;
const MAX_QUEUE = 8;

/** A Lisp string literal for `text`. */
export function lispString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unescape(raw: string): string {
  return stringContent(raw).replace(/\\(.)/gs, '$1');
}

/** The string value of a string node, else null. */
export function stringOf(node: Node | undefined): string | null {
  return node && node.kind === 'string' ? unescape(node.text) : null;
}

/** The lower-case name of a keyword or symbol node, else null. */
export function nameOf(node: Node | undefined): string | null {
  return isSymbol(node) ? node.name.toLowerCase() : null;
}

/** `(:ok :a 1 :b 2)` -> Map of keyword name -> value node, starting after `skip` leading elements. */
export function plist(node: Node | undefined, skip = 1): Map<string, Node> {
  const out = new Map<string, Node>();
  if (!isList(node)) return out;
  const items = node.children.slice(skip);
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = nameOf(items[i]);
    if (key) out.set(key, items[i + 1]);
  }
  return out;
}

function isOk(node: Node | null): node is ListNode {
  return !!node && isList(node) && nameOf(node.children[0]) === 'ok';
}

export class LiveImage {
  status: LiveStatus = { connected: false, features: [] };
  onStatus: (status: LiveStatus) => void = () => undefined;
  log: (message: string) => void = () => undefined;

  private socket: net.Socket | null = null;
  private buffer = '';
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  /** Debugger commands answered with :debugger-ok / :debugger-error while an evaluation waits in the debugger. */
  private debuggerPending: DebuggerPending[] = [];
  private debuggerOpen = false;
  private generation = 0;

  /** Connects (retrying while the image starts), authenticates and reads the implementation info. */
  async connect(info: LiveConnectionInfo): Promise<void> {
    this.disconnect();
    const generation = ++this.generation;
    let token: string;
    try {
      token = fs.readFileSync(info.tokenPath, 'utf8').trim();
    } catch (error) {
      this.log(`live image: cannot read token file: ${String(error)}`);
      return;
    }
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS && generation === this.generation; attempt++) {
      const socket = await this.tryConnect(info.port);
      if (!socket) {
        await new Promise((r) => setTimeout(r, CONNECT_INTERVAL_MS));
        continue;
      }
      if (generation !== this.generation) {
        socket.destroy();
        return;
      }
      this.attach(socket);
      socket.write(`${token}\n`);
      const hello = await this.request('(:connect)', 5000);
      if (!isOk(hello)) {
        this.log('live image: handshake failed');
        this.disconnect();
        return;
      }
      const info2 = plist(hello);
      const features = info2.get('features');
      this.setStatus({
        connected: true,
        implementation: stringOf(info2.get('implementation')) ?? undefined,
        version: stringOf(info2.get('version')) ?? undefined,
        features: isList(features) ? features.children.map((f) => nameOf(f) ?? '').filter(Boolean) : [],
      });
      this.log(`live image: connected to ${this.status.implementation ?? '?'} ${this.status.version ?? ''} on port ${info.port}`);
      return;
    }
    this.log(`live image: no backend on port ${info.port}`);
  }

  disconnect(): void {
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    if (socket) socket.destroy();
    this.failAll();
    if (this.status.connected) this.setStatus({ connected: false, features: [] });
  }

  get connected(): boolean {
    return this.socket !== null && this.status.connected;
  }

  /** True from a debugger event until the evaluation it belongs to is answered. */
  get debuggerActive(): boolean {
    return this.debuggerOpen && this.inFlight !== null;
  }

  private setStatus(status: LiveStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private tryConnect(port: number): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setNoDelay(true);
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => resolve(null));
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error) => this.log(`live image: ${error.message}`));
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.failAll();
        if (this.status.connected) {
          this.log('live image: connection closed');
          this.setStatus({ connected: false, features: [] });
        }
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const result = parse(this.buffer);
      const form = result.forms[0];
      if (!form || (isList(form) && !form.closed)) return;
      this.buffer = this.buffer.slice(form.end);
      const head = isList(form) ? nameOf(form.children[0]) : null;
      if (head === 'debug') {
        // An event for the evaluation in flight; the evaluation itself is still pending.
        this.debuggerOpen = true;
        const event = decodeDebuggerEvent(form);
        if (event && this.inFlight?.onEvent) this.inFlight.onEvent(event);
        continue;
      }
      if (head === 'debugger-ok' || head === 'debugger-error') {
        const waiting = this.debuggerPending.shift();
        if (waiting) {
          clearTimeout(waiting.timer);
          waiting.resolve(form);
        } else if (head === 'debugger-error') {
          // The answer to a restart or abort that did not transfer control.
          this.inFlight?.onDebugError?.((isList(form) ? stringOf(form.children[1]) : null) ?? 'debugger error');
        }
        continue;
      }
      const pending = this.inFlight;
      this.inFlight = null;
      this.debuggerOpen = false;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(form);
      }
      this.pump();
    }
  }

  private failAll(): void {
    const all = this.inFlight ? [this.inFlight, ...this.queue] : [...this.queue];
    this.inFlight = null;
    this.debuggerOpen = false;
    this.queue = [];
    for (const pending of all) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(null);
    }
    for (const waiting of this.debuggerPending) {
      clearTimeout(waiting.timer);
      waiting.resolve(null);
    }
    this.debuggerPending = [];
  }

  /** Sends a debugger command and waits for its :debugger-ok / :debugger-error answer. */
  private debuggerRequest(line: string, timeoutMs = 10000): Promise<Node | null> {
    if (!this.socket || !this.debuggerActive) return Promise.resolve(null);
    const socket = this.socket;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.debuggerPending.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.debuggerPending.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.debuggerPending.push({ resolve, timer });
      socket.write(`${line}\n`);
    });
  }

  /** Sends a debugger command that transfers control; the pending evaluation answers later. */
  private debuggerSend(line: string): boolean {
    if (!this.socket || !this.debuggerActive) return false;
    this.socket.write(`${line}\n`);
    return true;
  }

  private pump(): void {
    if (this.inFlight || !this.socket) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    if (next.timeoutMs > 0) {
      next.timer = setTimeout(() => {
        if (this.inFlight === next) {
          this.log(`live image: timeout waiting for ${next.line}`);
          this.inFlight = null;
          next.resolve(null);
          // The backend answers in order; a lost answer would misalign later ones.
          this.disconnect();
        }
      }, next.timeoutMs);
    }
    this.socket.write(`${next.line}\n`);
  }

  /** Sends one request form; resolves with the response form, or null when disconnected or timed out (0 = no timeout). */
  request(line: string, timeoutMs = 1500, events: Pick<Pending, 'onEvent' | 'onDebugError'> = {}): Promise<Node | null> {
    if (!this.socket) return Promise.resolve(null);
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      dropped?.resolve(null);
    }
    return new Promise((resolve) => {
      this.queue.push({ line, resolve, timeoutMs, ...events });
      this.pump();
    });
  }

  private async ask(operation: string, name: string, pkg: string | null, timeoutMs?: number): Promise<ListNode | null> {
    if (!this.connected) return null;
    const response = await this.request(`(${operation} ${lispString(name)} ${pkg ? lispString(pkg) : 'nil'})`, timeoutMs);
    return isOk(response) ? response : null;
  }

  async arglist(name: string, pkg: string | null): Promise<string | null> {
    const response = await this.ask(':arglist', name, pkg);
    return response ? stringOf(response.children[1]) : null;
  }

  async documentation(name: string, pkg: string | null): Promise<LiveDocumentation | null> {
    const response = await this.ask(':documentation', name, pkg);
    if (!response) return null;
    const fields = plist(response);
    const kinds = fields.get('kinds');
    const docs = fields.get('docs');
    return {
      name: stringOf(fields.get('name')) ?? name.toLowerCase(),
      package: stringOf(fields.get('package')) ?? '',
      kinds: isList(kinds) ? kinds.children.map((k) => nameOf(k) ?? '').filter(Boolean) : [],
      arglist: stringOf(fields.get('arglist')),
      docs: isList(docs)
        ? docs.children.flatMap((entry) => {
            if (!isList(entry)) return [];
            const kind = nameOf(entry.children[0]);
            const text = stringOf(entry.children[1]);
            return kind && text ? [{ kind, text }] : [];
          })
        : [],
    };
  }

  async complete(prefix: string, pkg: string | null): Promise<LiveCompletion[]> {
    const response = await this.ask(':complete', prefix, pkg, 800);
    const list = response?.children[1];
    if (!isList(list)) return [];
    return list.children.flatMap((entry) => {
      if (!isList(entry)) return [];
      const name = stringOf(entry.children[0]);
      if (!name) return [];
      return [{ name, kind: nameOf(entry.children[1]) ?? 'symbol', package: stringOf(entry.children[2]) ?? '' }];
    });
  }

  async definitions(name: string, pkg: string | null): Promise<LiveDefinition[]> {
    const response = await this.ask(':definition', name, pkg);
    const list = response?.children[1];
    if (!isList(list)) return [];
    return list.children.flatMap((entry) => {
      const fields = plist(entry, 0);
      const file = stringOf(fields.get('file'));
      if (!file) return [];
      const number = (key: string) => {
        const node = fields.get(key);
        return node && node.kind === 'number' ? Number(node.text) : undefined;
      };
      return [{ file, offset: number('offset'), after: number('after'), form: number('form'), type: nameOf(fields.get('type')) ?? 'function' }];
    });
  }

  async packages(): Promise<string[]> {
    if (!this.connected) return [];
    const response = await this.request('(:packages)');
    const list = isOk(response) ? response.children[1] : undefined;
    return isList(list) ? list.children.map((n) => stringOf(n)).filter((s): s is string => !!s) : [];
  }

  /**
   * Evaluates `text` in `pkg` inside the image; no timeout, use `interrupt` from
   * another connection. With `onDebug`, an error opens the debugger instead of
   * abandoning the evaluation: the callback receives each debugger event and
   * the promise resolves once a restart finished the evaluation or it was aborted.
   */
  async evaluate(text: string, pkg: string | null, options: EvaluateOptions = {}): Promise<LiveEvaluation | null> {
    if (!this.connected) return null;
    const flag = options.onDebug ? ' :debugger t' : '';
    const response = await this.request(`(:eval ${lispString(text)} ${pkg ? lispString(pkg) : 'nil'}${flag})`, 0, {
      onEvent: options.onDebug,
      onDebugError: options.onDebugError,
    });
    return decodeEvaluation(response);
  }

  /** Debugger: invoke restart `index` with the given value forms; the evaluation then goes on or aborts. */
  invokeRestart(index: number, argumentForms: string[] = []): boolean {
    return this.debuggerSend(`(:invoke-restart ${Math.floor(index)}${argumentForms.map((f) => ` ${lispString(f)}`).join('')})`);
  }

  /** Debugger: abandon the evaluation waiting in the debugger. */
  abortDebugger(): boolean {
    return this.debuggerSend('(:abort)');
  }

  /** Debugger: the local variables of frame `index` (SBCL; empty elsewhere). */
  async frameLocals(index: number): Promise<FrameLocal[]> {
    const response = await this.debuggerRequest(`(:frame-locals ${Math.floor(index)})`);
    if (!response || !isList(response) || nameOf(response.children[0]) !== 'debugger-ok') return [];
    const list = response.children[1];
    if (!isList(list)) return [];
    return list.children.flatMap((entry) => {
      if (!isList(entry)) return [];
      const name = stringOf(entry.children[0]);
      const value = stringOf(entry.children[1]);
      return name !== null && value !== null ? [{ name, value }] : [];
    });
  }

  /** Debugger: inspect the condition itself. */
  async inspectCondition(): Promise<InspectorResult> {
    return decodeDebuggerInspector(await this.debuggerRequest('(:inspect-condition)'));
  }

  /** Debugger: inspect local `local` of frame `frame`. */
  async inspectLocal(frame: number, local: number): Promise<InspectorResult> {
    return decodeDebuggerInspector(await this.debuggerRequest(`(:inspect-local ${Math.floor(frame)} ${Math.floor(local)})`));
  }

  /** Interrupts the evaluation running in the image, if any. */
  async interrupt(): Promise<boolean> {
    if (!this.connected) return false;
    const response = await this.request('(:interrupt)', 3000);
    return isOk(response) && nameOf(response.children[1]) === 't';
  }

  async inspect(text: string, pkg: string | null): Promise<InspectorResult> {
    if (!this.connected) return null;
    return decodeInspector(await this.request(`(:inspect ${lispString(text)} ${pkg ? lispString(pkg) : 'nil'})`, 0));
  }

  async inspectPart(index: number): Promise<InspectorResult> {
    if (!this.connected) return null;
    return decodeInspector(await this.request(`(:inspect-part ${Math.floor(index)})`, 5000));
  }

  async inspectPop(): Promise<InspectorResult> {
    if (!this.connected) return null;
    return decodeInspector(await this.request('(:inspect-pop)', 5000));
  }
}

function strings(node: Node | undefined): string[] {
  return isList(node) ? node.children.map((n) => stringOf(n)).filter((s): s is string => s !== null) : [];
}

/** Decodes an :eval response; null when the connection failed. */
export function decodeEvaluation(response: Node | null): LiveEvaluation | null {
  if (!response || !isList(response)) return null;
  const tag = nameOf(response.children[0]);
  if (tag === 'ok') {
    const fields = plist(response);
    return { ok: true, values: strings(fields.get('values')), output: stringOf(fields.get('output')) ?? '', backtrace: [], package: stringOf(fields.get('package')) ?? undefined };
  }
  if (tag === 'error') {
    const fields = plist(response, 2);
    return {
      ok: false,
      values: [],
      output: stringOf(fields.get('output')) ?? '',
      error: stringOf(response.children[1]) ?? 'error',
      backtrace: strings(fields.get('backtrace')),
      aborted: nameOf(fields.get('aborted')) === 't',
    };
  }
  return null;
}

/** Decodes a (:debug ...) event. */
export function decodeDebuggerEvent(form: Node): DebuggerEvent | null {
  if (!isList(form) || nameOf(form.children[0]) !== 'debug') return null;
  const fields = plist(form);
  const level = fields.get('level');
  const restarts = fields.get('restarts');
  const frames = fields.get('frames');
  return {
    level: level && level.kind === 'number' ? Number(level.text) : 1,
    condition: stringOf(fields.get('condition')) ?? '',
    type: stringOf(fields.get('type')) ?? '',
    restarts: isList(restarts)
      ? restarts.children.flatMap((entry) => {
          if (!isList(entry)) return [];
          const [index, name, description] = entry.children;
          return [{ index: index && index.kind === 'number' ? Number(index.text) : 0, name: stringOf(name) ?? '', description: stringOf(description) ?? '' }];
        })
      : [],
    frames: isList(frames)
      ? frames.children.flatMap((entry) => {
          if (!isList(entry)) return [];
          const [index, text] = entry.children;
          return [{ index: index && index.kind === 'number' ? Number(index.text) : 0, text: stringOf(text) ?? '' }];
        })
      : [],
  };
}

/** A (:debugger-ok <inspector view>) or (:debugger-error message) answer. */
function decodeDebuggerInspector(response: Node | null): InspectorResult {
  if (!response || !isList(response)) return null;
  const tag = nameOf(response.children[0]);
  if (tag === 'debugger-error') return { error: stringOf(response.children[1]) ?? 'error' };
  if (tag !== 'debugger-ok') return null;
  return decodeInspector(response.children[1] ?? null);
}

/** Decodes an inspector response (:ok view | :error message | :none). */
export function decodeInspector(response: Node | null): InspectorResult {
  if (!response || !isList(response)) return null;
  const tag = nameOf(response.children[0]);
  if (tag === 'error') return { error: stringOf(response.children[1]) ?? 'error' };
  if (tag !== 'ok') return null;
  const fields = plist(response);
  const parts = fields.get('parts');
  const depth = fields.get('depth');
  return {
    view: {
      title: stringOf(fields.get('title')) ?? '',
      type: stringOf(fields.get('type')) ?? '',
      depth: depth && depth.kind === 'number' ? Number(depth.text) : 1,
      parts: isList(parts)
        ? parts.children.flatMap((entry) => {
            if (!isList(entry)) return [];
            const [index, label, value, expandable] = entry.children;
            return [
              {
                index: index && index.kind === 'number' ? Number(index.text) : 0,
                label: stringOf(label) ?? '',
                value: stringOf(value) ?? '',
                expandable: nameOf(expandable) === 't',
              },
            ];
          })
        : [],
    },
  };
}
