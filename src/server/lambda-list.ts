/**
 * Lambda list parsing for signature help: splits "(a &optional b &key c)"
 * into parameters with their offsets in the string and decides which one the
 * cursor is on.
 */
import { parse, isList, isSymbol, LAMBDA_LIST_KEYWORDS } from '../common/reader';

export type Section = 'required' | 'optional' | 'rest' | 'key' | 'aux' | 'other';

export interface Parameter {
  label: string;
  start: number;
  end: number;
  section: Section;
  /** Normalized keyword name for &key parameters. */
  keyword?: string;
}

export interface ParsedLambdaList {
  text: string;
  parameters: Parameter[];
}

export function parseLambdaList(text: string): ParsedLambdaList {
  const result = parse(text);
  const list = result.forms[0];
  const parameters: Parameter[] = [];
  if (!isList(list)) return { text, parameters };
  let section: Section = 'required';
  for (const param of list.children) {
    if (isSymbol(param) && LAMBDA_LIST_KEYWORDS.has(param.name)) {
      switch (param.name) {
        case '&OPTIONAL':
          section = 'optional';
          break;
        case '&REST':
        case '&BODY':
          section = 'rest';
          break;
        case '&KEY':
          section = 'key';
          break;
        case '&AUX':
          section = 'aux';
          break;
        default:
          section = 'other';
          break;
      }
      continue;
    }
    if (param.kind === 'error') continue;
    const entry: Parameter = { label: text.slice(param.start, param.end), start: param.start, end: param.end, section };
    if (section === 'key') {
      let keyword: string | undefined;
      if (isSymbol(param)) keyword = param.name;
      else if (isList(param)) {
        const first = param.children[0];
        if (isSymbol(first)) keyword = first.name;
        else if (isList(first) && isSymbol(first.children[0])) keyword = first.children[0].name;
      }
      entry.keyword = keyword;
    }
    parameters.push(entry);
  }
  return { text, parameters };
}

/**
 * Index into `parameters` of the parameter the cursor is on, given that
 * `argIndex` arguments precede the cursor and `previousKeyword` is the
 * normalized keyword written just before the cursor, if any.
 */
export function activeParameter(parameters: Parameter[], argIndex: number, previousKeyword: string | null): number | null {
  const required = parameters.filter((p) => p.section === 'required');
  const optional = parameters.filter((p) => p.section === 'optional');
  const rest = parameters.find((p) => p.section === 'rest');
  const keys = parameters.filter((p) => p.section === 'key');
  if (argIndex < required.length) return parameters.indexOf(required[argIndex]);
  const afterRequired = argIndex - required.length;
  if (afterRequired < optional.length) return parameters.indexOf(optional[afterRequired]);
  if (keys.length > 0) {
    if (previousKeyword) {
      const match = keys.find((k) => k.keyword === previousKeyword);
      if (match) return parameters.indexOf(match);
    }
    if (rest) return parameters.indexOf(rest);
    return null;
  }
  if (rest) return parameters.indexOf(rest);
  return null;
}
