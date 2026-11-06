/**
 * Structural editing as pure text transformations. Each function returns the
 * edits to apply (non-overlapping, in document order) and where the cursor
 * should land, or null when the operation does not apply at that position.
 */
import { Node, ListNode, enclosingList, isInsideList, nodeAt, parse, ParseResult, topLevelFormAt } from '../common/reader';

export interface Edit {
  start: number;
  end: number;
  newText: string;
}

export interface EditResult {
  edits: Edit[];
  cursor: number;
}

/** Applies non-overlapping edits to `text`. */
export function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of sorted) out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  return out;
}

/** Where `offset` ends up after `edits` are applied. */
export function mapOffset(edits: Edit[], offset: number): number {
  let result = offset;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.end <= offset) {
      result += edit.newText.length - (edit.end - edit.start);
    } else if (edit.start < offset) {
      result = edit.start + edit.newText.length + (result - offset);
      break;
    }
  }
  return result;
}

function siblingsOf(result: ParseResult, node: Node): Node[] {
  return node.parent ? node.parent.children : result.forms;
}

function closedEnclosingList(result: ParseResult, offset: number): ListNode | null {
  const list = enclosingList(result, offset);
  return list && list.closed ? list : null;
}

/** Moves the closing paren of the current list past the next sibling form: (a b| c) -> (a b c). */
export function slurpForward(text: string, offset: number): EditResult | null {
  const result = parse(text);
  const list = closedEnclosingList(result, offset);
  if (!list) return null;
  const siblings = siblingsOf(result, list);
  const next = siblings[siblings.indexOf(list) + 1];
  if (!next) return null;
  const edits: Edit[] = [
    { start: list.end - 1, end: list.end, newText: '' },
    { start: next.end, end: next.end, newText: ')' },
  ];
  return { edits, cursor: mapOffset(edits, offset) };
}

/** Moves the closing paren of the current list before its last form: (a b| c) -> (a b) c. */
export function barfForward(text: string, offset: number): EditResult | null {
  const result = parse(text);
  const list = closedEnclosingList(result, offset);
  if (!list || list.children.length === 0) return null;
  const children = list.children;
  const previous = children[children.length - 2];
  const newClose = previous ? previous.end : list.formStart + list.open.length;
  const needsSpace = newClose < text.length && !/\s/.test(text[newClose]);
  const edits: Edit[] = [
    { start: newClose, end: newClose, newText: needsSpace ? ') ' : ')' },
    { start: list.end - 1, end: list.end, newText: '' },
  ];
  const cursor = Math.min(mapOffset(edits, offset), newClose);
  return { edits, cursor };
}

/** Removes the delimiters (and prefix) of the current list: (a |b c) -> a b c. */
export function spliceForm(text: string, offset: number): EditResult | null {
  const result = parse(text);
  const list = enclosingList(result, offset);
  if (!list) return null;
  const edits: Edit[] = [{ start: list.start, end: list.formStart + list.open.length, newText: '' }];
  if (list.closed) edits.push({ start: list.end - 1, end: list.end, newText: '' });
  return { edits, cursor: mapOffset(edits, offset) };
}

/** The form the cursor is on, or the next one in the same list. */
function formAtOrAfter(result: ParseResult, offset: number): Node | null {
  const node = nodeAt(result, offset);
  if (node && !(node.kind === 'list' && isInsideList(node, offset))) return node;
  const list = node && node.kind === 'list' ? node : null;
  const siblings = list ? list.children : result.forms;
  return siblings.find((s) => s.start >= offset) ?? null;
}

/** Replaces the enclosing list with the form at the cursor: (foo (bar |x) baz) -> (foo x baz)... raising x's parent: (bar x). */
export function raiseForm(text: string, offset: number): EditResult | null {
  const result = parse(text);
  const target = formAtOrAfter(result, offset);
  if (!target || !target.parent) return null;
  const parent = target.parent;
  const newText = text.slice(target.start, target.end);
  const edits: Edit[] = [{ start: parent.start, end: parent.end, newText }];
  const within = Math.min(Math.max(offset - target.start, 0), newText.length);
  return { edits, cursor: parent.start + within };
}

/** Wraps the selection, or the form at the cursor, in parentheses; cursor lands after the "(". */
export function wrapParens(text: string, selectionStart: number, selectionEnd: number): EditResult {
  const result = parse(text);
  let start = selectionStart;
  let end = selectionEnd;
  if (start === end) {
    const target = formAtOrAfter(result, start);
    if (target) {
      start = target.start;
      end = target.end;
    }
  }
  if (start === end) {
    return { edits: [{ start, end, newText: '()' }], cursor: start + 1 };
  }
  const edits: Edit[] = [
    { start, end: start, newText: '(' },
    { start: end, end, newText: ')' },
  ];
  return { edits, cursor: start + 1 };
}

/** Offsets of the top-level form at the cursor. */
export function topLevelRange(text: string, offset: number): [number, number] | null {
  const result = parse(text);
  const form = topLevelFormAt(result, offset);
  return form ? [form.start, form.end] : null;
}
