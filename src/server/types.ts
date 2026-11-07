/**
 * Finds the places where a symbol names a type rather than a function or a
 * variable: handler-case and typecase clauses, declarations, THE, CHECK-TYPE,
 * quoted type arguments of TYPEP, COERCE, MAKE-INSTANCE and friends,
 * defmethod specializers, slot :type options and LOOP's of-type.
 *
 * The TextMate grammar colors `error`, `string` or `list` as functions wherever
 * they appear in head position; these positions let the semantic token
 * provider correct that (issue #1).
 */
import { AtomNode, ListNode, Node, ParseResult, headName, headSymbol, isList, isSymbol, walk, LAMBDA_LIST_KEYWORDS } from '../common/reader';

export interface TypePosition {
  node: AtomNode;
  start: number;
  end: number;
}

/** Symbols that are types but already colored as language constants. */
const NOT_TOKENIZED = new Set(['T', 'NIL', '*', 'OTHERWISE']);
/** Compound specifiers whose arguments are objects, not types. */
const VALUE_HEADS = new Set(['MEMBER', 'EQL', 'SATISFIES']);
/** Compound specifiers whose arguments are bounds or sizes. */
const BOUNDS_HEADS = new Set([
  'INTEGER', 'RATIONAL', 'REAL', 'FLOAT', 'SINGLE-FLOAT', 'DOUBLE-FLOAT', 'SHORT-FLOAT', 'LONG-FLOAT', 'MOD', 'SIGNED-BYTE',
  'UNSIGNED-BYTE', 'STRING', 'SIMPLE-STRING', 'BASE-STRING', 'SIMPLE-BASE-STRING', 'BIT-VECTOR', 'SIMPLE-BIT-VECTOR', 'SIMPLE-VECTOR',
]);
/** Compound specifiers whose first argument is an element type. */
const ELEMENT_TYPE_HEADS = new Set(['ARRAY', 'SIMPLE-ARRAY', 'VECTOR', 'COMPLEX']);
const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
const DECLARATION_IDENTIFIERS = new Set(['OPTIMIZE', 'IGNORE', 'IGNORABLE', 'INLINE', 'NOTINLINE', 'SPECIAL', 'DYNAMIC-EXTENT', 'DECLARATION']);

/** Functions whose Nth argument (1-based, after the head) is a type when written quoted. */
const QUOTED_TYPE_ARGUMENTS = new Map<string, number[]>([
  ['TYPEP', [2]],
  ['SUBTYPEP', [1, 2]],
  ['COERCE', [2]],
  ['MAKE-INSTANCE', [1]],
  ['MAKE-CONDITION', [1]],
  ['CHANGE-CLASS', [2]],
  ['FIND-CLASS', [1]],
  ['MAKE-SEQUENCE', [1]],
  ['CONCATENATE', [1]],
  ['MAP', [1]],
  ['MERGE', [1]],
  ['SIGNAL', [1]],
  ['ERROR', [1]],
  ['WARN', [1]],
  ['CERROR', [2]],
]);

function isQuoted(node: Node): boolean {
  if (node.prefix.endsWith("'") && !node.prefix.endsWith("#'")) return true;
  return isList(node) && headName(node) === 'QUOTE';
}

function unquote(node: Node): Node | undefined {
  if (isList(node) && headName(node) === 'QUOTE') return node.children[1];
  return node;
}

function isTypeSymbol(node: Node | undefined): node is AtomNode {
  return isSymbol(node) && node.kind === 'symbol' && !!node.name && !NOT_TOKENIZED.has(node.name) && !LAMBDA_LIST_KEYWORDS.has(node.name);
}

function push(out: TypePosition[], node: AtomNode): void {
  out.push({ node, start: node.nameStart, end: node.end });
}

/** Records every type name inside a type specifier. */
export function typeSpecifier(node: Node | undefined, out: TypePosition[]): void {
  if (!node) return;
  const datum = unquote(node);
  if (!datum) return;
  if (isTypeSymbol(datum)) {
    push(out, datum);
    return;
  }
  if (!isList(datum)) return;
  const head = headSymbol(datum);
  if (!head) return;
  const args = datum.children.slice(1);
  if (COMBINATORS.has(head.name)) {
    for (const arg of args) typeSpecifier(arg, out);
    return;
  }
  if (isTypeSymbol(head)) push(out, head);
  if (VALUE_HEADS.has(head.name) || BOUNDS_HEADS.has(head.name)) return;
  if (ELEMENT_TYPE_HEADS.has(head.name)) {
    typeSpecifier(args[0], out);
    return;
  }
  if (head.name === 'CONS') {
    typeSpecifier(args[0], out);
    typeSpecifier(args[1], out);
    return;
  }
  if (head.name === 'FUNCTION') {
    const argTypes = args[0];
    if (isList(argTypes)) {
      for (const arg of argTypes.children) typeSpecifier(arg, out);
    }
    typeSpecifier(args[1], out);
    return;
  }
  // VALUES and user-defined compound types: symbol and list arguments are types.
  for (const arg of args) {
    if (isTypeSymbol(arg) || isList(arg)) typeSpecifier(arg, out);
  }
}

function declarationSpecifier(spec: Node, out: TypePosition[]): void {
  if (!isList(spec)) return;
  const head = headSymbol(spec);
  if (!head) return;
  if (head.name === 'TYPE' || head.name === 'FTYPE') {
    typeSpecifier(spec.children[1], out);
    return;
  }
  if (DECLARATION_IDENTIFIERS.has(head.name)) return;
  // (declare (fixnum x y)) is shorthand for (declare (type fixnum x y)).
  typeSpecifier(head, out);
}

function slotTypes(slots: Node | undefined, out: TypePosition[]): void {
  if (!isList(slots)) return;
  for (const slot of slots.children) {
    if (!isList(slot)) continue;
    // defclass slots are (name . options); defstruct slots are (name default . options).
    const options = slot.children;
    for (let i = 1; i + 1 < options.length; i++) {
      const key = options[i];
      if (isSymbol(key) && key.kind === 'keyword' && key.name === 'TYPE') typeSpecifier(options[i + 1], out);
    }
  }
}

function listPositions(list: ListNode, out: TypePosition[]): void {
  const head = headName(list);
  if (!head) return;
  const children = list.children;
  switch (head) {
    case 'THE':
      typeSpecifier(children[1], out);
      return;
    case 'CHECK-TYPE':
      typeSpecifier(children[2], out);
      return;
    case 'DECLARE':
    case 'DECLAIM':
      for (const spec of children.slice(1)) declarationSpecifier(spec, out);
      return;
    case 'PROCLAIM': {
      const spec = children[1] ? unquote(children[1]) : undefined;
      if (spec) declarationSpecifier(spec, out);
      return;
    }
    case 'TYPECASE':
    case 'ETYPECASE':
    case 'CTYPECASE':
      for (const clause of children.slice(2)) {
        if (isList(clause)) typeSpecifier(clause.children[0], out);
      }
      return;
    case 'HANDLER-CASE':
      for (const clause of children.slice(2)) {
        if (isList(clause) && !(isSymbol(clause.children[0]) && clause.children[0].kind === 'keyword')) typeSpecifier(clause.children[0], out);
      }
      return;
    case 'HANDLER-BIND': {
      const bindings = children[1];
      if (isList(bindings)) {
        for (const binding of bindings.children) {
          if (isList(binding)) typeSpecifier(binding.children[0], out);
        }
      }
      return;
    }
    case 'DEFMETHOD': {
      let i = 2;
      while (i < children.length && !isList(children[i])) i++;
      const lambdaList = children[i];
      if (!isList(lambdaList)) return;
      for (const param of lambdaList.children) {
        if (isSymbol(param) && LAMBDA_LIST_KEYWORDS.has(param.name)) break;
        if (isList(param)) {
          const specializer = param.children[1];
          if (isTypeSymbol(specializer)) push(out, specializer);
        }
      }
      return;
    }
    case 'DEFCLASS':
    case 'DEFINE-CONDITION': {
      // Superclasses are class names; the grammar colors them only when the
      // class name is on the definer's line, the server covers every layout.
      const supers = children[2];
      if (isList(supers)) {
        for (const parent of supers.children) {
          if (isTypeSymbol(parent)) push(out, parent);
        }
      }
      slotTypes(children[3], out);
      return;
    }
    case 'DEFSTRUCT':
      slotTypes({ ...list, children: children.slice(2) } as ListNode, out);
      return;
    case 'LOOP':
      for (let i = 1; i + 1 < children.length; i++) {
        const word = children[i];
        if (isSymbol(word) && word.kind === 'symbol' && word.name === 'OF-TYPE') typeSpecifier(children[i + 1], out);
      }
      return;
    case 'MAKE-ARRAY':
      for (let i = 2; i + 1 < children.length; i++) {
        const key = children[i];
        if (isSymbol(key) && key.kind === 'keyword' && key.name === 'ELEMENT-TYPE' && isQuoted(children[i + 1])) typeSpecifier(children[i + 1], out);
      }
      return;
    default:
      break;
  }
  const quotedPositions = QUOTED_TYPE_ARGUMENTS.get(head);
  if (quotedPositions) {
    for (const position of quotedPositions) {
      const arg = children[position];
      if (arg && isQuoted(arg)) typeSpecifier(arg, out);
    }
  }
}

/** Every symbol used as a type in the file, in source order. */
export function typePositions(result: ParseResult): TypePosition[] {
  const out: TypePosition[] = [];
  walk(result.forms, (node) => {
    if (node.kind === 'list') listPositions(node, out);
  });
  out.sort((a, b) => a.start - b.start);
  return out;
}
