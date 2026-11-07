/**
 * Error-tolerant reader for Common Lisp source text.
 *
 * Produces a tree of lists and atoms with exact source offsets, plus the
 * comments and the structural errors found on the way. Unlike a real Lisp
 * reader it never evaluates anything, never needs packages or readtables, and
 * never gives up: unbalanced input produces a tree with `closed: false` lists
 * and an entry in `errors`.
 *
 * Standard syntax handled: lists, strings, `;` and `#| |#` comments (nested),
 * `'` `` ` `` `,` `,@` `,.` prefixes, `#'` `#.` `#n=` `#n#` `#c` `#s` `#p` `#na`,
 * `#(` vectors, `#*` bit vectors, `#\` characters (including `#\(` and `#\;`),
 * `#:` uninterned symbols, `#+` / `#-` feature expressions, `#x #o #b #nr`
 * numbers, `|...|` and `\` escapes in symbols, and `#!` shebang lines.
 */

export type Node = ListNode | AtomNode;

export interface NodeBase {
  /** Offset where the node begins, including any quote or reader-macro prefix. */
  start: number;
  /** Offset just past the node. */
  end: number;
  /** Offset where the datum itself begins, after the prefix. */
  formStart: number;
  /** Raw prefix text: '', "'", "`", ",", ",@", "#'", "#+sbcl ", "#.", "#2A" ... */
  prefix: string;
  parent: ListNode | null;
}

export interface ListNode extends NodeBase {
  kind: 'list';
  /** Opening delimiter text: "(" or "#(" (with optional digits, "#3("). */
  open: string;
  closed: boolean;
  children: Node[];
}

export type AtomKind = 'symbol' | 'keyword' | 'string' | 'number' | 'char' | 'reader' | 'error';

export interface AtomNode extends NodeBase {
  kind: AtomKind;
  /** Raw token text without the prefix. */
  text: string;
  /** Normalized symbol name (upper-cased, escapes resolved) without the package part. */
  name: string;
  /** Normalized package prefix, "KEYWORD" for keywords, null when unqualified. */
  pkg: string | null;
  /** Offset where the name part begins (after any package prefix). */
  nameStart: number;
  /** True for `#:name` symbols. */
  uninterned?: boolean;
}

export interface Comment {
  kind: 'line' | 'block';
  start: number;
  end: number;
}

export interface ReaderError {
  start: number;
  end: number;
  message: string;
}

export interface Position {
  line: number;
  character: number;
}

export interface ParseResult {
  text: string;
  forms: Node[];
  comments: Comment[];
  errors: ReaderError[];
  lineStarts: number[];
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const TERMINATING = new Set(['"', "'", '(', ')', ',', ';', '`']);

const INTEGER_RE = /^[+-]?[0-9]+\.?$/;
const RATIO_RE = /^[+-]?[0-9]+\/[0-9]+$/;
const FLOAT_RE = /^[+-]?(?:[0-9]*\.[0-9]+(?:[eEsSfFdDlL][+-]?[0-9]+)?|[0-9]+(?:\.[0-9]*)?[eEsSfFdDlL][+-]?[0-9]+)$/;

export const LAMBDA_LIST_KEYWORDS = new Set([
  '&OPTIONAL', '&REST', '&BODY', '&KEY', '&ALLOW-OTHER-KEYS', '&AUX', '&WHOLE', '&ENVIRONMENT',
]);

export function isWhitespace(ch: string): boolean {
  return WHITESPACE.has(ch);
}

export function isTerminating(ch: string): boolean {
  return TERMINATING.has(ch);
}

export function isConstituent(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && !WHITESPACE.has(ch) && !TERMINATING.has(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

export function isNumberToken(raw: string): boolean {
  return INTEGER_RE.test(raw) || RATIO_RE.test(raw) || FLOAT_RE.test(raw);
}

/** Upper-cases a symbol token while honouring `\x` and `|...|` escapes. */
export function normalizeSymbolName(raw: string): string {
  if (!raw.includes('\\') && !raw.includes('|')) return raw.toUpperCase();
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') {
      out += raw[i + 1] ?? '';
      i += 2;
    } else if (ch === '|') {
      i++;
      while (i < raw.length && raw[i] !== '|') {
        if (raw[i] === '\\') i++;
        out += raw[i] ?? '';
        i++;
      }
      i++;
    } else {
      out += ch.toUpperCase();
      i++;
    }
  }
  return out;
}

/** Splits `pkg:name` / `pkg::name` / `:keyword` tokens into their parts. */
export function splitSymbolToken(raw: string): { pkg: string | null; name: string; nameOffset: number } {
  if (raw.startsWith(':')) {
    return { pkg: 'KEYWORD', name: normalizeSymbolName(raw.slice(1)), nameOffset: 1 };
  }
  // Find the first package marker outside of escapes.
  let i = 0;
  let colon = -1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '|') {
      i++;
      while (i < raw.length && raw[i] !== '|') i += raw[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === ':') {
      colon = i;
      break;
    } else {
      i++;
    }
  }
  if (colon < 0) return { pkg: null, name: normalizeSymbolName(raw), nameOffset: 0 };
  let j = colon + 1;
  if (raw[j] === ':') j++;
  return { pkg: normalizeSymbolName(raw.slice(0, colon)), name: normalizeSymbolName(raw.slice(j)), nameOffset: j };
}

class Reader {
  private pos = 0;
  readonly forms: Node[] = [];
  readonly comments: Comment[] = [];
  readonly errors: ReaderError[] = [];

  constructor(private readonly text: string) {}

  run(): void {
    const text = this.text;
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.pos >= text.length) break;
      if (text[this.pos] === ')') {
        this.errors.push({ start: this.pos, end: this.pos + 1, message: 'Unmatched closing parenthesis.' });
        this.pos++;
        continue;
      }
      const before = this.pos;
      const form = this.readForm(null);
      if (form) {
        this.forms.push(form);
      }
      if (this.pos === before) this.pos++; // never loop without progress
    }
  }

  private error(start: number, end: number, message: string): void {
    this.errors.push({ start, end, message });
  }

  private skipWhitespaceAndComments(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const ch = text[this.pos];
      if (WHITESPACE.has(ch)) {
        this.pos++;
      } else if (ch === ';') {
        this.readLineComment();
      } else if (ch === '#' && text[this.pos + 1] === '|') {
        this.readBlockComment();
      } else if (ch === '#' && text[this.pos + 1] === '!') {
        this.readLineComment();
      } else {
        break;
      }
    }
  }

  private readLineComment(): void {
    const start = this.pos;
    let end = this.text.indexOf('\n', start);
    if (end < 0) end = this.text.length;
    this.comments.push({ kind: 'line', start, end });
    this.pos = end;
  }

  private readBlockComment(): void {
    const text = this.text;
    const start = this.pos;
    let depth = 0;
    let i = this.pos;
    while (i < text.length) {
      if (text[i] === '#' && text[i + 1] === '|') {
        depth++;
        i += 2;
      } else if (text[i] === '|' && text[i + 1] === '#') {
        depth--;
        i += 2;
        if (depth === 0) break;
      } else {
        i++;
      }
    }
    if (depth > 0) {
      this.error(start, Math.min(start + 2, text.length), 'Unterminated block comment; expected "|#".');
      i = text.length;
    }
    this.comments.push({ kind: 'block', start, end: i });
    this.pos = i;
  }

  private atom(kind: AtomKind, start: number, end: number, formStart: number, prefix: string, parent: ListNode | null, text: string): AtomNode {
    this.pos = end;
    return { kind, start, end, formStart, prefix, parent, text, name: '', pkg: null, nameStart: formStart };
  }

  /** Reads one form at the current position. Returns null at ")" or end of input. */
  private readForm(parent: ListNode | null): Node | null {
    const text = this.text;
    const start = this.pos;
    // Collect prefixes: quotes, unquotes and the reader macros that apply to the next form.
    for (;;) {
      const ch = text[this.pos];
      if (ch === "'" || ch === '`') {
        this.pos++;
      } else if (ch === ',') {
        this.pos++;
        if (text[this.pos] === '@' || text[this.pos] === '.') this.pos++;
      } else if (ch === '#') {
        let j = this.pos + 1;
        while (isDigit(text[j])) j++;
        const sub = text[j];
        if (sub === "'" || sub === '.' || sub === '=' || sub === 'c' || sub === 'C' || sub === 's' || sub === 'S'
          || sub === 'a' || sub === 'A' || sub === 'p' || sub === 'P') {
          this.pos = j + 1;
        } else if (sub === '+' || sub === '-') {
          this.pos = j + 1;
          this.skipWhitespaceAndComments();
          if (this.pos < text.length && text[this.pos] !== ')') {
            this.readForm(null); // the feature expression, discarded
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }
    if (this.pos > start) this.skipWhitespaceAndComments();
    const prefix = text.slice(start, this.pos);
    const formStart = this.pos;
    if (formStart >= text.length || text[formStart] === ')') {
      if (prefix.length > 0) {
        this.error(start, formStart, 'Expected a form after this prefix.');
        return this.atom('error', start, formStart, formStart, prefix, parent, '');
      }
      return null;
    }
    const ch = text[formStart];
    if (ch === '(') return this.readList(start, prefix, formStart, 1, parent);
    if (ch === '"') return this.readString(start, prefix, formStart, parent);
    if (ch === '#') return this.readDispatch(start, prefix, formStart, parent);
    return this.readTokenAtom(start, prefix, formStart, parent);
  }

  private readList(start: number, prefix: string, formStart: number, openLength: number, parent: ListNode | null): ListNode {
    const text = this.text;
    const list: ListNode = {
      kind: 'list',
      start,
      end: formStart + openLength,
      formStart,
      prefix,
      parent,
      open: text.slice(formStart, formStart + openLength),
      closed: false,
      children: [],
    };
    this.pos = formStart + openLength;
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.pos >= text.length) {
        this.error(formStart, formStart + openLength, 'Unclosed list; expected ")".');
        list.end = text.length;
        break;
      }
      if (text[this.pos] === ')') {
        this.pos++;
        list.closed = true;
        list.end = this.pos;
        break;
      }
      const before = this.pos;
      const child = this.readForm(list);
      if (child) list.children.push(child);
      if (this.pos === before) this.pos++;
    }
    return list;
  }

  private readString(start: number, prefix: string, formStart: number, parent: ListNode | null): AtomNode {
    const text = this.text;
    let i = formStart + 1;
    let closed = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
      } else if (ch === '"') {
        i++;
        closed = true;
        break;
      } else {
        i++;
      }
    }
    if (i > text.length) i = text.length;
    if (!closed) this.error(formStart, formStart + 1, 'Unterminated string.');
    return this.atom('string', start, i, formStart, prefix, parent, text.slice(formStart, i));
  }

  /** Scans a token starting at `from`; returns where it ends and whether it used escapes. */
  private scanToken(from: number): { end: number; escaped: boolean } {
    const text = this.text;
    let i = from;
    let escaped = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        escaped = true;
        i += 2;
      } else if (ch === '|') {
        escaped = true;
        i++;
        while (i < text.length && text[i] !== '|') i += text[i] === '\\' ? 2 : 1;
        if (i < text.length) {
          i++;
        } else {
          this.error(from, Math.min(i, text.length), 'Unterminated |...| in symbol.');
        }
      } else if (WHITESPACE.has(ch) || TERMINATING.has(ch)) {
        break;
      } else {
        i++;
      }
    }
    return { end: Math.min(i, text.length), escaped };
  }

  private readTokenAtom(start: number, prefix: string, formStart: number, parent: ListNode | null): AtomNode {
    const text = this.text;
    const { end, escaped } = this.scanToken(formStart);
    if (end === formStart) {
      // A terminating character we have no rule for; swallow it as an error.
      this.error(formStart, formStart + 1, `Unexpected character "${text[formStart]}".`);
      return this.atom('error', start, formStart + 1, formStart, prefix, parent, text[formStart]);
    }
    const raw = text.slice(formStart, end);
    if (!escaped && isNumberToken(raw)) {
      return this.atom('number', start, end, formStart, prefix, parent, raw);
    }
    const atom = this.atom(raw.startsWith(':') ? 'keyword' : 'symbol', start, end, formStart, prefix, parent, raw);
    const parts = splitSymbolToken(raw);
    atom.pkg = parts.pkg;
    atom.name = parts.name;
    atom.nameStart = formStart + parts.nameOffset;
    return atom;
  }

  private readDispatch(start: number, prefix: string, formStart: number, parent: ListNode | null): Node {
    const text = this.text;
    let j = formStart + 1;
    while (isDigit(text[j])) j++;
    const sub = text[j];
    if (sub === undefined) {
      this.error(formStart, j, 'Incomplete # syntax at end of input.');
      return this.atom('error', start, j, formStart, prefix, parent, text.slice(formStart, j));
    }
    switch (sub.toLowerCase()) {
      case '(':
        return this.readList(start, prefix, formStart, j + 1 - formStart, parent);
      case '\\': {
        let k = j + 1;
        if (k < text.length) {
          k++; // the character itself, whatever it is
          while (k < text.length && isConstituent(text[k])) k++;
        } else {
          this.error(formStart, k, 'Incomplete character syntax at end of input.');
        }
        return this.atom('char', start, k, formStart, prefix, parent, text.slice(formStart, k));
      }
      case ':': {
        const { end } = this.scanToken(j + 1);
        const atom = this.atom('symbol', start, end, formStart, prefix, parent, text.slice(formStart, end));
        atom.name = normalizeSymbolName(text.slice(j + 1, end));
        atom.pkg = null;
        atom.nameStart = j + 1;
        atom.uninterned = true;
        return atom;
      }
      case 'x':
      case 'o':
      case 'b':
      case 'r': {
        const { end } = this.scanToken(j + 1);
        return this.atom('number', start, end, formStart, prefix, parent, text.slice(formStart, end));
      }
      case '*': {
        const { end } = this.scanToken(j + 1);
        return this.atom('reader', start, end, formStart, prefix, parent, text.slice(formStart, end));
      }
      case '#':
        return this.atom('reader', start, j + 1, formStart, prefix, parent, text.slice(formStart, j + 1));
      case '<': {
        let k = j + 1;
        while (k < text.length && text[k] !== '>' && text[k] !== '\n') k++;
        if (text[k] === '>') k++;
        this.error(formStart, k, 'Unreadable object syntax "#<...>".');
        return this.atom('error', start, k, formStart, prefix, parent, text.slice(formStart, k));
      }
      default: {
        const { end } = this.scanToken(j + 1);
        const stop = Math.max(end, j + 1);
        this.error(formStart, stop, `Unknown reader macro "#${sub}".`);
        return this.atom('reader', start, stop, formStart, prefix, parent, text.slice(formStart, stop));
      }
    }
  }
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function parse(text: string): ParseResult {
  const reader = new Reader(text);
  reader.run();
  return {
    text,
    forms: reader.forms,
    comments: reader.comments,
    errors: reader.errors,
    lineStarts: computeLineStarts(text),
  };
}

// ---------------------------------------------------------------------------
// Positions

export function lineOf(result: ParseResult, offset: number): number {
  const starts = result.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function columnOf(result: ParseResult, offset: number): number {
  return offset - result.lineStarts[lineOf(result, offset)];
}

export function positionAt(result: ParseResult, offset: number): Position {
  const line = lineOf(result, offset);
  return { line, character: offset - result.lineStarts[line] };
}

export function offsetAt(result: ParseResult, position: Position): number {
  const starts = result.lineStarts;
  if (position.line >= starts.length) return result.text.length;
  const lineStart = starts[Math.max(0, position.line)];
  const nextStart = position.line + 1 < starts.length ? starts[position.line + 1] : result.text.length + 1;
  return Math.min(lineStart + Math.max(0, position.character), nextStart - 1, result.text.length);
}

// ---------------------------------------------------------------------------
// Navigation

export function textOf(result: ParseResult, node: Node): string {
  return result.text.slice(node.start, node.end);
}

export function isSymbol(node: Node | null | undefined): node is AtomNode {
  return !!node && (node.kind === 'symbol' || node.kind === 'keyword');
}

export function isList(node: Node | null | undefined): node is ListNode {
  return !!node && node.kind === 'list';
}

/** True when `offset` is between the delimiters of `list`. */
export function isInsideList(list: ListNode, offset: number): boolean {
  return offset >= list.formStart + list.open.length && (!list.closed || offset < list.end);
}

/** The last of `nodes` that starts at or before `offset`, if `offset` is not past its end. */
function pickContaining(nodes: Node[], offset: number): Node | null {
  let lo = 0;
  let hi = nodes.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  const node = nodes[idx];
  return offset <= node.end ? node : null;
}

/** Innermost node touching `offset` (an atom the cursor is on, or the list it is inside). */
export function nodeAt(result: ParseResult, offset: number): Node | null {
  let candidates = result.forms;
  let found: Node | null = null;
  for (;;) {
    const node = pickContaining(candidates, offset);
    if (!node) return found;
    found = node;
    if (node.kind !== 'list' || !isInsideList(node, offset)) return node;
    candidates = node.children;
  }
}

/** Innermost list whose delimiters surround `offset`. */
export function enclosingList(result: ParseResult, offset: number): ListNode | null {
  let candidates = result.forms;
  let inside: ListNode | null = null;
  for (;;) {
    const node = pickContaining(candidates, offset);
    if (!node || node.kind !== 'list' || !isInsideList(node, offset)) return inside;
    inside = node;
    candidates = node.children;
  }
}

/** The symbol or keyword atom the cursor is on, if any. */
export function symbolAt(result: ParseResult, offset: number): AtomNode | null {
  const node = nodeAt(result, offset);
  return isSymbol(node) && node.formStart <= offset && offset <= node.end ? node : null;
}

/** Top-level form containing `offset`, else the one just before it. */
export function topLevelFormAt(result: ParseResult, offset: number): Node | null {
  const containing = pickContaining(result.forms, offset);
  if (containing) return containing;
  let last: Node | null = null;
  for (const form of result.forms) {
    if (form.end <= offset) last = form;
    else break;
  }
  return last;
}

/**
 * The form "before the cursor" in the Emacs eval-last-sexp sense: the atom the
 * cursor is on, otherwise the last sibling that ends at or before `offset`.
 */
export function formBefore(result: ParseResult, offset: number): Node | null {
  const node = nodeAt(result, offset);
  if (node && node.kind !== 'list' && node.formStart <= offset && offset <= node.end) return node;
  if (node && node.kind === 'list' && !isInsideList(node, offset) && node.end === offset) return node;
  const parent = enclosingList(result, offset);
  const siblings = parent ? parent.children : result.forms;
  let last: Node | null = null;
  for (const sibling of siblings) {
    if (sibling.end <= offset) last = sibling;
    else break;
  }
  return last;
}

export function headSymbol(list: ListNode): AtomNode | null {
  const first = list.children[0];
  return isSymbol(first) && first.kind === 'symbol' ? first : null;
}

/** Normalized name of a list's first element when it is a symbol or keyword (`(:tree ...)`), else null. */
export function headName(node: Node | null | undefined): string | null {
  if (!node || node.kind !== 'list') return null;
  const first = node.children[0];
  return isSymbol(first) ? first.name : null;
}

/** The characters of a string token without its quotes (escapes left as written). */
export function stringContent(raw: string): string {
  const body = raw.startsWith('"') ? raw.slice(1) : raw;
  return body.endsWith('"') && body.length > 0 && !body.endsWith('\\"') ? body.slice(0, -1) : body;
}

/** Name designated by a symbol, keyword or string node, normalized like a symbol name. */
export function designatorName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.kind === 'symbol' || node.kind === 'keyword') return node.name;
  if (node.kind === 'string') return stringContent(node.text).toUpperCase();
  return null;
}

/** Package in effect at `offset`: the closest preceding top-level `(in-package ...)`, or null. */
export function inPackageAt(result: ParseResult, offset: number): string | null {
  let current: string | null = null;
  for (const form of result.forms) {
    if (form.start >= offset) break;
    if (form.kind === 'list' && headName(form) === 'IN-PACKAGE') {
      const name = designatorName(form.children[1]);
      if (name) current = name;
    }
  }
  return current;
}

export function walk(nodes: Node[], visit: (node: Node) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'list') walk(node.children, visit);
  }
}

export function ancestors(node: Node): ListNode[] {
  const out: ListNode[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}
