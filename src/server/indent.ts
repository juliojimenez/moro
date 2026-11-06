/**
 * Common Lisp indentation, in the style of Emacs / SLIME's
 * `common-lisp-indent-function`.
 *
 * The engine works on the reader's form tree, never on text patterns, so it
 * knows which list a line continues, whether the list's head is an operator
 * with "distinguished" arguments (the ones that get 4 spaces when they sit on
 * their own line) and a body (2 spaces), a plain function call (arguments
 * align under the first one), or data (elements align under the first).
 *
 * Lines inside multi-line strings and `#| |#` comments are never touched, and
 * neither are `;;;` comment lines (Emacs leaves those alone too).
 */

import {
  parse,
  ParseResult,
  ListNode,
  AtomNode,
  Node,
  lineOf,
  headName,
  enclosingList,
  nodeAt,
  isSymbol,
  LAMBDA_LIST_KEYWORDS,
} from '../common/reader';

export interface IndentSettings {
  /** Indentation of body forms relative to the open paren (2). */
  bodyIndent: number;
  /** Indentation of distinguished arguments on their own line (4). */
  distinguishedIndent: number;
  /** UPPER-CASE operator name -> number of distinguished arguments. */
  specs: Map<string, number>;
  /**
   * Workspace knowledge from the server: for a user-defined macro with
   * &body/&rest, the number of required parameters before it; -1 for a known
   * plain function (never apply heuristics); undefined when unknown.
   */
  operatorArity?: (name: string) => number | undefined;
}

/** Operator -> distinguished argument count. Everything else is a plain call. */
export const DEFAULT_SPECS: Record<string, number> = {
  // Definitions
  DEFUN: 2,
  DEFMACRO: 2,
  DEFGENERIC: 2,
  DEFMETHOD: 2, // handled specially: qualifiers count as distinguished
  DEFTYPE: 2,
  'DEFINE-COMPILER-MACRO': 2,
  'DEFINE-SETF-EXPANDER': 2,
  'DEFINE-MODIFY-MACRO': 2,
  'DEFINE-METHOD-COMBINATION': 2,
  DEFSETF: 2,
  DEFVAR: 1,
  DEFPARAMETER: 1,
  DEFCONSTANT: 1,
  'DEFINE-CONSTANT': 1,
  'DEFINE-SYMBOL-MACRO': 1,
  DEFCLASS: 2,
  'DEFINE-CONDITION': 2,
  DEFSTRUCT: 1,
  DEFPACKAGE: 1,
  'DEFINE-PACKAGE': 1,
  DEFSYSTEM: 1,
  // Binding and control
  LAMBDA: 1,
  LET: 1,
  'LET*': 1,
  FLET: 1,
  LABELS: 1,
  MACROLET: 1,
  'SYMBOL-MACROLET': 1,
  PROG: 1,
  'PROG*': 1,
  PROGN: 0,
  PROG1: 1,
  PROG2: 2,
  PROGV: 2,
  LOCALLY: 0,
  WHEN: 1,
  UNLESS: 1,
  CASE: 1,
  ECASE: 1,
  CCASE: 1,
  TYPECASE: 1,
  ETYPECASE: 1,
  CTYPECASE: 1,
  CATCH: 1,
  BLOCK: 1,
  'RETURN-FROM': 1,
  'UNWIND-PROTECT': 1,
  'MULTIPLE-VALUE-BIND': 2,
  'MULTIPLE-VALUE-PROG1': 1,
  'DESTRUCTURING-BIND': 2,
  'HANDLER-CASE': 1,
  'HANDLER-BIND': 1,
  'RESTART-CASE': 1,
  'RESTART-BIND': 1,
  'IGNORE-ERRORS': 0,
  'WITH-SLOTS': 2,
  'WITH-ACCESSORS': 2,
  'WITH-OPEN-FILE': 1,
  'WITH-OPEN-STREAM': 1,
  'WITH-INPUT-FROM-STRING': 1,
  'WITH-OUTPUT-TO-STRING': 1,
  'WITH-STANDARD-IO-SYNTAX': 0,
  'WITH-SIMPLE-RESTART': 1,
  'WITH-CONDITION-RESTARTS': 2,
  'WITH-HASH-TABLE-ITERATOR': 1,
  'WITH-PACKAGE-ITERATOR': 1,
  'WITH-COMPILATION-UNIT': 1,
  DO: 2,
  'DO*': 2,
  DOLIST: 1,
  DOTIMES: 1,
  'DO-SYMBOLS': 1,
  'DO-EXTERNAL-SYMBOLS': 1,
  'DO-ALL-SYMBOLS': 1,
  'EVAL-WHEN': 1,
  THE: 1,
  TAGBODY: 0,
  'PPRINT-LOGICAL-BLOCK': 1,
  'PRINT-UNREADABLE-OBJECT': 1,
};

export function defaultSettings(): IndentSettings {
  return {
    bodyIndent: 2,
    distinguishedIndent: 4,
    specs: new Map(Object.entries(DEFAULT_SPECS)),
  };
}

export interface OffsetEdit {
  start: number;
  end: number;
  newText: string;
}

/** Positions (child indices) that hold variable or lambda lists: data, not calls. */
const DATA_POSITIONS: Record<string, number[]> = {
  LAMBDA: [1],
  DEFUN: [2],
  DEFMACRO: [2],
  DEFTYPE: [2],
  'DEFINE-COMPILER-MACRO': [2],
  DEFGENERIC: [2],
  'DEFINE-SETF-EXPANDER': [2],
  'DEFINE-MODIFY-MACRO': [2],
  DEFSETF: [2, 3],
  'MULTIPLE-VALUE-BIND': [1],
  'DESTRUCTURING-BIND': [1],
  'WITH-SLOTS': [1],
  'WITH-ACCESSORS': [1],
  LET: [1],
  'LET*': [1],
  PROG: [1],
  'PROG*': [1],
  FLET: [1],
  LABELS: [1],
  MACROLET: [1],
  'SYMBOL-MACROLET': [1],
  DO: [1, 2],
  'DO*': [1, 2],
  DOLIST: [1],
  DOTIMES: [1],
  'DO-SYMBOLS': [1],
  'DO-EXTERNAL-SYMBOLS': [1],
  'DO-ALL-SYMBOLS': [1],
  DEFCLASS: [2, 3],
  'DEFINE-CONDITION': [2, 3],
};

const LOCAL_FUNCTION_FORMS = new Set(['FLET', 'LABELS', 'MACROLET']);
const CLAUSE_FORMS = new Set(['HANDLER-CASE', 'RESTART-CASE']);
const SLOT_FORMS = new Set(['DEFCLASS', 'DEFINE-CONDITION']);

/** Loop keywords that start a clause (as opposed to continuing one, like IN or BY). */
const LOOP_CLAUSE_KEYWORDS = new Set([
  'FOR', 'AS', 'WITH', 'REPEAT', 'WHILE', 'UNTIL', 'ALWAYS', 'NEVER', 'THEREIS', 'INITIALLY', 'FINALLY', 'NAMED',
  'DO', 'DOING', 'COLLECT', 'COLLECTING', 'APPEND', 'APPENDING', 'NCONC', 'NCONCING', 'SUM', 'SUMMING',
  'COUNT', 'COUNTING', 'MAXIMIZE', 'MAXIMIZING', 'MINIMIZE', 'MINIMIZING', 'RETURN',
  'WHEN', 'IF', 'UNLESS', 'ELSE', 'END', 'AND',
]);
/** Clause keywords that end any pending conditional and go back to the clause column. */
const LOOP_TERMINATORS = new Set([
  'FOR', 'AS', 'WITH', 'REPEAT', 'WHILE', 'UNTIL', 'ALWAYS', 'NEVER', 'THEREIS', 'INITIALLY', 'FINALLY', 'NAMED',
]);
const LOOP_CONDITIONALS = new Set(['WHEN', 'IF', 'UNLESS']);

const TAB_WIDTH = 8;

type ColumnOf = (offset: number) => number;

interface LineInfo {
  start: number;
  /** End of the line's content (before any CR/LF). */
  end: number;
  /** Offset of the first non-blank character, or `end` for a blank line. */
  firstNonBlank: number;
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9 || code === 12 || code === 11;
}

function lineInfo(result: ParseResult, line: number): LineInfo {
  const text = result.text;
  const start = result.lineStarts[line];
  let end = line + 1 < result.lineStarts.length ? result.lineStarts[line + 1] - 1 : text.length;
  if (end > start && text.charCodeAt(end - 1) === 13) end--;
  let i = start;
  while (i < end && isBlank(text.charCodeAt(i))) i++;
  return { start, end, firstNonBlank: i };
}

/** Visual column of `offset` on its line, expanding tabs to multiples of 8. */
function visualColumn(text: string, lineStart: number, offset: number): number {
  let col = 0;
  for (let i = lineStart; i < offset; i++) {
    col = text.charCodeAt(i) === 9 ? (Math.floor(col / TAB_WIDTH) + 1) * TAB_WIDTH : col + 1;
  }
  return col;
}

function insideBlockComment(result: ParseResult, lineStart: number): boolean {
  const comments = result.comments;
  let lo = 0;
  let hi = comments.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (comments[mid].start < lineStart) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return false;
  const comment = comments[idx];
  return comment.kind === 'block' && comment.end >= lineStart;
}

function countBefore(children: Node[], offset: number): number {
  let n = 0;
  for (const child of children) {
    if (child.start < offset) n++;
    else break;
  }
  return n;
}

function containsLambdaListKeyword(list: ListNode): boolean {
  return list.children.some((c) => c.kind === 'symbol' && LAMBDA_LIST_KEYWORDS.has(c.name));
}

/** `(name (args) body)` inside the bindings of FLET / LABELS / MACROLET. */
function isLocalFunctionBinding(list: ListNode): boolean {
  const bindings = list.parent;
  const form = bindings?.parent;
  return !!bindings && !!form && form.children[1] === bindings && LOCAL_FUNCTION_FORMS.has(headName(form) ?? '');
}

/** `(type (var) body)` clause of HANDLER-CASE / RESTART-CASE. */
function isHandlerClause(list: ListNode): boolean {
  const form = list.parent;
  if (!form || !CLAUSE_FORMS.has(headName(form) ?? '')) return false;
  return form.children.indexOf(list) >= 2;
}

/** A slot specifier inside the slot list of DEFCLASS / DEFINE-CONDITION. */
function isSlotSpec(list: ListNode): boolean {
  const slots = list.parent;
  const form = slots?.parent;
  return !!slots && !!form && form.children[3] === slots && SLOT_FORMS.has(headName(form) ?? '');
}

/** Lambda lists and binding lists are data: elements align under the first. */
function isDataPosition(list: ListNode): boolean {
  const parent = list.parent;
  if (!parent) return false;
  if (list.prefix.includes(',')) return false; // `(let ,(compute-bindings) ...)`: a form, not a binding list
  const idx = parent.children.indexOf(list);
  const head = headName(parent);
  if (head) {
    const positions = DATA_POSITIONS[head];
    if (positions && positions.includes(idx)) return true;
    if (head === 'DEFMETHOD' && idx >= 2) {
      for (let i = 2; i < idx; i++) {
        if (parent.children[i].kind === 'list') return false;
      }
      return true;
    }
  }
  if (idx === 1 && (isLocalFunctionBinding(parent) || isHandlerClause(parent))) return true;
  return false;
}

/** Index of the lambda list in a DEFMETHOD (name, then qualifiers, then the list). */
function defmethodSpec(list: ListNode): number {
  const children = list.children;
  let i = 2;
  while (i < children.length && children[i].kind !== 'list') i++;
  return i;
}

/**
 * Emacs cl-indent heuristics for operators nobody described: `def...` forms
 * get `lisp-indent-defform` (every argument on its own line is body), and
 * `with-...` / `do-...` forms get one distinguished argument.
 */
function heuristicSpec(name: string): number | undefined {
  if (name.startsWith('DEF')) return 0;
  if (name.startsWith('WITH-') || name.startsWith('DO-')) return 1;
  return undefined;
}

function isLambdaListKeyword(node: Node | undefined): node is AtomNode {
  return !!node && node.kind === 'symbol' && LAMBDA_LIST_KEYWORDS.has(node.name);
}

/**
 * Lambda lists, SLIME "modern" style: a keyword on a new line aligns under
 * the first keyword (else under the first parameter); parameters align under
 * the first parameter that followed the last keyword, or two columns in from
 * a keyword that ended its line.
 */
function indentLambdaList(
  result: ParseResult,
  list: ListNode,
  lineStart: number,
  line: number,
  base: number,
  settings: IndentSettings,
  colOf: ColumnOf,
): number {
  const children = list.children;
  const before = countBefore(children, lineStart);
  const current = children[before];
  if (current && lineOf(result, current.start) === line && isLambdaListKeyword(current)) {
    for (let i = 0; i < before; i++) {
      if (isLambdaListKeyword(children[i])) return colOf(children[i].start);
    }
    return base;
  }
  for (let i = before - 1; i >= 0; i--) {
    const keyword = children[i];
    if (!isLambdaListKeyword(keyword)) continue;
    const next = children[i + 1];
    if (next && next.start < lineStart && lineOf(result, next.start) === lineOf(result, keyword.start)) {
      return colOf(next.start);
    }
    return colOf(keyword.start) + settings.bodyIndent;
  }
  return base;
}

function isClauseKeyword(node: Node | undefined): node is AtomNode {
  return !!node && (node.kind === 'symbol' || node.kind === 'keyword') && LOOP_CLAUSE_KEYWORDS.has(node.name);
}

function indentLoop(
  result: ParseResult,
  list: ListNode,
  lineStart: number,
  line: number,
  settings: IndentSettings,
  colOf: ColumnOf,
): number {
  const children = list.children;
  const head = children[0];
  const parenCol = colOf(list.formStart + list.open.length - 1);
  const first = children[1];
  const clauseCol =
    first && lineOf(result, first.start) === lineOf(result, head.start)
      ? colOf(first.start)
      : parenCol + settings.bodyIndent;

  // Group the clause tokens before this line by the line they start on.
  const groups: Node[][] = [];
  let previousLine = -1;
  let consumed = 0;
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    if (child.start >= lineStart) break;
    consumed++;
    const childLine = lineOf(result, child.start);
    if (childLine !== previousLine) {
      groups.push([child]);
      previousLine = childLine;
    } else {
      groups[groups.length - 1].push(child);
    }
  }
  const current = children[1 + consumed];
  const currentOnLine = current !== undefined && lineOf(result, current.start) === line;

  if (currentOnLine && !isClauseKeyword(current)) {
    // Continuation of the previous clause's body.
    const previous = groups[groups.length - 1];
    if (!previous) return clauseCol;
    const first = previous[0];
    if (isClauseKeyword(first)) {
      return previous.length >= 2 ? colOf(previous[1].start) : colOf(first.start) + settings.bodyIndent;
    }
    return colOf(first.start);
  }

  // A clause keyword line (or a blank/comment line, where the next clause goes).
  let depth = 0;
  let justCompleted = false;
  const step = (keyword: string | null, groupLength: number): number => {
    let closed = false;
    if (justCompleted && keyword !== 'AND') {
      depth = Math.max(depth - 1, 0);
      justCompleted = false;
      closed = true;
    }
    if (keyword === null) return depth;
    if (LOOP_CONDITIONALS.has(keyword)) {
      const lineDepth = depth;
      depth = lineDepth + 1;
      justCompleted = groupLength > 2;
      return lineDepth;
    }
    if (keyword === 'ELSE') {
      const lineDepth = depth;
      depth = lineDepth + 1;
      justCompleted = groupLength > 1;
      return lineDepth;
    }
    if (keyword === 'END') {
      if (!closed) depth = Math.max(depth - 1, 0);
      return depth;
    }
    if (LOOP_TERMINATORS.has(keyword)) {
      depth = 0;
      return 0;
    }
    if (keyword === 'AND') return depth;
    justCompleted = depth > 0; // a body clause satisfies the pending conditional
    return depth;
  };
  for (const group of groups) {
    const first = group[0];
    if (isClauseKeyword(first)) step(first.name, group.length);
  }
  const lineDepth = step(currentOnLine && isClauseKeyword(current) ? current.name : null, 0);
  return clauseCol + lineDepth * settings.bodyIndent;
}

function indentInList(
  result: ParseResult,
  list: ListNode,
  lineStart: number,
  line: number,
  settings: IndentSettings,
  colOf: ColumnOf,
): number {
  const children = list.children;
  const parenOffset = list.formStart + list.open.length - 1;
  const parenCol = colOf(parenOffset);
  const parenLine = lineOf(result, parenOffset);
  const head = children[0];
  const headOnOpenLine = head !== undefined && lineOf(result, head.start) === parenLine;

  const dataList =
    list.open !== '(' ||
    !headOnOpenLine ||
    !isSymbol(head) ||
    isDataPosition(list) ||
    containsLambdaListKeyword(list);
  if (dataList || !isSymbol(head)) {
    const base = headOnOpenLine && head ? colOf(head.start) : parenCol + 1;
    return containsLambdaListKeyword(list)
      ? indentLambdaList(result, list, lineStart, line, base, settings, colOf)
      : base;
  }

  const name = head.name;
  if (head.kind === 'symbol' && name === 'LOOP') {
    return indentLoop(result, list, lineStart, line, settings, colOf);
  }

  let spec: number | undefined;
  let plainCall = false;
  if (isLocalFunctionBinding(list) || isHandlerClause(list)) {
    spec = 1;
  } else if (head.prefix !== '') {
    // `(,fn ,a ,b)` in a backquote template, `('foo ...)`: data shaped like a call.
    plainCall = true;
  } else if (head.kind === 'keyword') {
    // `(:section :class "x" (:p ...))` markup style: a line that starts with a
    // form is a body form; a line that starts with an atom aligns like a call.
    const current = children[countBefore(children, lineStart)];
    if (current && lineOf(result, current.start) === line && current.kind === 'list') {
      return parenCol + settings.bodyIndent;
    }
    plainCall = true;
  } else if (name === 'DEFMETHOD') {
    spec = defmethodSpec(list);
  } else if (!isSlotSpec(list)) {
    spec = settings.specs.get(name);
    if (spec === undefined && settings.operatorArity) {
      const arity = settings.operatorArity(name);
      if (arity !== undefined) {
        if (arity >= 0) spec = arity;
        else plainCall = true;
      }
    }
    if (spec === undefined && !plainCall) spec = heuristicSpec(name);
  }

  if (spec !== undefined) {
    const argsBefore = countBefore(children, lineStart) - 1;
    return parenCol + (argsBefore < spec ? settings.distinguishedIndent : settings.bodyIndent);
  }

  // Plain call: under the first argument when it shares the head's line, else under the head.
  const firstArg = children[1];
  if (firstArg && lineOf(result, firstArg.start) === lineOf(result, head.start)) return colOf(firstArg.start);
  if (head.kind === 'symbol' && name === 'COND') return parenCol + settings.bodyIndent;
  return colOf(head.start);
}

function computeIndent(result: ParseResult, line: number, settings: IndentSettings, colOf: ColumnOf): number | null {
  if (line < 0 || line >= result.lineStarts.length) return null;
  const info = lineInfo(result, line);
  const lineStart = info.start;
  if (insideBlockComment(result, lineStart)) return null;
  const touching = nodeAt(result, lineStart);
  if (touching && touching.kind !== 'list' && touching.formStart < lineStart && lineStart <= touching.end) {
    return null; // inside a multi-line string (or |symbol|)
  }
  if (result.text.startsWith(';;;', info.firstNonBlank)) return null; // like Emacs: never moved
  const list = enclosingList(result, lineStart);
  if (!list) return 0;
  return indentInList(result, list, lineStart, line, settings, colOf);
}

/**
 * Desired indentation column for `line` (0-based), or null when the line must
 * be left alone (inside a multi-line string or block comment).
 */
export function indentationForLine(result: ParseResult, line: number, settings: IndentSettings): number | null {
  const colOf: ColumnOf = (offset) => visualColumn(result.text, result.lineStarts[lineOf(result, offset)], offset);
  return computeIndent(result, line, settings, colOf);
}

/**
 * Edits that fix the leading whitespace of each line in [firstLine, lastLine].
 * Computed top-down: when a line moves, the columns of the forms on it move
 * too, so a per-line column delta is tracked instead of re-parsing.
 * Blank lines are left blank (stray whitespace on them is removed).
 */
export function reindentLines(
  result: ParseResult,
  firstLine: number,
  lastLine: number,
  settings: IndentSettings,
): OffsetEdit[] {
  const edits: OffsetEdit[] = [];
  const deltas: number[] = [];
  const text = result.text;
  const colOf: ColumnOf = (offset) => {
    const ln = lineOf(result, offset);
    return visualColumn(text, result.lineStarts[ln], offset) + (deltas[ln] ?? 0);
  };
  const last = Math.min(lastLine, result.lineStarts.length - 1);
  for (let line = Math.max(0, firstLine); line <= last; line++) {
    const info = lineInfo(result, line);
    if (info.firstNonBlank >= info.end) {
      if (info.firstNonBlank > info.start && !insideBlockComment(result, info.start)) {
        const touching = nodeAt(result, info.start);
        const inAtom = touching && touching.kind !== 'list' && touching.formStart < info.start && info.start <= touching.end;
        if (!inAtom) edits.push({ start: info.start, end: info.firstNonBlank, newText: '' });
      }
      continue;
    }
    const desired = computeIndent(result, line, settings, colOf);
    if (desired === null) continue;
    const current = visualColumn(text, info.start, info.firstNonBlank);
    const newText = ' '.repeat(desired);
    if (text.slice(info.start, info.firstNonBlank) !== newText) {
      edits.push({ start: info.start, end: info.firstNonBlank, newText });
    }
    if (desired !== current) deltas[line] = desired - current;
  }
  return edits;
}

/** Applies non-overlapping edits sorted by start offset. */
export function applyOffsetEdits(text: string, edits: OffsetEdit[]): string {
  let out = '';
  let pos = 0;
  for (const edit of edits) {
    out += text.slice(pos, edit.start) + edit.newText;
    pos = edit.end;
  }
  return out + text.slice(pos);
}

/** Whole-text convenience: returns `text` reindented. */
export function reindentText(text: string, settings: IndentSettings = defaultSettings()): string {
  const result = parse(text);
  return applyOffsetEdits(text, reindentLines(result, 0, result.lineStarts.length - 1, settings));
}
