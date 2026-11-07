/**
 * Static analysis of one parsed file: the definitions it contains (for the
 * outline, workspace symbols, go to definition, hover and completion), every
 * symbol occurrence (for references, rename and highlights) and the keywords
 * it uses (for completion).
 */
import {
  AtomNode,
  ListNode,
  Node,
  ParseResult,
  designatorName,
  headName,
  stringContent,
  isList,
  isSymbol,
  textOf,
  walk,
  LAMBDA_LIST_KEYWORDS,
} from '../common/reader';

export type DefKind =
  | 'function'
  | 'macro'
  | 'generic'
  | 'method'
  | 'variable'
  | 'constant'
  | 'symbol-macro'
  | 'class'
  | 'condition'
  | 'struct'
  | 'type'
  | 'package'
  | 'system'
  | 'setf'
  | 'slot'
  | 'accessor'
  | 'other';

export interface Definition {
  /** Normalized (upper-case) name without package. */
  name: string;
  /** Name as written, e.g. "my-fn" or "(setf my-fn)". */
  label: string;
  kind: DefKind;
  /** Extra context: method qualifiers and specializers, the defining macro for 'other', ... */
  detail?: string;
  /** Offsets of the whole defining form. */
  range: [number, number];
  /** Offsets of the name token. */
  nameRange: [number, number];
  /** Lambda list text with whitespace collapsed, e.g. "(x &optional (y 2))". */
  lambdaList?: string;
  docstring?: string;
  /** Package in effect (closest preceding in-package), normalized, or null. */
  pkg: string | null;
  /** Exported symbol names for packages. */
  exports?: string[];
  /** The other defpackage options that decide which package a symbol belongs to. */
  packageOptions?: PackageOptions;
  /** Lower-case system names an ASDF system depends on (including :defsystem-depends-on). */
  dependsOn?: string[];
  children?: Definition[];
}

/** Normalized names from a defpackage / define-package form. */
export interface PackageOptions {
  nicknames: string[];
  /** :use, and uiop's :mix, :use-reexport, :mix-reexport. */
  uses: string[];
  /** :shadow and :shadowing-import-from names: always this package's own symbols. */
  shadows: string[];
  /** :import-from and :shadowing-import-from: symbol name -> source package. */
  imports: Array<[name: string, source: string]>;
  /** :local-nicknames: nickname -> package. */
  localNicknames: Array<[nickname: string, pkg: string]>;
  /** Packages whose exports this one re-exports (:reexport, :use-reexport, :mix-reexport). */
  reexports: string[];
}

/** What a symbol occurrence denotes when it is not a plain reference. */
export type OccurrenceRole = 'package' | 'export' | 'import';

export interface Occurrence {
  name: string;
  pkg: string | null;
  start: number;
  end: number;
  nameStart: number;
  node: AtomNode;
  /** 'package' for package designators, 'export' for names in a defpackage's own lists, 'import' for imported names. */
  role?: OccurrenceRole;
  /** The package an 'export' belongs to or an 'import' comes from. */
  source?: string;
}

export interface PackageTransition {
  /** Offset from which `pkg` is the current package. */
  offset: number;
  pkg: string;
}

export interface FileAnalysis {
  definitions: Definition[];
  /** Every definition including children, in source order. */
  flat: Definition[];
  occurrences: Map<string, Occurrence[]>;
  /** Normalized keyword names used in the file. */
  keywords: Set<string>;
  /** Normalized names of packages defined in the file. */
  packages: string[];
  /** Lower-case system names loaded with ql:quickload, asdf:load-system and friends. */
  requestedSystems: string[];
  /** The (in-package ...) forms in order: the current package from each offset on. */
  packageTransitions: PackageTransition[];
}

/** The current package at `offset`: the closest preceding in-package, or null. */
export function packageAtOffset(analysis: FileAnalysis, offset: number): string | null {
  const transitions = analysis.packageTransitions;
  let lo = 0;
  let hi = transitions.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (transitions[mid].offset <= offset) {
      found = transitions[mid].pkg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

interface Ctx {
  result: ParseResult;
  pkg: string | null;
  definitions: Definition[];
  flat: Definition[];
  requestedSystems: Set<string>;
  packageTransitions: PackageTransition[];
}

const PACKAGE_DEFINERS = new Set(['DEFPACKAGE', 'DEFINE-PACKAGE']);
/** defpackage options whose elements name packages rather than symbols. */
const PACKAGE_LIST_OPTIONS = new Set(['USE', 'MIX', 'USE-REEXPORT', 'MIX-REEXPORT', 'REEXPORT', 'NICKNAMES', 'LOCAL-NICKNAMES', 'DOCUMENTATION']);
/** defpackage options whose elements are this package's own symbols. */
const OWN_SYMBOL_OPTIONS = new Set(['EXPORT', 'INTERN', 'SHADOW']);
const IMPORT_OPTIONS = new Set(['IMPORT-FROM', 'SHADOWING-IMPORT-FROM']);

/** The role of a symbol occurrence inside defpackage / in-package forms, if any. */
function occurrenceRole(node: AtomNode): { role: OccurrenceRole; source?: string } | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const parentHead = headName(parent);
  if (parentHead === 'IN-PACKAGE' && parent.children[1] === node) return { role: 'package' };
  if (parentHead && PACKAGE_DEFINERS.has(parentHead) && parent.children[1] === node) return { role: 'package' };
  // An option list of a defpackage: (:export #:a) or, for local nicknames, (:local-nicknames (#:nick #:pkg)).
  const option = parent.children[0] === node ? undefined : parent;
  const form = option?.parent;
  if (option && form && isList(form)) {
    const formHead = headName(form);
    const key = headName(option);
    if (formHead && PACKAGE_DEFINERS.has(formHead) && key) {
      if (PACKAGE_LIST_OPTIONS.has(key)) return { role: 'package' };
      if (OWN_SYMBOL_OPTIONS.has(key)) {
        const pkg = designatorName(form.children[1]);
        return { role: 'export', source: pkg ?? undefined };
      }
      if (IMPORT_OPTIONS.has(key)) {
        if (option.children[1] === node) return { role: 'package' };
        const source = designatorName(option.children[1]);
        return { role: 'import', source: source ?? undefined };
      }
    }
    // (:local-nicknames (nick pkg) ...): both elements of each pair are package designators.
    const grand = form.parent;
    if (grand && headName(form) === 'LOCAL-NICKNAMES' && isList(grand)) {
      const grandHead = headName(grand);
      if (grandHead && PACKAGE_DEFINERS.has(grandHead)) return { role: 'package' };
    }
  }
  return undefined;
}

/** (ql:quickload ...), (asdf:load-system ...) and friends: operator name -> accepted package prefixes. */
const SYSTEM_LOADERS = new Map<string, Set<string | null>>([
  ['QUICKLOAD', new Set(['QL', 'QUICKLISP', 'QUICKLISP-CLIENT'])],
  ['LOAD-SYSTEM', new Set(['ASDF', null])],
  ['LOAD-SYSTEMS', new Set(['ASDF', null])],
  ['REQUIRE-SYSTEM', new Set(['ASDF', null])],
  ['TEST-SYSTEM', new Set(['ASDF', null])],
  ['OPERATE', new Set(['ASDF'])],
  ['OOS', new Set(['ASDF'])],
]);

const FUNCTION_LIKE = new Map<string, DefKind>([
  ['DEFUN', 'function'],
  ['DEFMACRO', 'macro'],
  ['DEFINE-COMPILER-MACRO', 'macro'],
  ['DEFINE-MODIFY-MACRO', 'macro'],
  ['DEFTYPE', 'type'],
  ['DEFINE-SETF-EXPANDER', 'setf'],
]);

const VARIABLE_LIKE = new Map<string, DefKind>([
  ['DEFVAR', 'variable'],
  ['DEFPARAMETER', 'variable'],
  ['DEFCONSTANT', 'constant'],
  ['DEFINE-SYMBOL-MACRO', 'symbol-macro'],
]);

/** Forms whose bodies are scanned for nested top-level definitions. */
const RECURSE_INTO = new Set(['PROGN', 'EVAL-WHEN', 'LOCALLY', 'LET', 'LET*', 'FLET', 'LABELS', 'MACROLET', 'SYMBOL-MACROLET']);
const RECURSE_SKIP_FIRST = new Set(['EVAL-WHEN', 'LET', 'LET*', 'FLET', 'LABELS', 'MACROLET', 'SYMBOL-MACROLET']);

export function analyze(result: ParseResult): FileAnalysis {
  const ctx: Ctx = { result, pkg: null, definitions: [], flat: [], requestedSystems: new Set(), packageTransitions: [] };
  for (const form of result.forms) visitTopLevel(ctx, form);
  walk(result.forms, (node) => {
    if (node.kind === 'list') collectRequestedSystems(ctx, node);
  });

  const occurrences = new Map<string, Occurrence[]>();
  const keywords = new Set<string>();
  walk(result.forms, (node) => {
    if (node.kind !== 'symbol' && node.kind !== 'keyword') return;
    if (!node.name) return;
    if (node.kind === 'keyword') keywords.add(node.name);
    let list = occurrences.get(node.name);
    if (!list) {
      list = [];
      occurrences.set(node.name, list);
    }
    const occurrence: Occurrence = { name: node.name, pkg: node.pkg, start: node.start, end: node.end, nameStart: node.nameStart, node };
    const role = node.kind === 'symbol' ? occurrenceRole(node) : undefined;
    if (role) {
      occurrence.role = role.role;
      if (role.source) occurrence.source = role.source;
    }
    list.push(occurrence);
  });

  return {
    definitions: ctx.definitions,
    flat: ctx.flat,
    occurrences,
    keywords,
    packages: ctx.flat.filter((d) => d.kind === 'package').map((d) => d.name),
    requestedSystems: [...ctx.requestedSystems].sort(),
    packageTransitions: ctx.packageTransitions,
  };
}

/** System names named by a string, keyword, symbol or quoted list of those. */
function systemNames(node: Node | undefined): string[] {
  if (!node) return [];
  const datum = isList(node) && headName(node) === 'QUOTE' ? node.children[1] : node;
  if (!datum) return [];
  if (isList(datum)) return datum.children.flatMap((child) => (isList(child) ? [] : systemNames(child)));
  if (datum.kind === 'string' || datum.kind === 'symbol' || datum.kind === 'keyword') {
    const name = designatorName(datum);
    return name ? [name.toLowerCase()] : [];
  }
  return [];
}

function collectRequestedSystems(ctx: Ctx, list: ListNode): void {
  const head = list.children[0];
  if (!isSymbol(head) || head.kind !== 'symbol') return;
  const packages = SYSTEM_LOADERS.get(head.name);
  if (!packages || !packages.has(head.pkg)) return;
  // (asdf:operate 'asdf:load-op "name") and (asdf:oos 'load-op "name") name the system second.
  const argument = head.name === 'OPERATE' || head.name === 'OOS' ? list.children[2] : list.children[1];
  for (const name of systemNames(argument)) ctx.requestedSystems.add(name);
}

function visitTopLevel(ctx: Ctx, form: Node): void {
  if (!isList(form)) return;
  const head = headName(form);
  if (!head) return;
  if (head === 'IN-PACKAGE') {
    const name = designatorName(form.children[1]);
    if (name) {
      ctx.pkg = name;
      ctx.packageTransitions.push({ offset: form.end, pkg: name });
    }
    return;
  }
  if (RECURSE_INTO.has(head)) {
    const from = RECURSE_SKIP_FIRST.has(head) ? 2 : 1;
    for (const child of form.children.slice(from)) visitTopLevel(ctx, child);
    return;
  }
  const def = definitionFor(ctx, form, head);
  if (def) {
    ctx.definitions.push(def);
    ctx.flat.push(def);
    if (def.children) ctx.flat.push(...def.children);
  }
}

interface NameInfo {
  name: string;
  label: string;
  nameRange: [number, number];
}

/** Name information for a symbol, a `(setf name)` list, or a `(name options...)` list. */
function nameInfo(node: Node | undefined): NameInfo | null {
  if (!node) return null;
  if (node.kind === 'symbol' || node.kind === 'keyword') {
    if (!node.name) return null;
    // Label without the #: or : prefix (and without any package prefix).
    return { name: node.name, label: node.text.slice(node.nameStart - node.formStart), nameRange: [node.nameStart, node.end] };
  }
  if (node.kind === 'string') {
    const name = designatorName(node);
    if (!name) return null;
    return { name, label: stringContent(node.text), nameRange: [node.formStart + 1, Math.max(node.formStart + 1, node.end - 1)] };
  }
  if (node.kind === 'list') {
    const [first, second] = node.children;
    if (isSymbol(first) && first.name === 'SETF' && isSymbol(second) && second.name) {
      return { name: second.name, label: `(setf ${second.text})`, nameRange: [second.nameStart, second.end] };
    }
    if (isSymbol(first) && first.name) {
      return { name: first.name, label: first.text, nameRange: [first.nameStart, first.end] };
    }
  }
  return null;
}

/** Name of the first element of an option list, whether it is a symbol or a keyword. */
function optionKey(node: Node | undefined): string | null {
  if (!isList(node)) return null;
  const first = node.children[0];
  return isSymbol(first) ? first.name : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lambdaListText(ctx: Ctx, node: Node | undefined): string | undefined {
  if (!node || node.kind !== 'list') return undefined;
  return collapse(textOf(ctx.result, node));
}

export function unescapeString(raw: string): string {
  let body = raw.startsWith('"') ? raw.slice(1) : raw;
  if (body.endsWith('"') && !body.endsWith('\\"')) body = body.slice(0, -1);
  return body.replace(/\\(.)/gs, '$1');
}

/** Docstring in body position: the first string, skipping declarations, when more forms follow. */
function docstringFrom(children: Node[], from: number): string | undefined {
  let i = from;
  while (i < children.length && isList(children[i]) && headName(children[i]) === 'DECLARE') i++;
  const node = children[i];
  if (node && node.kind === 'string' && i + 1 < children.length) return unescapeString(node.text);
  return undefined;
}

/** `(:documentation "...")` among the options starting at `from`. */
function optionDoc(children: Node[], from: number): string | undefined {
  for (let i = from; i < children.length; i++) {
    const option = children[i];
    if (isList(option) && optionKey(option) === 'DOCUMENTATION') {
      const value = option.children[1];
      if (value && value.kind === 'string') return unescapeString(value.text);
    }
  }
  return undefined;
}

function makeDef(ctx: Ctx, form: ListNode, info: NameInfo, kind: DefKind, extra: Partial<Definition> = {}): Definition {
  return {
    name: info.name,
    label: info.label,
    kind,
    range: [form.start, form.end],
    nameRange: info.nameRange,
    pkg: ctx.pkg,
    ...extra,
  };
}

function definitionFor(ctx: Ctx, form: ListNode, head: string): Definition | null {
  const children = form.children;
  const functionKind = FUNCTION_LIKE.get(head);
  if (functionKind) {
    const info = nameInfo(children[1]);
    if (!info) return null;
    return makeDef(ctx, form, info, functionKind, {
      lambdaList: lambdaListText(ctx, children[2]),
      docstring: docstringFrom(children, 3),
    });
  }
  const variableKind = VARIABLE_LIKE.get(head);
  if (variableKind) {
    const info = nameInfo(children[1]);
    if (!info || !isSymbol(children[1])) return null;
    const doc = children[3];
    return makeDef(ctx, form, info, variableKind, {
      docstring: doc && doc.kind === 'string' ? unescapeString(doc.text) : undefined,
    });
  }
  switch (head) {
    case 'DEFGENERIC': {
      const info = nameInfo(children[1]);
      if (!info) return null;
      return makeDef(ctx, form, info, 'generic', {
        lambdaList: lambdaListText(ctx, children[2]),
        docstring: optionDoc(children, 3),
      });
    }
    case 'DEFMETHOD':
      return methodDefinition(ctx, form);
    case 'DEFCLASS':
    case 'DEFINE-CONDITION':
      return classDefinition(ctx, form, head === 'DEFCLASS' ? 'class' : 'condition');
    case 'DEFSTRUCT':
      return structDefinition(ctx, form);
    case 'DEFPACKAGE':
    case 'DEFINE-PACKAGE':
      return packageDefinition(ctx, form);
    case 'DEFSYSTEM':
      return systemDefinition(ctx, form);
    case 'DEFSETF': {
      const info = nameInfo(children[1]);
      if (!info) return null;
      const long = isList(children[2]);
      return makeDef(ctx, form, info, 'setf', {
        lambdaList: long ? lambdaListText(ctx, children[2]) : undefined,
        docstring: long ? docstringFrom(children, 4) : children[3]?.kind === 'string' ? unescapeString((children[3] as AtomNode).text) : undefined,
      });
    }
    case 'DEFINE-METHOD-COMBINATION': {
      const info = nameInfo(children[1]);
      if (!info) return null;
      return makeDef(ctx, form, info, 'other', { detail: 'method combination' });
    }
    default:
      break;
  }
  if (head.startsWith('DEF')) {
    const info = nameInfo(children[1]);
    if (!info) return null;
    return makeDef(ctx, form, info, 'other', { detail: head.toLowerCase() });
  }
  return null;
}

function methodDefinition(ctx: Ctx, form: ListNode): Definition | null {
  const children = form.children;
  const info = nameInfo(children[1]);
  if (!info) return null;
  let i = 2;
  const qualifiers: string[] = [];
  while (i < children.length && !isList(children[i])) {
    qualifiers.push(textOf(ctx.result, children[i]));
    i++;
  }
  const lambdaList = children[i];
  const specializers: string[] = [];
  if (isList(lambdaList)) {
    for (const param of lambdaList.children) {
      if (isSymbol(param) && LAMBDA_LIST_KEYWORDS.has(param.name)) break;
      if (isList(param)) {
        const spec = param.children[1];
        specializers.push(spec ? collapse(textOf(ctx.result, spec)) : 't');
      } else {
        specializers.push('t');
      }
    }
  }
  const detailParts = [...qualifiers];
  if (specializers.length) detailParts.push(`(${specializers.join(' ')})`);
  return makeDef(ctx, form, info, 'method', {
    detail: detailParts.join(' ') || undefined,
    lambdaList: lambdaListText(ctx, lambdaList),
    docstring: docstringFrom(children, i + 1),
  });
}

function classDefinition(ctx: Ctx, form: ListNode, kind: 'class' | 'condition'): Definition | null {
  const children = form.children;
  const info = nameInfo(children[1]);
  if (!info || !isSymbol(children[1])) return null;
  const def = makeDef(ctx, form, info, kind, { docstring: optionDoc(children, 4) });
  const slots = children[3];
  if (isList(slots)) {
    const kids: Definition[] = [];
    for (const slot of slots.children) {
      const slotInfo = nameInfo(slot);
      if (!slotInfo) continue;
      const slotForm = isList(slot) ? slot : form;
      kids.push({
        name: slotInfo.name,
        label: slotInfo.label,
        kind: 'slot',
        detail: `slot of ${info.label}`,
        range: [slot.start, slot.end],
        nameRange: slotInfo.nameRange,
        pkg: ctx.pkg,
      });
      if (isList(slot)) {
        const opts = slotForm.children;
        for (let j = 1; j + 1 < opts.length; j += 2) {
          const key = opts[j];
          const value = opts[j + 1];
          if (!isSymbol(key) || key.kind !== 'keyword') continue;
          if (key.name !== 'ACCESSOR' && key.name !== 'READER' && key.name !== 'WRITER') continue;
          const accessor = nameInfo(value);
          if (!accessor) continue;
          kids.push({
            name: accessor.name,
            label: accessor.label,
            kind: 'accessor',
            detail: `${key.name.toLowerCase()} of ${info.label}`,
            range: [slot.start, slot.end],
            nameRange: accessor.nameRange,
            pkg: ctx.pkg,
            lambdaList: key.name === 'WRITER' ? `(new-value ${info.label.toLowerCase()})` : `(${info.label.toLowerCase()})`,
          });
        }
      }
    }
    if (kids.length) def.children = kids;
  }
  return def;
}

function structDefinition(ctx: Ctx, form: ListNode): Definition | null {
  const children = form.children;
  const spec = children[1];
  if (!spec) return null;
  let nameNode: Node | undefined;
  const options: Node[] = [];
  if (isList(spec)) {
    nameNode = spec.children[0];
    options.push(...spec.children.slice(1));
  } else {
    nameNode = spec;
  }
  const info = nameInfo(nameNode);
  if (!info || !isSymbol(nameNode)) return null;

  let concName = `${nameNode.text}-`;
  let constructors: string[] | null = null;
  let predicate: string | null = `${nameNode.text}-p`;
  let copier: string | null = `copy-${nameNode.text}`;
  for (const option of options) {
    const key = isList(option) ? optionKey(option) : isSymbol(option) ? option.name : null;
    const arg = isList(option) ? option.children[1] : undefined;
    const argText = arg ? designatorName(arg) : undefined;
    const argIsNil = !arg || (isSymbol(arg) && arg.name === 'NIL');
    switch (key) {
      case 'CONC-NAME':
        concName = argIsNil ? '' : (arg && isSymbol(arg) ? arg.text : (argText ?? '').toLowerCase());
        break;
      case 'CONSTRUCTOR':
        if (!isList(option)) break;
        if (argIsNil && arg) {
          constructors = constructors ?? [];
        } else if (arg && isSymbol(arg)) {
          constructors = [...(constructors ?? []), arg.text];
        }
        break;
      case 'PREDICATE':
        if (isList(option)) predicate = argIsNil ? null : arg && isSymbol(arg) ? arg.text : predicate;
        break;
      case 'COPIER':
        if (isList(option)) copier = argIsNil ? null : arg && isSymbol(arg) ? arg.text : copier;
        break;
      default:
        break;
    }
  }
  if (constructors === null) constructors = [`make-${nameNode.text}`];

  const kids: Definition[] = [];
  let slotStart = 2;
  const doc = children[2];
  let docstring: string | undefined;
  if (doc && doc.kind === 'string') {
    docstring = unescapeString(doc.text);
    slotStart = 3;
  }
  for (const slot of children.slice(slotStart)) {
    const slotInfo = nameInfo(slot);
    if (!slotInfo) continue;
    kids.push({
      name: slotInfo.name,
      label: slotInfo.label,
      kind: 'slot',
      detail: `slot of ${info.label}`,
      range: [slot.start, slot.end],
      nameRange: slotInfo.nameRange,
      pkg: ctx.pkg,
    });
    const accessorLabel = `${concName}${slotInfo.label}`;
    kids.push({
      name: accessorLabel.toUpperCase(),
      label: accessorLabel,
      kind: 'accessor',
      detail: `accessor of ${info.label}`,
      range: [slot.start, slot.end],
      nameRange: slotInfo.nameRange,
      pkg: ctx.pkg,
      lambdaList: `(${info.label.toLowerCase()})`,
    });
  }
  for (const ctor of constructors) {
    kids.push({
      name: ctor.toUpperCase(),
      label: ctor,
      kind: 'function',
      detail: `constructor of ${info.label}`,
      range: [form.start, form.end],
      nameRange: info.nameRange,
      pkg: ctx.pkg,
      lambdaList: `(&key ${children.slice(slotStart).map((s) => nameInfo(s)?.label).filter(Boolean).join(' ')})`,
    });
  }
  if (predicate) {
    kids.push({ name: predicate.toUpperCase(), label: predicate, kind: 'function', detail: `predicate of ${info.label}`, range: [form.start, form.end], nameRange: info.nameRange, pkg: ctx.pkg, lambdaList: '(object)' });
  }
  if (copier) {
    kids.push({ name: copier.toUpperCase(), label: copier, kind: 'function', detail: `copier of ${info.label}`, range: [form.start, form.end], nameRange: info.nameRange, pkg: ctx.pkg, lambdaList: `(${info.label.toLowerCase()})` });
  }
  return makeDef(ctx, form, info, 'struct', { docstring, children: kids.length ? kids : undefined });
}

function designatorNames(nodes: Node[]): string[] {
  return nodes.map((node) => designatorName(node)).filter((name): name is string => !!name);
}

function packageDefinition(ctx: Ctx, form: ListNode): Definition | null {
  const children = form.children;
  const info = nameInfo(children[1]);
  if (!info) return null;
  const exports: string[] = [];
  const options: PackageOptions = { nicknames: [], uses: [], shadows: [], imports: [], localNicknames: [], reexports: [] };
  for (const option of children.slice(2)) {
    if (!isList(option)) continue;
    const key = optionKey(option);
    const rest = option.children.slice(1);
    switch (key) {
      case 'EXPORT':
        exports.push(...designatorNames(rest));
        break;
      case 'NICKNAMES':
        options.nicknames.push(...designatorNames(rest));
        break;
      case 'USE':
      case 'MIX':
        options.uses.push(...designatorNames(rest));
        break;
      case 'USE-REEXPORT':
      case 'MIX-REEXPORT':
        options.uses.push(...designatorNames(rest));
        options.reexports.push(...designatorNames(rest));
        break;
      case 'REEXPORT':
        options.reexports.push(...designatorNames(rest));
        break;
      case 'SHADOW':
        options.shadows.push(...designatorNames(rest));
        break;
      case 'IMPORT-FROM':
      case 'SHADOWING-IMPORT-FROM': {
        const source = designatorName(rest[0]);
        if (!source) break;
        const names = designatorNames(rest.slice(1));
        for (const name of names) options.imports.push([name, source]);
        if (key === 'SHADOWING-IMPORT-FROM') options.shadows.push(...names);
        break;
      }
      case 'LOCAL-NICKNAMES':
        for (const pair of rest) {
          if (!isList(pair)) continue;
          const nickname = designatorName(pair.children[0]);
          const pkg = designatorName(pair.children[1]);
          if (nickname && pkg) options.localNicknames.push([nickname, pkg]);
        }
        break;
      default:
        break;
    }
  }
  return makeDef(ctx, form, info, 'package', { docstring: optionDoc(children, 2), exports, packageOptions: options });
}

/** Names in a :depends-on list: strings, symbols, (:version name "1.0"), (:feature expr name). */
function dependencyNames(node: Node | undefined): string[] {
  if (!isList(node)) return [];
  const out: string[] = [];
  for (const item of node.children) {
    if (isList(item)) {
      const head = headName(item);
      const name = head === 'VERSION' ? designatorName(item.children[1]) : head === 'FEATURE' ? designatorName(item.children[2]) : null;
      if (name) out.push(name.toLowerCase());
      continue;
    }
    const name = designatorName(item);
    if (name) out.push(name.toLowerCase());
  }
  return out;
}

function systemDefinition(ctx: Ctx, form: ListNode): Definition | null {
  const children = form.children;
  const info = nameInfo(children[1]);
  if (!info) return null;
  let docstring: string | undefined;
  const dependsOn: string[] = [];
  for (let i = 2; i + 1 < children.length; i++) {
    const key = children[i];
    const value = children[i + 1];
    if (!isSymbol(key) || key.kind !== 'keyword') continue;
    if (key.name === 'DESCRIPTION' && value.kind === 'string') docstring = unescapeString(value.text);
    if (key.name === 'DEPENDS-ON' || key.name === 'DEFSYSTEM-DEPENDS-ON') dependsOn.push(...dependencyNames(value));
  }
  return makeDef(ctx, form, info, 'system', { docstring, detail: 'ASDF system', dependsOn: [...new Set(dependsOn)] });
}
