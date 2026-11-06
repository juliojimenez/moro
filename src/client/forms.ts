/**
 * Pure helpers that pick the piece of source the REPL commands operate on.
 * They re-parse the whole text each time, which is fine for editor buffers.
 */
import { designatorName, enclosingList, formBefore, headName, inPackageAt, isList, parse, symbolAt, textOf, topLevelFormAt } from '../common/reader';

export interface FormSelection {
  start: number;
  end: number;
  text: string;
}

function selection(text: string, start: number, end: number): FormSelection {
  return { start, end, text: text.slice(start, end) };
}

/** The top-level form containing the offset, or the one just before it. */
export function topLevelFormAtOffset(text: string, offset: number): FormSelection | null {
  const result = parse(text);
  const form = topLevelFormAt(result, offset);
  return form ? selection(text, form.start, form.end) : null;
}

/** The form before the cursor in the eval-last-sexp sense (or the atom under it). */
export function lastFormBefore(text: string, offset: number): FormSelection | null {
  const result = parse(text);
  const form = formBefore(result, offset);
  return form ? selection(text, form.start, form.end) : null;
}

/** The innermost list around the cursor, falling back to the top-level form. */
export function innermostFormAt(text: string, offset: number): FormSelection | null {
  const result = parse(text);
  const list = enclosingList(result, offset);
  if (list) return selection(text, list.start, list.end);
  const form = topLevelFormAt(result, offset);
  return form ? selection(text, form.start, form.end) : null;
}

/** The symbol token (with its package prefix) under the cursor, as written. */
export function symbolTextAt(text: string, offset: number): string | null {
  const result = parse(text);
  const symbol = symbolAt(result, offset);
  if (!symbol) return null;
  return symbol.uninterned ? symbol.text.slice(2) : symbol.text;
}

/** The package named by the closest preceding (in-package ...), or null. */
export function packageAt(text: string, offset: number): string | null {
  return inPackageAt(parse(text), offset);
}

/** If `formText` is an (in-package ...) form, the package it names. */
export function inPackageTarget(formText: string): string | null {
  const result = parse(formText);
  const form = result.forms[0];
  if (!isList(form) || headName(form) !== 'IN-PACKAGE') return null;
  return designatorName(form.children[1]);
}

/** Names of the systems defined with defsystem in an .asd file, lower-cased. */
export function defsystemNames(text: string): string[] {
  const result = parse(text);
  const names: string[] = [];
  for (const form of result.forms) {
    if (!isList(form) || headName(form) !== 'DEFSYSTEM') continue;
    const name = designatorName(form.children[1]);
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

export { textOf };
