/**
 * Language feature implementations. Each function takes the server context
 * and plain LSP parameters and returns LSP results; main.ts wires them up.
 */
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Diagnostic,
  DiagnosticSeverity,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InsertTextFormat,
  Location,
  LocationLink,
  MarkupContent,
  MarkupKind,
  ParameterInformation,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SemanticTokensBuilder,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import {
  AtomNode,
  ListNode,
  Node,
  ParseResult,
  enclosingList,
  headName,
  headSymbol,
  isConstituent,
  isInsideList,
  isList,
  isSymbol,
  lineOf,
  nodeAt,
  positionAt,
  symbolAt,
  walk,
  LAMBDA_LIST_KEYWORDS,
} from '../common/reader';
import { Definition, DefKind } from './analysis';
import { activeParameter, parseLambdaList } from './lambda-list';
import { allBindings, Binding, bindingsAt } from './scopes';
import { StdSymbol, allStandard, hyperspecUrl, isCallable, kindLabel, lookupStandard, primaryDoc } from './symbols';
import { typePositions } from './types';
import { FoundDefinition, IndexedFile, WorkspaceIndex } from './workspace';

export interface ServerContext {
  index: WorkspaceIndex;
  hyperspecBase: string;
}

export const SEMANTIC_TOKEN_TYPES = ['function', 'macro', 'parameter', 'variable', 'type'];
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration'];

const LOOP_KEYWORDS = [
  'for', 'as', 'with', 'and', 'in', 'on', 'across', 'being', 'each', 'the', 'hash-key', 'hash-keys', 'hash-value', 'hash-values',
  'using', 'of', 'symbol', 'symbols', 'present-symbol', 'present-symbols', 'external-symbol', 'external-symbols', 'from', 'upfrom',
  'downfrom', 'to', 'upto', 'downto', 'below', 'above', 'by', 'then', 'repeat', 'while', 'until', 'always', 'never', 'thereis',
  'do', 'doing', 'collect', 'collecting', 'append', 'appending', 'nconc', 'nconcing', 'count', 'counting', 'sum', 'summing',
  'maximize', 'maximizing', 'minimize', 'minimizing', 'into', 'return', 'if', 'when', 'unless', 'else', 'end', 'finally',
  'initially', 'named', 'of-type',
];

const COMMON_KEYWORDS = [
  'initarg', 'initform', 'accessor', 'reader', 'writer', 'type', 'documentation', 'allocation', 'instance', 'class',
  'default-initargs', 'metaclass', 'use', 'export', 'import-from', 'shadow', 'shadowing-import-from', 'nicknames', 'intern',
  'size', 'depends-on', 'components', 'file', 'module', 'serial', 'pathname', 'description', 'author', 'license', 'version',
  'maintainer', 'homepage', 'long-description', 'in-order-to', 'test-op', 'load-op', 'compile-op', 'perform', 'static-file',
  'defsystem-depends-on', 'build-operation', 'entry-point', 'direction', 'input', 'output', 'io', 'probe', 'if-exists',
  'if-does-not-exist', 'element-type', 'external-format', 'supersede', 'append', 'overwrite', 'rename', 'rename-and-delete',
  'new-version', 'error', 'create', 'default', 'test', 'test-not', 'key', 'start', 'end', 'start1', 'end1', 'start2', 'end2',
  'from-end', 'count', 'initial-element', 'initial-contents', 'adjustable', 'fill-pointer', 'displaced-to',
  'displaced-index-offset', 'report', 'conc-name', 'constructor', 'predicate', 'copier', 'include', 'print-function',
  'print-object', 'named', 'initial-offset', 'compile-toplevel', 'load-toplevel', 'execute', 'inherited', 'internal',
  'external', 'around', 'before', 'after', 'most-specific-first', 'most-specific-last', 'identity-with-one-argument',
  'operator', 'order', 'required', 'arguments', 'generic-function', 'method-combination', 'argument-precedence-order',
  'method', 'rehash-size', 'rehash-threshold', 'weakness', 'junk-allowed', 'radix', 'preserve-whitespace', 'eof-error-p',
  'case', 'upcase', 'downcase', 'capitalize', 'preserve', 'invert', 'wild', 'wild-inferiors', 'relative', 'absolute', 'newest',
  'unspecific', 'host', 'device', 'directory', 'name', 'defaults', 'abort', 'force', 'verbose', 'print', 'if-exists', 'stream',
];

// ---------------------------------------------------------------------------
// Helpers

function rangeOf(parse: ParseResult, start: number, end: number): Range {
  return Range.create(positionAt(parse, start), positionAt(parse, end));
}

function nameRange(parse: ParseResult, def: Definition): Range {
  return rangeOf(parse, def.nameRange[0], def.nameRange[1]);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]#<>|~]/g, (m) => `\\${m}`);
}

/** Docstring text as markdown paragraphs; single newlines are reflowed. */
export function docToMarkdown(doc: string): string {
  return doc
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => escapeMarkdown(paragraph.replace(/\s*\n\s*/g, ' ').trim()))
    .join('\n\n');
}

function basename(uri: string): string {
  const decoded = decodeURIComponent(uri);
  return decoded.slice(decoded.lastIndexOf('/') + 1);
}

function definerFor(kind: DefKind): string {
  switch (kind) {
    case 'function':
      return 'defun';
    case 'macro':
      return 'defmacro';
    case 'generic':
      return 'defgeneric';
    case 'method':
      return 'defmethod';
    case 'variable':
      return 'defvar';
    case 'constant':
      return 'defconstant';
    case 'symbol-macro':
      return 'define-symbol-macro';
    case 'class':
      return 'defclass';
    case 'condition':
      return 'define-condition';
    case 'struct':
      return 'defstruct';
    case 'type':
      return 'deftype';
    case 'package':
      return 'defpackage';
    case 'system':
      return 'defsystem';
    case 'setf':
      return 'defsetf';
    case 'slot':
      return 'slot';
    case 'accessor':
      return 'accessor';
    default:
      return 'definition';
  }
}

function signatureOf(def: Definition): string {
  switch (def.kind) {
    case 'function':
    case 'macro':
    case 'generic':
    case 'method':
    case 'type':
    case 'setf':
    case 'accessor':
      return def.lambdaList ? `(${def.label} ${def.lambdaList.slice(1)}` : `(${def.label})`;
    default:
      return def.label;
  }
}

function definitionMarkdown(found: FoundDefinition): string {
  const { def, file } = found;
  const line = lineOf(file.parse, def.range[0]) + 1;
  const parts = [`\`\`\`lisp\n${signatureOf(def)}\n\`\`\``];
  const what = def.detail ? `${definerFor(def.kind)} ${escapeMarkdown(def.detail)}` : definerFor(def.kind);
  const where = `${escapeMarkdown(basename(file.uri))}:${line}`;
  parts.push(`*${what}* in ${def.pkg ? `\`${def.pkg.toLowerCase()}\` · ` : ''}${where}`);
  if (def.docstring) parts.push(docToMarkdown(def.docstring));
  return parts.join('\n\n');
}

function standardMarkdown(symbol: StdSymbol, hyperspecBase: string): string {
  const parts: string[] = [];
  if (isCallable(symbol)) {
    const arglist = symbol.arglist ?? '()';
    parts.push(`\`\`\`lisp\n(${symbol.name}${arglist.length > 2 ? ` ${arglist.slice(1)}` : ')'}\n\`\`\``);
  } else {
    parts.push(`\`\`\`lisp\n${symbol.name}\n\`\`\``);
  }
  const kinds = symbol.kinds.map(kindLabel).join(', ');
  const url = hyperspecUrl(symbol, hyperspecBase);
  parts.push(`*${kinds}* in \`common-lisp\`${url ? ` · [HyperSpec](${url})` : ''}`);
  const doc = primaryDoc(symbol);
  if (doc) parts.push(docToMarkdown(doc));
  if (symbol.doc) {
    for (const [key, text] of Object.entries(symbol.doc)) {
      if (text !== doc) parts.push(`*As ${key}:* ${docToMarkdown(text)}`);
    }
  }
  return parts.join('\n\n');
}

function markdown(value: string): MarkupContent {
  return { kind: MarkupKind.Markdown, value };
}

function isStandardPackage(pkg: string | null): boolean {
  return pkg === null || pkg === 'CL' || pkg === 'COMMON-LISP' || pkg === 'CL-USER' || pkg === 'COMMON-LISP-USER';
}

function innermostBinding(bindings: Binding[], name: string): Binding | undefined {
  let best: Binding | undefined;
  for (const b of bindings) {
    if (b.name === name && (!best || b.scopeStart >= best.scopeStart)) best = b;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Diagnostics

export function diagnostics(file: IndexedFile): Diagnostic[] {
  return file.parse.errors.map((error) => ({
    range: rangeOf(file.parse, error.start, Math.max(error.end, error.start + 1)),
    message: error.message,
    severity: DiagnosticSeverity.Error,
    source: 'moro',
  }));
}

// ---------------------------------------------------------------------------
// Hover

export function hover(ctx: ServerContext, file: IndexedFile, position: Position): Hover | null {
  const parse = file.parse;
  const offset = offsetOf(parse, position);
  const symbol = symbolAt(parse, offset);
  if (!symbol) return null;
  const sections: string[] = [];

  if (symbol.kind === 'keyword') {
    const pkgDefs = ctx.index.findDefinitions(symbol.name).filter((f) => f.def.kind === 'package' || f.def.kind === 'system');
    for (const found of pkgDefs.slice(0, 3)) sections.push(definitionMarkdown(found));
    if (!sections.length) return null;
    return { contents: markdown(sections.join('\n\n---\n\n')), range: rangeOf(parse, symbol.start, symbol.end) };
  }

  const local = innermostBinding(bindingsAt(parse, offset), symbol.name);
  if (local && !symbol.pkg) {
    sections.push(`\`\`\`lisp\n${local.label}\n\`\`\`\n\n*local ${local.kind}*`);
  }
  const defs = ctx.index.findDefinitions(symbol.name, symbol.pkg);
  for (const found of defs.slice(0, 4)) sections.push(definitionMarkdown(found));
  if (isStandardPackage(symbol.pkg)) {
    const standard = lookupStandard(symbol.name);
    if (standard) sections.push(standardMarkdown(standard, ctx.hyperspecBase));
  }
  if (!sections.length) return null;
  return { contents: markdown(sections.join('\n\n---\n\n')), range: rangeOf(parse, symbol.nameStart, symbol.end) };
}

export function offsetOf(parse: ParseResult, position: Position): number {
  const starts = parse.lineStarts;
  if (position.line >= starts.length) return parse.text.length;
  const lineStart = starts[position.line];
  const nextStart = position.line + 1 < starts.length ? starts[position.line + 1] : parse.text.length + 1;
  return Math.min(lineStart + position.character, nextStart - 1, parse.text.length);
}

// ---------------------------------------------------------------------------
// Completion

interface CompletionData {
  source: 'std' | 'ws';
  name: string;
  pkg?: string | null;
}

function completionKind(kind: DefKind): CompletionItemKind {
  switch (kind) {
    case 'function':
    case 'setf':
      return CompletionItemKind.Function;
    case 'macro':
      return CompletionItemKind.Keyword;
    case 'generic':
      return CompletionItemKind.Interface;
    case 'method':
      return CompletionItemKind.Method;
    case 'variable':
    case 'symbol-macro':
      return CompletionItemKind.Variable;
    case 'constant':
      return CompletionItemKind.Constant;
    case 'class':
    case 'condition':
      return CompletionItemKind.Class;
    case 'struct':
      return CompletionItemKind.Struct;
    case 'type':
      return CompletionItemKind.TypeParameter;
    case 'package':
    case 'system':
      return CompletionItemKind.Module;
    case 'slot':
      return CompletionItemKind.Field;
    case 'accessor':
      return CompletionItemKind.Property;
    default:
      return CompletionItemKind.Value;
  }
}

function standardCompletionKind(symbol: StdSymbol): CompletionItemKind {
  const kind = symbol.kinds[0];
  switch (kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'generic-function':
      return CompletionItemKind.Interface;
    case 'macro':
    case 'special-operator':
      return CompletionItemKind.Keyword;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'constant':
      return CompletionItemKind.Constant;
    case 'class':
      return CompletionItemKind.Class;
    case 'type':
      return CompletionItemKind.TypeParameter;
    case 'lambda-list-keyword':
      return CompletionItemKind.Operator;
    case 'declaration':
      return CompletionItemKind.Keyword;
    default:
      return CompletionItemKind.Text;
  }
}

/** Matches the case of what the user typed: all-caps prefix gives an all-caps name. */
function matchCase(prefix: string, name: string): string {
  const letters = prefix.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 0 && letters === letters.toUpperCase()) return name.toUpperCase();
  return name.toLowerCase();
}

export function completion(ctx: ServerContext, file: IndexedFile, position: Position): CompletionList {
  const parse = file.parse;
  const text = parse.text;
  const offset = offsetOf(parse, position);
  let tokenStart = offset;
  while (tokenStart > 0 && isConstituent(text[tokenStart - 1]) && text[tokenStart - 1] !== '|') tokenStart--;
  // `#'foo` and `#:foo` keep the # as part of the token for our purposes
  if (tokenStart >= 2 && text[tokenStart - 2] === '#' && (text[tokenStart - 1] === "'" || text[tokenStart - 1] === ':')) tokenStart -= 2;
  const prefix = text.slice(tokenStart, offset);
  const replaceRange = rangeOf(parse, tokenStart, offset);
  const items: CompletionItem[] = [];

  const push = (label: string, insert: string, kind: CompletionItemKind, sortText: string, detail?: string, data?: CompletionData, filterText?: string) => {
    items.push({
      label,
      kind,
      detail,
      sortText,
      filterText: filterText ?? insert,
      textEdit: TextEdit.replace(replaceRange, insert),
      insertTextFormat: InsertTextFormat.PlainText,
      data,
    });
  };

  // Keywords: `:foo`
  if (prefix.startsWith(':')) {
    const seen = new Set<string>();
    for (const keyword of ctx.index.allKeywords()) seen.add(keyword.toLowerCase());
    for (const keyword of COMMON_KEYWORDS) seen.add(keyword);
    for (const pkg of ctx.index.allPackages()) seen.add(pkg.toLowerCase());
    for (const keyword of seen) push(`:${keyword}`, `:${matchCase(prefix, keyword)}`, CompletionItemKind.EnumMember, `1${keyword}`);
    return CompletionList.create(items, false);
  }

  // Uninterned symbols in defpackage: `#:foo`
  if (prefix.startsWith('#:')) {
    const seen = new Set<string>();
    for (const found of ctx.index.allDefinitions()) {
      if (seen.has(found.def.name)) continue;
      seen.add(found.def.name);
      push(`#:${found.def.label}`, `#:${matchCase(prefix.slice(2), found.def.name)}`, completionKind(found.def.kind), `1${found.def.name}`);
    }
    for (const pkg of ctx.index.allPackages()) {
      if (!seen.has(pkg)) push(`#:${pkg.toLowerCase()}`, `#:${matchCase(prefix.slice(2), pkg)}`, CompletionItemKind.Module, `0${pkg}`);
    }
    return CompletionList.create(items, false);
  }

  // Lambda-list keywords: `&opt`
  if (prefix.startsWith('&')) {
    for (const keyword of LAMBDA_LIST_KEYWORDS) push(keyword.toLowerCase(), matchCase(prefix, keyword), CompletionItemKind.Operator, `0${keyword}`);
    return CompletionList.create(items, false);
  }

  const functionQuote = prefix.startsWith("#'");
  const bare = functionQuote ? prefix.slice(2) : prefix;
  const colon = bare.indexOf(':');

  // Package-qualified: `pkg:na` or `pkg::na`
  if (colon > 0) {
    const pkgText = bare.slice(0, colon);
    let rest = bare.slice(colon + 1);
    let separator = ':';
    if (rest.startsWith(':')) {
      separator = '::';
      rest = rest.slice(1);
    }
    const pkgName = pkgText.toUpperCase();
    const lead = `${functionQuote ? "#'" : ''}${pkgText}${separator}`;
    if (pkgName === 'CL' || pkgName === 'COMMON-LISP') {
      for (const symbol of allStandard()) {
        push(symbol.name, `${lead}${matchCase(rest, symbol.name)}`, standardCompletionKind(symbol), `2${symbol.name}`, symbol.arglist, { source: 'std', name: symbol.name });
      }
    } else {
      for (const [name, found] of ctx.index.symbolsInPackage(pkgName)) {
        const label = found ? found.def.label : name.toLowerCase();
        push(label, `${lead}${matchCase(rest, name)}`, found ? completionKind(found.def.kind) : CompletionItemKind.Value, `1${name}`, found?.def.lambdaList, { source: 'ws', name, pkg: pkgName });
      }
    }
    return CompletionList.create(items, false);
  }

  const lead = functionQuote ? "#'" : '';

  // Local bindings
  const seen = new Set<string>();
  for (const binding of bindingsAt(parse, offset).reverse()) {
    if (seen.has(binding.name)) continue;
    seen.add(binding.name);
    const kind = binding.kind === 'function' || binding.kind === 'macro' ? CompletionItemKind.Function : CompletionItemKind.Variable;
    push(binding.label, `${lead}${binding.label}`, kind, `0${binding.name}`, `local ${binding.kind}`);
  }

  // Loop keywords inside a loop form
  const list = enclosingList(parse, offset);
  if (list && headName(list) === 'LOOP') {
    for (const keyword of LOOP_KEYWORDS) push(keyword, `${lead}${matchCase(bare, keyword)}`, CompletionItemKind.Keyword, `1${keyword}`, 'loop keyword');
  }

  // Workspace definitions
  const wsSeen = new Set<string>();
  for (const found of ctx.index.allDefinitions()) {
    const { def } = found;
    if (def.kind === 'slot' || wsSeen.has(def.name) || seen.has(def.name)) continue;
    wsSeen.add(def.name);
    push(def.label, `${lead}${matchCase(bare, def.name)}`, completionKind(def.kind), `1${def.name}`, def.lambdaList ?? def.detail ?? definerFor(def.kind), { source: 'ws', name: def.name, pkg: def.pkg });
  }

  // Standard symbols
  for (const symbol of allStandard()) {
    if (seen.has(symbol.name.toUpperCase())) continue;
    push(symbol.name, `${lead}${matchCase(bare, symbol.name)}`, standardCompletionKind(symbol), `2${symbol.name}`, symbol.arglist ?? symbol.kinds.map(kindLabel).join(', '), { source: 'std', name: symbol.name });
  }

  return CompletionList.create(items, false);
}

export function resolveCompletion(ctx: ServerContext, item: CompletionItem): CompletionItem {
  const data = item.data as CompletionData | undefined;
  if (!data) return item;
  if (data.source === 'std') {
    const symbol = lookupStandard(data.name);
    if (symbol) item.documentation = markdown(standardMarkdown(symbol, ctx.hyperspecBase));
  } else {
    const found = ctx.index.findDefinitions(data.name, data.pkg ?? null)[0];
    if (found) item.documentation = markdown(definitionMarkdown(found));
  }
  return item;
}

// ---------------------------------------------------------------------------
// Signature help

interface ArglistSource {
  head: string;
  arglist: string;
  documentation?: string;
  detail?: string;
}

function arglistsFor(ctx: ServerContext, head: AtomNode): ArglistSource[] {
  const out: ArglistSource[] = [];
  const defs = ctx.index.findDefinitions(head.name, head.pkg).filter((f) => f.def.lambdaList);
  for (const found of defs.slice(0, 6)) {
    out.push({ head: head.text, arglist: found.def.lambdaList!, documentation: found.def.docstring, detail: found.def.detail });
  }
  if (isStandardPackage(head.pkg)) {
    const standard = lookupStandard(head.name);
    if (standard && standard.arglist && isCallable(standard)) {
      out.push({ head: head.text, arglist: standard.arglist, documentation: primaryDoc(standard) });
    }
  }
  return out;
}

export function signatureHelp(ctx: ServerContext, file: IndexedFile, position: Position): SignatureHelp | null {
  const parse = file.parse;
  const offset = offsetOf(parse, position);
  let list = enclosingList(parse, offset);
  let sources: ArglistSource[] = [];
  let hops = 0;
  while (list && hops < 3) {
    const head = headSymbol(list);
    if (head && head.end <= offset) {
      sources = arglistsFor(ctx, head);
      if (sources.length) break;
    }
    list = list.parent;
    hops++;
  }
  if (!list || !sources.length) return null;

  const args = list.children.slice(1);
  const argIndex = args.filter((arg) => arg.end <= offset).length;
  const previous = args[argIndex - 1];
  const previousKeyword = previous && previous.kind === 'keyword' && previous.end <= offset ? previous.name : null;

  const signatures: SignatureInformation[] = sources.map((source) => {
    const parsed = parseLambdaList(source.arglist);
    const lead = `(${source.head} `;
    const label = `${lead}${source.arglist.slice(1)}`;
    const shift = lead.length - 1;
    const parameters = parsed.parameters.map((p) => ParameterInformation.create([p.start + shift, p.end + shift]));
    const active = activeParameter(parsed.parameters, argIndex, previousKeyword);
    const info = SignatureInformation.create(label, undefined, ...parameters);
    if (source.documentation) info.documentation = markdown(docToMarkdown(source.documentation));
    if (active !== null) info.activeParameter = active;
    else info.activeParameter = parameters.length; // nothing highlighted
    return info;
  });
  return { signatures, activeSignature: 0, activeParameter: signatures[0]?.activeParameter ?? 0 };
}

// ---------------------------------------------------------------------------
// Definitions, references, highlights, rename

function definitionLinks(found: FoundDefinition[], origin?: Range): LocationLink[] {
  return found.map(({ file, def }) =>
    LocationLink.create(file.uri, rangeOf(file.parse, def.range[0], def.range[1]), nameRange(file.parse, def), origin),
  );
}

export function definition(ctx: ServerContext, file: IndexedFile, position: Position): LocationLink[] {
  const parse = file.parse;
  const offset = offsetOf(parse, position);
  const symbol = symbolAt(parse, offset);
  if (!symbol) return [];
  const origin = rangeOf(parse, symbol.nameStart, symbol.end);
  if (symbol.kind === 'keyword') {
    const found = ctx.index.findDefinitions(symbol.name).filter((f) => f.def.kind === 'package' || f.def.kind === 'system');
    return definitionLinks(found, origin);
  }
  if (!symbol.pkg) {
    const local = innermostBinding(bindingsAt(parse, offset), symbol.name);
    if (local && local.node !== symbol) {
      return [LocationLink.create(file.uri, rangeOf(parse, local.node.start, local.node.end), rangeOf(parse, local.node.nameStart, local.node.end), origin)];
    }
  }
  return definitionLinks(ctx.index.findDefinitions(symbol.name, symbol.pkg), origin);
}

export function references(ctx: ServerContext, file: IndexedFile, position: Position): Location[] {
  const parse = file.parse;
  const symbol = symbolAt(parse, offsetOf(parse, position));
  if (!symbol) return [];
  return ctx.index
    .findOccurrences(symbol.name, symbol.kind === 'keyword')
    .map(({ file: f, occurrence }) => Location.create(f.uri, rangeOf(f.parse, occurrence.nameStart, occurrence.end)));
}

export function documentHighlights(file: IndexedFile, position: Position): DocumentHighlight[] {
  const parse = file.parse;
  const symbol = symbolAt(parse, offsetOf(parse, position));
  if (!symbol) return [];
  const occurrences = file.analysis.occurrences.get(symbol.name) ?? [];
  return occurrences
    .filter((o) => (o.node.kind === 'keyword') === (symbol.kind === 'keyword'))
    .map((o) => DocumentHighlight.create(rangeOf(parse, o.nameStart, o.end), DocumentHighlightKind.Text));
}

export function prepareRename(file: IndexedFile, position: Position): { range: Range; placeholder: string } | null {
  const parse = file.parse;
  const symbol = symbolAt(parse, offsetOf(parse, position));
  if (!symbol || !symbol.name) return null;
  return { range: rangeOf(parse, symbol.nameStart, symbol.end), placeholder: parse.text.slice(symbol.nameStart, symbol.end) };
}

export function rename(ctx: ServerContext, file: IndexedFile, position: Position, newName: string): WorkspaceEdit | null {
  const parse = file.parse;
  const symbol = symbolAt(parse, offsetOf(parse, position));
  if (!symbol || !symbol.name) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const { file: f, occurrence } of ctx.index.findOccurrences(symbol.name, symbol.kind === 'keyword')) {
    const original = f.parse.text.slice(occurrence.nameStart, occurrence.end);
    const letters = original.replace(/[^a-zA-Z]/g, '');
    const replacement = letters.length > 0 && letters === letters.toUpperCase() ? newName.toUpperCase() : newName;
    (changes[f.uri] ??= []).push(TextEdit.replace(rangeOf(f.parse, occurrence.nameStart, occurrence.end), replacement));
  }
  return { changes };
}

// ---------------------------------------------------------------------------
// Symbols

function symbolKind(kind: DefKind): SymbolKind {
  switch (kind) {
    case 'function':
    case 'macro':
    case 'setf':
      return SymbolKind.Function;
    case 'generic':
      return SymbolKind.Interface;
    case 'method':
      return SymbolKind.Method;
    case 'variable':
    case 'symbol-macro':
      return SymbolKind.Variable;
    case 'constant':
      return SymbolKind.Constant;
    case 'class':
    case 'condition':
      return SymbolKind.Class;
    case 'struct':
      return SymbolKind.Struct;
    case 'type':
      return SymbolKind.TypeParameter;
    case 'package':
      return SymbolKind.Package;
    case 'system':
      return SymbolKind.Module;
    case 'slot':
      return SymbolKind.Field;
    case 'accessor':
      return SymbolKind.Property;
    default:
      return SymbolKind.Object;
  }
}

function toDocumentSymbol(parse: ParseResult, def: Definition): DocumentSymbol {
  const range = rangeOf(parse, def.range[0], def.range[1]);
  let selection = nameRange(parse, def);
  if (def.nameRange[0] < def.range[0] || def.nameRange[1] > def.range[1]) selection = range;
  const detail = def.kind === 'macro' ? `macro ${def.lambdaList ?? ''}`.trim() : def.detail ?? def.lambdaList;
  const symbol = DocumentSymbol.create(def.label, detail, symbolKind(def.kind), range, selection);
  if (def.children?.length) symbol.children = def.children.map((child) => toDocumentSymbol(parse, child));
  return symbol;
}

export function documentSymbols(file: IndexedFile): DocumentSymbol[] {
  return file.analysis.definitions.map((def) => toDocumentSymbol(file.parse, def));
}

function fuzzyMatches(query: string, candidate: string): boolean {
  if (candidate.includes(query)) return true;
  let i = 0;
  for (const ch of candidate) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return i === query.length;
}

export function workspaceSymbols(ctx: ServerContext, query: string): SymbolInformation[] {
  const q = query.toLowerCase();
  const out: SymbolInformation[] = [];
  for (const { file, def } of ctx.index.allDefinitions()) {
    const label = def.label.toLowerCase();
    if (q && !fuzzyMatches(q, label)) continue;
    out.push(SymbolInformation.create(def.label, symbolKind(def.kind), nameRange(file.parse, def), file.uri, def.detail ?? def.pkg?.toLowerCase()));
    if (out.length >= 500) break;
  }
  out.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Folding and selection ranges

export function foldingRanges(file: IndexedFile): FoldingRange[] {
  const parse = file.parse;
  const out: FoldingRange[] = [];
  walk(parse.forms, (node) => {
    if (node.kind !== 'list' || out.length >= 5000) return;
    const startLine = lineOf(parse, node.formStart);
    const endLine = lineOf(parse, Math.max(node.formStart, node.end - 1));
    if (endLine > startLine) out.push(FoldingRange.create(startLine, endLine, undefined, undefined, FoldingRangeKind.Region));
  });
  let runStart = -1;
  let runEnd = -1;
  const flushRun = () => {
    if (runStart >= 0 && runEnd > runStart) out.push(FoldingRange.create(runStart, runEnd, undefined, undefined, FoldingRangeKind.Comment));
    runStart = -1;
    runEnd = -1;
  };
  for (const comment of parse.comments) {
    const startLine = lineOf(parse, comment.start);
    const endLine = lineOf(parse, Math.max(comment.start, comment.end - 1));
    if (comment.kind === 'block') {
      flushRun();
      if (endLine > startLine) out.push(FoldingRange.create(startLine, endLine, undefined, undefined, FoldingRangeKind.Comment));
      continue;
    }
    const lineStart = parse.lineStarts[startLine];
    const onlyComment = parse.text.slice(lineStart, comment.start).trim() === '';
    if (!onlyComment) {
      flushRun();
      continue;
    }
    if (runStart >= 0 && startLine === runEnd + 1) {
      runEnd = startLine;
    } else {
      flushRun();
      runStart = startLine;
      runEnd = startLine;
    }
  }
  flushRun();
  return out;
}

export function selectionRanges(file: IndexedFile, positions: Position[]): SelectionRange[] {
  const parse = file.parse;
  return positions.map((position) => {
    const offset = offsetOf(parse, position);
    const chain: Range[] = [];
    let node: Node | null = nodeAt(parse, offset);
    if (node && node.kind !== 'list' && node.nameStart > node.formStart && offset >= node.nameStart) {
      chain.push(rangeOf(parse, node.nameStart, node.end));
    }
    while (node) {
      if (node.kind === 'list' && isInsideList(node, offset) && node.children.length) {
        const first = node.children[0];
        const last = node.children[node.children.length - 1];
        if (first.start <= offset && offset <= last.end) chain.push(rangeOf(parse, first.start, last.end));
      }
      if (node.kind === 'list' && node.prefix) chain.push(rangeOf(parse, node.formStart, node.end));
      chain.push(rangeOf(parse, node.start, node.end));
      node = node.parent;
    }
    const unique: Range[] = [];
    for (const range of chain) {
      const prev = unique[unique.length - 1];
      if (!prev || prev.start.line !== range.start.line || prev.start.character !== range.start.character || prev.end.line !== range.end.line || prev.end.character !== range.end.character) {
        unique.push(range);
      }
    }
    let result: SelectionRange | undefined;
    for (const range of unique.reverse()) result = SelectionRange.create(range, result);
    return result ?? SelectionRange.create(Range.create(position, position));
  });
}

// ---------------------------------------------------------------------------
// Semantic tokens

interface Token {
  start: number;
  length: number;
  type: number;
  modifiers: number;
  /** Higher wins when two tokens start at the same offset. */
  priority?: number;
}

export function semanticTokens(ctx: ServerContext, file: IndexedFile): SemanticTokens {
  const parse = file.parse;
  const tokens: Token[] = [];
  const typeIndex = (name: string) => SEMANTIC_TOKEN_TYPES.indexOf(name);
  const declaration = 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf('declaration');

  const bindings = allBindings(parse);
  const byName = new Map<string, Binding[]>();
  for (const binding of bindings) {
    (byName.get(binding.name) ?? byName.set(binding.name, []).get(binding.name)!).push(binding);
    const type = binding.kind === 'function' ? 'function' : binding.kind === 'macro' ? 'macro' : binding.kind === 'parameter' ? 'parameter' : 'variable';
    tokens.push({ start: binding.node.nameStart, length: binding.node.end - binding.node.nameStart, type: typeIndex(type), modifiers: declaration });
  }
  for (const [name, list] of byName) {
    for (const occurrence of file.analysis.occurrences.get(name) ?? []) {
      if (occurrence.node.kind === 'keyword' || occurrence.pkg) continue;
      if (list.some((b) => b.node === occurrence.node)) continue;
      let best: Binding | undefined;
      for (const b of list) {
        if (b.scopeStart <= occurrence.start && occurrence.start <= b.scopeEnd && (!best || b.scopeStart >= best.scopeStart)) best = b;
      }
      if (!best) continue;
      const type = best.kind === 'function' ? 'function' : best.kind === 'macro' ? 'macro' : best.kind === 'parameter' ? 'parameter' : 'variable';
      tokens.push({ start: occurrence.nameStart, length: occurrence.end - occurrence.nameStart, type: typeIndex(type), modifiers: 0 });
    }
  }

  // Calls to workspace-defined functions and macros.
  const kindCache = new Map<string, 'function' | 'macro' | null>();
  const workspaceKind = (name: string, pkg: string | null): 'function' | 'macro' | null => {
    const key = `${pkg ?? ''}::${name}`;
    const cached = kindCache.get(key);
    if (cached !== undefined) return cached;
    let kind: 'function' | 'macro' | null = null;
    if (!(isStandardPackage(pkg) && lookupStandard(name))) {
      for (const found of ctx.index.findDefinitions(name, pkg)) {
        if (found.def.kind === 'macro') {
          kind = 'macro';
          break;
        }
        if (found.def.kind === 'function' || found.def.kind === 'generic' || found.def.kind === 'method' || found.def.kind === 'accessor' || found.def.kind === 'setf') kind = 'function';
      }
    }
    kindCache.set(key, kind);
    return kind;
  };
  const localNames = new Set(bindings.filter((b) => b.kind === 'function' || b.kind === 'macro').map((b) => b.name));
  walk(parse.forms, (node) => {
    if (node.kind !== 'list') return;
    const head = headSymbol(node);
    if (!head || localNames.has(head.name)) return;
    const kind = workspaceKind(head.name, head.pkg);
    if (kind) tokens.push({ start: head.nameStart, length: head.end - head.nameStart, type: typeIndex(kind), modifiers: 0 });
    if (head.name === 'FUNCTION' && isSymbol(node.children[1]) && node.children[1].kind === 'symbol') {
      const fn = node.children[1];
      if (workspaceKind(fn.name, fn.pkg) === 'function') tokens.push({ start: fn.nameStart, length: fn.end - fn.nameStart, type: typeIndex('function'), modifiers: 0 });
    }
  });
  walk(parse.forms, (node) => {
    if (node.kind === 'symbol' && node.prefix.endsWith("#'") && workspaceKind(node.name, node.pkg) === 'function') {
      tokens.push({ start: node.nameStart, length: node.end - node.nameStart, type: typeIndex('function'), modifiers: 0 });
    }
  });

  // Symbols used as types: handler-case / typecase clauses, declarations, the,
  // check-type, quoted type arguments, specializers, slot :type, loop of-type.
  const typeIdx = typeIndex('type');
  for (const position of typePositions(parse)) {
    tokens.push({ start: position.start, length: position.end - position.start, type: typeIdx, modifiers: 0, priority: 1 });
  }

  tokens.sort((a, b) => a.start - b.start || (b.priority ?? 0) - (a.priority ?? 0) || b.modifiers - a.modifiers);
  const builder = new SemanticTokensBuilder();
  let lastEnd = -1;
  for (const token of tokens) {
    if (token.start < lastEnd || token.length <= 0) continue;
    const position = positionAt(parse, token.start);
    const endLine = lineOf(parse, token.start + token.length - 1);
    if (endLine !== position.line) continue;
    builder.push(position.line, position.character, token.length, token.type, token.modifiers);
    lastEnd = token.start + token.length;
  }
  return builder.build();
}

export { ListNode, isList };
