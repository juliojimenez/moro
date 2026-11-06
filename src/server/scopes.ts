/**
 * Lexical bindings: which local variables, parameters and local functions are
 * visible at a position. Used for completion and semantic highlighting.
 */
import {
  AtomNode,
  ListNode,
  Node,
  ParseResult,
  LAMBDA_LIST_KEYWORDS,
  headName,
  isInsideList,
  isList,
  isSymbol,
  nodeAt,
  walk,
} from '../common/reader';

export type BindingKind = 'variable' | 'parameter' | 'function' | 'macro' | 'symbol-macro';

export interface Binding {
  /** Normalized name. */
  name: string;
  /** Name as written. */
  label: string;
  kind: BindingKind;
  node: AtomNode;
  scopeStart: number;
  scopeEnd: number;
}

interface LetLike {
  sequential: boolean;
  kind: BindingKind;
}

const LET_LIKE = new Map<string, LetLike>([
  ['LET', { sequential: false, kind: 'variable' }],
  ['LET*', { sequential: true, kind: 'variable' }],
  ['PROG', { sequential: false, kind: 'variable' }],
  ['PROG*', { sequential: true, kind: 'variable' }],
  ['COMPILER-LET', { sequential: false, kind: 'variable' }],
  ['SYMBOL-MACROLET', { sequential: false, kind: 'symbol-macro' }],
]);

/** Forms with a lambda list as their third element: (op name lambda-list . body). */
const NAMED_LAMBDA = new Set([
  'DEFUN', 'DEFMACRO', 'DEFTYPE', 'DEFINE-COMPILER-MACRO', 'DEFINE-SETF-EXPANDER', 'DEFINE-MODIFY-MACRO', 'DEFGENERIC',
]);
/** Operators whose lambda lists destructure (lists in required position are nested patterns). */
const DESTRUCTURING = new Set(['DEFMACRO', 'DEFINE-COMPILER-MACRO', 'DEFTYPE', 'DEFINE-SETF-EXPANDER', 'MACROLET', 'DESTRUCTURING-BIND']);
const LOCAL_FUNCTIONS = new Map<string, BindingKind>([
  ['FLET', 'function'],
  ['LABELS', 'function'],
  ['MACROLET', 'macro'],
]);
const DO_LIKE = new Set(['DOLIST', 'DOTIMES', 'DO-SYMBOLS', 'DO-EXTERNAL-SYMBOLS', 'DO-ALL-SYMBOLS']);
const SLOT_MACROS = new Set(['WITH-SLOTS', 'WITH-ACCESSORS']);
const LOOP_VAR_INTRODUCERS = new Set(['FOR', 'AS', 'WITH', 'INTO']);

export interface LambdaListOptions {
  destructuring?: boolean;
  specialized?: boolean;
}

function binding(node: AtomNode, kind: BindingKind, scopeStart: number, scopeEnd: number): Binding {
  return { name: node.name, label: node.text, kind, node, scopeStart, scopeEnd };
}

function isVariableSymbol(node: Node | undefined): node is AtomNode {
  return isSymbol(node) && node.kind === 'symbol' && !!node.name && node.name !== '.' && !LAMBDA_LIST_KEYWORDS.has(node.name) && node.name !== 'NIL' && node.name !== 'T';
}

/** Variables bound by a lambda list (ordinary, specialized, macro or destructuring). */
export function lambdaListBindings(lambdaList: ListNode, scopeStart: number, scopeEnd: number, options: LambdaListOptions = {}): Binding[] {
  const out: Binding[] = [];
  let section: 'required' | 'optional' | 'rest' | 'key' | 'aux' | 'single' = 'required';
  for (const param of lambdaList.children) {
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
        case '&WHOLE':
        case '&ENVIRONMENT':
          section = 'single';
          break;
        default:
          break;
      }
      continue;
    }
    if (isVariableSymbol(param)) {
      out.push(binding(param, 'parameter', scopeStart, scopeEnd));
      continue;
    }
    if (!isList(param)) continue;
    const [first, , third] = param.children;
    switch (section) {
      case 'required':
      case 'rest':
        if (options.destructuring) {
          out.push(...lambdaListBindings(param, scopeStart, scopeEnd, options));
        } else if (isVariableSymbol(first)) {
          out.push(binding(first, 'parameter', scopeStart, scopeEnd)); // (var specializer)
        }
        break;
      case 'optional':
      case 'aux':
        if (isVariableSymbol(first)) out.push(binding(first, 'parameter', scopeStart, scopeEnd));
        else if (isList(first) && options.destructuring) out.push(...lambdaListBindings(first, scopeStart, scopeEnd, options));
        if (isVariableSymbol(third)) out.push(binding(third, 'parameter', scopeStart, scopeEnd));
        break;
      case 'key': {
        if (isVariableSymbol(first)) {
          out.push(binding(first, 'parameter', scopeStart, scopeEnd));
        } else if (isList(first)) {
          const variable = first.children[1];
          if (isVariableSymbol(variable)) out.push(binding(variable, 'parameter', scopeStart, scopeEnd));
          else if (isList(variable) && options.destructuring) out.push(...lambdaListBindings(variable, scopeStart, scopeEnd, options));
        }
        if (isVariableSymbol(third)) out.push(binding(third, 'parameter', scopeStart, scopeEnd));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Variables in a destructuring pattern used by LOOP (`with (a b) = ...`). */
function patternVariables(node: Node, kind: BindingKind, scopeStart: number, scopeEnd: number): Binding[] {
  if (isVariableSymbol(node)) return [binding(node, kind, scopeStart, scopeEnd)];
  if (isList(node)) return node.children.flatMap((child) => patternVariables(child, kind, scopeStart, scopeEnd));
  return [];
}

function letBindings(list: ListNode, spec: LetLike): Binding[] {
  const bindings = list.children[1];
  if (!isList(bindings)) return [];
  const out: Binding[] = [];
  for (const entry of bindings.children) {
    const variable = isList(entry) ? entry.children[0] : entry;
    if (!isVariableSymbol(variable)) continue;
    const scopeStart = spec.sequential ? entry.end : bindings.end;
    out.push(binding(variable, spec.kind, scopeStart, list.end));
  }
  return out;
}

function localFunctionBindings(list: ListNode, head: string, kind: BindingKind): Binding[] {
  const definitions = list.children[1];
  if (!isList(definitions)) return [];
  const out: Binding[] = [];
  const namesVisibleFrom = head === 'FLET' ? definitions.end : definitions.start;
  for (const definition of definitions.children) {
    if (!isList(definition)) continue;
    const [name, lambdaList] = definition.children;
    if (isVariableSymbol(name)) out.push(binding(name, kind, namesVisibleFrom, list.end));
    if (isList(lambdaList)) {
      out.push(...lambdaListBindings(lambdaList, lambdaList.end, definition.end, { destructuring: head === 'MACROLET' }));
    }
  }
  return out;
}

function loopBindings(list: ListNode): Binding[] {
  const out: Binding[] = [];
  const children = list.children;
  let lastIntroducer: string | null = null;
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    if (!isSymbol(child)) continue;
    const word = child.name;
    if (LOOP_VAR_INTRODUCERS.has(word) || (word === 'AND' && lastIntroducer !== null && lastIntroducer !== 'INTO')) {
      if (word !== 'AND') lastIntroducer = word;
      const target = children[i + 1];
      if (target) out.push(...patternVariables(target, 'variable', list.formStart, list.end));
      i++;
    } else if (word === 'NAMED') {
      i++;
    } else if (!['=', 'IN', 'ON', 'ACROSS', 'BEING', 'THE', 'EACH', 'FROM', 'TO', 'UPTO', 'BELOW', 'DOWNTO', 'ABOVE', 'BY', 'UPFROM', 'DOWNFROM', 'OF-TYPE', 'THEN', 'USING', 'OF'].includes(word)) {
      // a main clause keyword (do, collect, when, ...) ends the iteration-variable context for AND
      if (['DO', 'DOING', 'COLLECT', 'COLLECTING', 'APPEND', 'APPENDING', 'NCONC', 'NCONCING', 'SUM', 'SUMMING', 'COUNT', 'COUNTING',
        'MAXIMIZE', 'MAXIMIZING', 'MINIMIZE', 'MINIMIZING', 'WHEN', 'IF', 'UNLESS', 'WHILE', 'UNTIL', 'ALWAYS', 'NEVER', 'THEREIS',
        'RETURN', 'INITIALLY', 'FINALLY', 'REPEAT'].includes(word)) {
        lastIntroducer = null;
      }
    }
  }
  return out;
}

/** The bindings introduced by one list form, with their scopes. */
export function bindingsOf(list: ListNode): Binding[] {
  const head = headName(list);
  if (!head) return [];
  const children = list.children;

  const letLike = LET_LIKE.get(head);
  if (letLike) return letBindings(list, letLike);

  const localKind = LOCAL_FUNCTIONS.get(head);
  if (localKind) return localFunctionBindings(list, head, localKind);

  if (head === 'LAMBDA') {
    const lambdaList = children[1];
    return isList(lambdaList) ? lambdaListBindings(lambdaList, lambdaList.end, list.end) : [];
  }
  if (NAMED_LAMBDA.has(head)) {
    const lambdaList = children[2];
    return isList(lambdaList) ? lambdaListBindings(lambdaList, lambdaList.end, list.end, { destructuring: DESTRUCTURING.has(head) }) : [];
  }
  if (head === 'DEFMETHOD') {
    let i = 2;
    while (i < children.length && !isList(children[i])) i++;
    const lambdaList = children[i];
    return isList(lambdaList) ? lambdaListBindings(lambdaList, lambdaList.end, list.end, { specialized: true }) : [];
  }
  if (head === 'DESTRUCTURING-BIND') {
    const pattern = children[1];
    const valuesForm = children[2];
    return isList(pattern) ? lambdaListBindings(pattern, (valuesForm ?? pattern).end, list.end, { destructuring: true }) : [];
  }
  if (head === 'MULTIPLE-VALUE-BIND') {
    const variables = children[1];
    const valuesForm = children[2];
    if (!isList(variables)) return [];
    return variables.children.filter(isVariableSymbol).map((v) => binding(v, 'variable', (valuesForm ?? variables).end, list.end));
  }
  if (head === 'DO' || head === 'DO*') {
    const specs = children[1];
    if (!isList(specs)) return [];
    const out: Binding[] = [];
    for (const spec of specs.children) {
      const variable = isList(spec) ? spec.children[0] : spec;
      if (isVariableSymbol(variable)) out.push(binding(variable, 'variable', head === 'DO*' ? spec.end : specs.end, list.end));
    }
    return out;
  }
  if (DO_LIKE.has(head)) {
    const spec = children[1];
    if (!isList(spec)) return [];
    const variable = spec.children[0];
    return isVariableSymbol(variable) ? [binding(variable, 'variable', spec.end, list.end)] : [];
  }
  if (head === 'LOOP') return loopBindings(list);
  if (head === 'HANDLER-CASE') {
    const out: Binding[] = [];
    for (const clause of children.slice(2)) {
      if (!isList(clause)) continue;
      const lambdaList = clause.children[1];
      if (isList(lambdaList)) out.push(...lambdaListBindings(lambdaList, lambdaList.end, clause.end));
    }
    return out;
  }
  if (head === 'RESTART-CASE') {
    const out: Binding[] = [];
    for (const clause of children.slice(2)) {
      if (!isList(clause)) continue;
      const lambdaList = clause.children[1];
      if (isList(lambdaList)) out.push(...lambdaListBindings(lambdaList, lambdaList.end, clause.end));
    }
    return out;
  }
  if (SLOT_MACROS.has(head)) {
    const specs = children[1];
    const instance = children[2];
    if (!isList(specs)) return [];
    const out: Binding[] = [];
    for (const spec of specs.children) {
      const variable = isList(spec) ? spec.children[0] : spec;
      if (isVariableSymbol(variable)) out.push(binding(variable, 'variable', (instance ?? specs).end, list.end));
    }
    return out;
  }
  if (head.startsWith('WITH-') || head === 'PPRINT-LOGICAL-BLOCK') {
    const spec = children[1];
    if (!isList(spec)) return [];
    const first = spec.children[0];
    if (isVariableSymbol(first)) return [binding(first, 'variable', spec.end, list.end)];
    if (isList(first)) {
      // LET-shaped bindings: (with-foo ((a 1) (b 2)) ...)
      const out: Binding[] = [];
      for (const entry of spec.children) {
        const variable = isList(entry) ? entry.children[0] : entry;
        if (isVariableSymbol(variable)) out.push(binding(variable, 'variable', spec.end, list.end));
      }
      return out;
    }
    return [];
  }
  return [];
}

/** Bindings visible at `offset`, outermost first. */
export function bindingsAt(result: ParseResult, offset: number): Binding[] {
  const node = nodeAt(result, offset);
  if (!node) return [];
  const chain: ListNode[] = [];
  let list: ListNode | null = node.kind === 'list' && isInsideList(node, offset) ? node : node.parent;
  while (list) {
    chain.push(list);
    list = list.parent;
  }
  chain.reverse();
  const out: Binding[] = [];
  for (const ancestor of chain) {
    for (const b of bindingsOf(ancestor)) {
      if (b.scopeStart <= offset && offset <= b.scopeEnd) out.push(b);
    }
  }
  return out;
}

/** Every binding in the file (for semantic tokens). */
export function allBindings(result: ParseResult): Binding[] {
  const out: Binding[] = [];
  walk(result.forms, (node) => {
    if (node.kind === 'list') out.push(...bindingsOf(node));
  });
  return out;
}
