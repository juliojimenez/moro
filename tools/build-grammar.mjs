#!/usr/bin/env node
// Generates syntaxes/commonlisp.tmLanguage.json from data/cl-symbols.json.
//
//   node tools/build-grammar.mjs        (or: npm run grammar)
//
// The standard symbol classes (special operators, macros, functions, types,
// variables, constants, lambda-list keywords, declaration identifiers) come
// from the SBCL-generated database so the highlighter and the language server
// agree on what is standard. Output is deterministic so CI can diff it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'data', 'cl-symbols.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Symbol classes

const byKind = (kind) => data.symbols.filter((s) => s.kinds.includes(kind)).map((s) => s.name);
const set = (names) => new Set(names);

const DEFINERS = {
  function: [
    'defun', 'defmacro', 'defgeneric', 'defmethod', 'define-compiler-macro', 'defsetf',
    'define-modify-macro', 'define-setf-expander', 'define-method-combination',
  ],
  class: ['defclass', 'define-condition'],
  type: ['deftype'],
  struct: ['defstruct'],
  variable: ['defvar', 'defparameter', 'define-symbol-macro'],
  constant: ['defconstant'],
  namespace: ['defpackage', 'in-package', 'defsystem', 'define-package'],
};
const allDefiners = set(Object.values(DEFINERS).flat());

const DECLARATION_OPERATORS = ['declare', 'declaim', 'proclaim'];
const declarations = set([...byKind('declaration'), ...DECLARATION_OPERATORS]);

const specialOperators = byKind('special-operator').filter((n) => !declarations.has(n));
const macros = byKind('macro').filter((n) => !allDefiners.has(n) && !declarations.has(n));
// Syntactic keywords that are not macros but read like control words.
const EXTRA_CONTROL = ['otherwise', 'make-method'];
const controlWords = [...new Set([...specialOperators, ...macros, ...EXTRA_CONTROL])];

// Locally bound in method bodies; SBCL does not fbind them globally.
const EXTRA_FUNCTIONS = ['call-next-method', 'next-method-p'];
const functions = [
  ...new Set([...byKind('function'), ...byKind('generic-function'), ...EXTRA_FUNCTIONS]),
].filter((n) => !declarations.has(n) && !allDefiners.has(n));

const LANGUAGE_CONSTANTS = ['t', 'nil'];
// Compound-only type specifiers ((eql x), (member ...), (mod n), (satisfies p), *)
// read as functions or wildcards when they stand alone.
const COMPOUND_ONLY_TYPES = ['*', 'eql', 'member', 'mod', 'satisfies'];
const types = [...new Set([...byKind('class'), ...byKind('type')])].filter(
  (n) => !LANGUAGE_CONSTANTS.includes(n) && !COMPOUND_ONLY_TYPES.includes(n),
);
const variables = byKind('variable');
const constants = byKind('constant').filter((n) => !LANGUAGE_CONSTANTS.includes(n));
const lambdaListKeywords = byKind('lambda-list-keyword');

const LOOP_KEYWORDS = [
  'for', 'as', 'with', 'and', 'in', 'on', 'across', 'being', 'each', 'the', 'hash-key', 'hash-keys',
  'hash-value', 'hash-values', 'using', 'of', 'symbol', 'symbols', 'present-symbol',
  'present-symbols', 'external-symbol', 'external-symbols', 'from', 'upfrom', 'downfrom', 'to',
  'upto', 'downto', 'below', 'above', 'by', '=', 'then', 'repeat', 'while', 'until', 'always',
  'never', 'thereis', 'do', 'doing', 'collect', 'collecting', 'append', 'appending', 'nconc',
  'nconcing', 'count', 'counting', 'sum', 'summing', 'maximize', 'maximizing', 'minimize',
  'minimizing', 'into', 'return', 'if', 'when', 'unless', 'else', 'end', 'finally', 'initially',
  'named', 'of-type',
];

// ---------------------------------------------------------------------------
// Regex building blocks (Oniguruma syntax)

// Characters that continue a token: anything but whitespace and the terminating
// macro characters ( ) " ; ' ` ,
const CONSTITUENT = '[^\\s()"\';`,]';
const SYMBOL = `${CONSTITUENT}+`;
const NOT_BEFORE = `(?<!${CONSTITUENT})`; // token must not continue a previous token
const NOT_BEFORE_SYM = '(?<![^\\s()"\';`,:])'; // like NOT_BEFORE but allows a package colon
const NOT_AFTER = `(?!${CONSTITUENT})`;
const PACKAGE_PREFIX = '(?:([^\\s()"\';`,:#|]+)(::?))?'; // 2 groups: package, colons
const AFTER_OPEN = '(?<=\\()\\s*';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
const alternation = (names) =>
  [...new Set(names)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(escapeRegex)
    .join('|');
const ci = (names) => `(?i:${alternation(names)})`;

const PAREN_BEGIN = 'punctuation.section.parens.begin.commonlisp';
const PAREN_END = 'punctuation.section.parens.end.commonlisp';
const PACKAGE_CAPTURES = {
  2: { name: 'entity.name.namespace.package.commonlisp' },
  3: { name: 'punctuation.accessor.commonlisp' },
};

// A definer form: "(" prefix? definer name? ... ")" where the name gets nameScope.
function definerRule(names, nameScope, { nameMatch = SYMBOL } = {}) {
  return {
    begin: `(\\()\\s*${PACKAGE_PREFIX}(${ci(names)})${NOT_AFTER}(?:\\s+(${nameMatch}))?`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      ...PACKAGE_CAPTURES,
      4: { name: 'storage.type.commonlisp' },
      5: { name: nameScope },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '$self' }],
  };
}

function headRule(names, scope) {
  return {
    match: `${AFTER_OPEN}${PACKAGE_PREFIX}(${ci(names)})${NOT_AFTER}`,
    captures: {
      1: { name: 'entity.name.namespace.package.commonlisp' },
      2: { name: 'punctuation.accessor.commonlisp' },
      3: { name: scope },
    },
  };
}

function symbolRule(names, scope) {
  return {
    match: `${NOT_BEFORE_SYM}(${ci(names)})${NOT_AFTER}`,
    captures: { 1: { name: scope } },
  };
}

const FORMAT_DIRECTIVE =
  "~(?:[-+]?\\d+|#|[vV]|'.)?(?:,(?:[-+]?\\d+|#|[vV]|'.)?)*[:@]{0,2}(?:/[^/\"]*/|[a-zA-Z%&|~*?^$<>(){}\\[\\];]|$)";

// ---------------------------------------------------------------------------
// Grammar

const repository = {
  'comment-block': {
    name: 'comment.block.commonlisp',
    begin: '#\\|',
    end: '\\|#',
    patterns: [{ include: '#comment-block' }],
  },
  'comment-shebang': {
    name: 'comment.line.shebang.commonlisp',
    match: '^#!.*',
  },
  'comment-line': {
    name: 'comment.line.semicolon.commonlisp',
    match: ';.*',
  },
  string: {
    name: 'string.quoted.double.commonlisp',
    begin: '"',
    end: '"',
    beginCaptures: { 0: { name: 'punctuation.definition.string.begin.commonlisp' } },
    endCaptures: { 0: { name: 'punctuation.definition.string.end.commonlisp' } },
    patterns: [{ include: '#string-escape' }, { include: '#format-directive' }],
  },
  'string-escape': {
    name: 'constant.character.escape.commonlisp',
    match: '\\\\.',
  },
  'format-directive': {
    name: 'constant.other.placeholder.format.commonlisp',
    match: FORMAT_DIRECTIVE,
  },
  character: {
    // #\x #\Space #\U+1F600 and #\( #\) #\; #\" #\  -- the character after the
    // backslash is always swallowed so it never reaches the paren/string rules.
    name: 'constant.character.commonlisp',
    match: `#\\\\(?:[A-Za-z0-9]${CONSTITUENT}*|.)`,
  },
  'definer-function': {
    // (defun name ...) or (defun (setf name) ...)
    begin: `(\\()\\s*${PACKAGE_PREFIX}(${ci(DEFINERS.function)})${NOT_AFTER}(?:\\s+(?:(\\()\\s*((?i:setf))\\s+(${SYMBOL})\\s*(\\))|(${SYMBOL})))?`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      ...PACKAGE_CAPTURES,
      4: { name: 'storage.type.commonlisp' },
      5: { name: PAREN_BEGIN },
      6: { name: 'keyword.control.commonlisp' },
      7: { name: 'entity.name.function.commonlisp' },
      8: { name: PAREN_END },
      9: { name: 'entity.name.function.commonlisp' },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '$self' }],
  },
  'definer-class': {
    // (defclass name (superclass*) ...) -- the superclass list follows the name
    ...definerRule(DEFINERS.class, 'entity.name.type.class.commonlisp'),
    patterns: [{ include: '#superclass-list' }, { include: '$self' }],
  },
  'superclass-list': {
    begin: '\\G\\s*(\\()',
    beginCaptures: { 1: { name: PAREN_BEGIN } },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [
      { include: '#comment-line' },
      { match: SYMBOL, name: 'entity.other.inherited-class.commonlisp' },
    ],
  },
  'definer-type': definerRule(DEFINERS.type, 'entity.name.type.class.commonlisp'),
  'definer-struct': {
    begin: `(\\()\\s*${PACKAGE_PREFIX}(${ci(DEFINERS.struct)})${NOT_AFTER}`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      ...PACKAGE_CAPTURES,
      4: { name: 'storage.type.commonlisp' },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [
      { include: '#definer-struct-name-list' },
      { include: '#definer-struct-name' },
      { include: '$self' },
    ],
  },
  'definer-struct-name-list': {
    // (defstruct (name option*) ...) -- anchored right after defstruct
    begin: `\\G\\s+(\\()\\s*(${SYMBOL})`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      2: { name: 'entity.name.type.class.commonlisp' },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '$self' }],
  },
  'definer-struct-name': {
    match: `\\G\\s+(${SYMBOL})`,
    captures: { 1: { name: 'entity.name.type.class.commonlisp' } },
  },
  'definer-variable': definerRule(DEFINERS.variable, 'variable.other.global.commonlisp'),
  'definer-constant': definerRule(DEFINERS.constant, 'variable.other.constant.commonlisp'),
  'definer-namespace': definerRule(DEFINERS.namespace, 'entity.name.namespace.commonlisp', {
    nameMatch: `"[^"]*"|${SYMBOL}`,
  }),
  loop: {
    begin: `(\\()\\s*${PACKAGE_PREFIX}((?i:loop))${NOT_AFTER}`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      ...PACKAGE_CAPTURES,
      4: { name: 'keyword.control.commonlisp' },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '#loop-keyword' }, { include: '$self' }],
  },
  'loop-keyword': {
    match: `${NOT_BEFORE}(${ci(LOOP_KEYWORDS)})${NOT_AFTER}`,
    captures: { 1: { name: 'keyword.control.loop.commonlisp' } },
  },
  paren: {
    begin: '\\(',
    beginCaptures: { 0: { name: PAREN_BEGIN } },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '$self' }],
  },
  'number-radix': {
    name: 'constant.numeric.radix.commonlisp',
    match: `${NOT_BEFORE}(?:#[xX][+-]?[0-9a-fA-F]+(?:/[0-9a-fA-F]+)?|#[oO][+-]?[0-7]+(?:/[0-7]+)?|#[bB][+-]?[01]+(?:/[01]+)?|#\\d+[rR][+-]?[0-9a-zA-Z]+(?:/[0-9a-zA-Z]+)?)${NOT_AFTER}`,
  },
  'number-float': {
    name: 'constant.numeric.float.commonlisp',
    match: `${NOT_BEFORE}[+-]?(?:\\d+\\.\\d+(?:[esfdlESFDL][+-]?\\d+)?|\\d+\\.\\d*[esfdlESFDL][+-]?\\d+|\\.\\d+(?:[esfdlESFDL][+-]?\\d+)?|\\d+[esfdlESFDL][+-]?\\d+)${NOT_AFTER}`,
  },
  'number-ratio': {
    name: 'constant.numeric.ratio.commonlisp',
    match: `${NOT_BEFORE}[+-]?\\d+/\\d+${NOT_AFTER}`,
  },
  'number-integer': {
    name: 'constant.numeric.integer.commonlisp',
    match: `${NOT_BEFORE}[+-]?\\d+\\.?${NOT_AFTER}`,
  },
  'uninterned-symbol': {
    name: 'constant.other.symbol.uninterned.commonlisp',
    match: `${NOT_BEFORE}#:${SYMBOL}`,
  },
  'function-quote': {
    match: `(#')(?:${PACKAGE_PREFIX}(${ci(functions)})${NOT_AFTER})?`,
    captures: {
      1: { name: 'keyword.operator.function.commonlisp' },
      2: { name: 'entity.name.namespace.package.commonlisp' },
      3: { name: 'punctuation.accessor.commonlisp' },
      4: { name: 'support.function.commonlisp' },
    },
  },
  'reader-conditional': {
    match: `${NOT_BEFORE}(#[+-])(${SYMBOL})?`,
    captures: {
      1: { name: 'keyword.control.reader-conditional.commonlisp' },
      2: { name: 'constant.other.feature.commonlisp' },
    },
  },
  'reader-macro': {
    // #( #* #. #p #c #s #2A #1= #1#
    name: 'keyword.operator.reader-macro.commonlisp',
    match: `${NOT_BEFORE}#(?:\\d+=|\\d+#|\\d*[aA](?=\\()|[cCsS](?=\\()|[pP](?=")|\\.|\\*[01]*|(?=\\())`,
  },
  quote: {
    name: 'keyword.operator.quote.commonlisp',
    match: ",@|,\\.|,|'|`",
  },
  keyword: {
    name: 'constant.other.keyword.commonlisp',
    match: `${NOT_BEFORE}:${SYMBOL}`,
  },
  'escaped-symbol': {
    name: 'constant.other.symbol.escaped.commonlisp',
    match: '\\|[^|]*\\|',
  },
  'lambda-list-keyword': symbolRule(lambdaListKeywords, 'storage.modifier.lambda-list.commonlisp'),
  'constant-language': symbolRule(LANGUAGE_CONSTANTS, 'constant.language.commonlisp'),
  'head-declaration': headRule([...declarations], 'keyword.other.declaration.commonlisp'),
  'head-control': headRule(controlWords, 'keyword.control.commonlisp'),
  'head-function': headRule(functions, 'support.function.commonlisp'),
  'package-prefix': {
    match: `${NOT_BEFORE}([^\\s()"';\`,:#|]+)(::?)(?=[^\\s()"';\`,:])`,
    captures: {
      1: { name: 'entity.name.namespace.package.commonlisp' },
      2: { name: 'punctuation.accessor.commonlisp' },
    },
  },
  type: symbolRule(types, 'support.type.commonlisp'),
  function: symbolRule(functions, 'support.function.commonlisp'),
  variable: symbolRule(variables, 'support.variable.commonlisp'),
  constant: symbolRule(constants, 'support.constant.commonlisp'),
};

// Order matters: at equal match positions the earlier rule wins.
const ORDER = [
  'comment-block', 'comment-shebang', 'comment-line', 'string', 'character',
  'definer-function', 'definer-class', 'definer-type', 'definer-struct', 'definer-variable', 'definer-constant',
  'definer-namespace', 'loop', 'paren',
  'number-radix', 'number-float', 'number-ratio', 'number-integer',
  'uninterned-symbol', 'function-quote', 'reader-conditional', 'reader-macro', 'quote', 'keyword',
  'escaped-symbol', 'lambda-list-keyword', 'constant-language',
  'head-declaration', 'head-control', 'head-function', 'package-prefix',
  'type', 'function', 'variable', 'constant',
];
for (const name of ORDER) {
  if (!repository[name]) throw new Error(`ORDER names unknown rule ${name}`);
}

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  information_for_contributors: [
    'Generated by tools/build-grammar.mjs from data/cl-symbols.json.',
    'Do not edit by hand: run `npm run grammar`.',
  ],
  name: 'Common Lisp',
  scopeName: 'source.commonlisp',
  fileTypes: ['lisp', 'lsp', 'cl', 'asd', 'asdf', 'ros'],
  patterns: ORDER.map((name) => ({ include: `#${name}` })),
  repository: Object.fromEntries(ORDER.map((name) => [name, repository[name]]).concat(
    Object.entries(repository).filter(([name]) => !ORDER.includes(name)),
  )),
};

const outDir = join(root, 'syntaxes');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'commonlisp.tmLanguage.json');
writeFileSync(outFile, JSON.stringify(grammar, null, 2) + '\n');
console.log(
  `wrote ${outFile}: ${controlWords.length} control words, ${functions.length} functions, ` +
    `${types.length} types, ${variables.length} variables, ${constants.length} constants, ` +
    `${declarations.size} declaration words, ${LOOP_KEYWORDS.length} loop keywords`,
);
