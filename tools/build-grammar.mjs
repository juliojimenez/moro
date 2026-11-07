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

// Definers and heads.
//
// A definer's name usually follows it on the same line and is captured by the
// definer rule's begin regex. When the line ends right after the definer
// ("(defun\n    long-name ()"), a name-wait rule takes over: anchored right after
// the definer word, it ends by consuming the name on a later line. Likewise,
// when a "(" ends its line, head-wait classifies the first token of a later
// line as the head and hands definers to the deferred-definer rules (issue #2).
const REST_OF_LINE_BLANK = '(?=\\s*(?:;|#\\||$))';
const WAIT_PATTERNS = [{ include: '#comment-block' }, { include: '#comment-line' }];
const PACKAGE_SCOPES = ['entity.name.namespace.package.commonlisp', 'punctuation.accessor.commonlisp'];
const scopesFrom = (offset, scopes) => Object.fromEntries(scopes.map((name, i) => [offset + 1 + i, { name }]));

// name or (setf name): 5 groups
const FUNCTION_NAME = `(?:(\\()\\s*((?i:setf))\\s+(${SYMBOL})\\s*(\\))|(${SYMBOL}))`;
const FUNCTION_NAME_SCOPES = [
  PAREN_BEGIN, 'keyword.control.commonlisp', 'entity.name.function.commonlisp', PAREN_END, 'entity.name.function.commonlisp',
];

const DEFINER_KINDS = [
  { id: 'function', names: DEFINERS.function, name: FUNCTION_NAME, scopes: FUNCTION_NAME_SCOPES },
  { id: 'class', names: DEFINERS.class, name: `(${SYMBOL})`, scopes: ['entity.name.type.class.commonlisp'], extra: ['#superclass-list'] },
  { id: 'type', names: DEFINERS.type, name: `(${SYMBOL})`, scopes: ['entity.name.type.class.commonlisp'] },
  { id: 'variable', names: DEFINERS.variable, name: `(${SYMBOL})`, scopes: ['variable.other.global.commonlisp'] },
  { id: 'constant', names: DEFINERS.constant, name: `(${SYMBOL})`, scopes: ['variable.other.constant.commonlisp'] },
  { id: 'namespace', names: DEFINERS.namespace, name: `("[^"]*"|${SYMBOL})`, scopes: ['entity.name.namespace.commonlisp'] },
];

function definerRules({ id, names, name, scopes, extra = [] }) {
  // definer [name]: package (2 groups), definer word, name groups
  const tail = `${PACKAGE_PREFIX}(${ci(names)})${NOT_AFTER}(?:\\s+${name})?`;
  const extraPatterns = extra.map((include) => ({ include }));
  return {
    [`definer-${id}`]: {
      begin: `(\\()\\s*${tail}`,
      beginCaptures: {
        1: { name: PAREN_BEGIN },
        ...scopesFrom(1, PACKAGE_SCOPES),
        4: { name: 'storage.type.commonlisp' },
        ...scopesFrom(4, scopes),
      },
      end: '\\)',
      endCaptures: { 0: { name: PAREN_END } },
      patterns: [{ include: `#name-wait-${id}` }, ...extraPatterns, { include: '$self' }],
    },
    [`name-wait-${id}`]: {
      // The definer word ended its line: the name is on a later line.
      begin: `(?i)(?<=${alternation(names)})\\G${REST_OF_LINE_BLANK}`,
      end: `${name}|(?=\\S)`,
      endCaptures: scopesFrom(0, scopes),
      applyEndPatternLast: 1,
      patterns: WAIT_PATTERNS,
    },
    [`deferred-definer-${id}`]: {
      // Reached from head-wait: the "(" was on an earlier line.
      begin: tail,
      beginCaptures: {
        ...scopesFrom(0, PACKAGE_SCOPES),
        3: { name: 'storage.type.commonlisp' },
        ...scopesFrom(3, scopes),
      },
      end: '(?=\\S)',
      applyEndPatternLast: 1,
      patterns: [...WAIT_PATTERNS, { include: `#name-wait-${id}` }, ...extraPatterns],
    },
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
      { include: '#struct-name-wait' },
      { include: '#definer-struct-name-list' },
      { include: '#definer-struct-name' },
      { include: '$self' },
    ],
  },
  'struct-name-wait': {
    // (defstruct\n  name ...) or (defstruct\n  (name option*) ...)
    begin: `(?i)(?<=defstruct)\\G${REST_OF_LINE_BLANK}`,
    end: `(${SYMBOL})|(?=\\S)`,
    endCaptures: { 1: { name: 'entity.name.type.class.commonlisp' } },
    applyEndPatternLast: 1,
    patterns: [...WAIT_PATTERNS, { include: '#struct-name-list' }],
  },
  'struct-name-list': {
    begin: `(\\()\\s*(${SYMBOL})`,
    beginCaptures: {
      1: { name: PAREN_BEGIN },
      2: { name: 'entity.name.type.class.commonlisp' },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    patterns: [{ include: '$self' }],
  },
  'deferred-definer-struct': {
    begin: `${PACKAGE_PREFIX}((?i:defstruct))${NOT_AFTER}`,
    beginCaptures: {
      ...scopesFrom(0, PACKAGE_SCOPES),
      3: { name: 'storage.type.commonlisp' },
    },
    end: '(?=\\S)',
    applyEndPatternLast: 1,
    patterns: [
      ...WAIT_PATTERNS,
      { include: '#struct-name-wait' },
      { include: '#definer-struct-name-list' },
      { include: '#definer-struct-name' },
    ],
  },
  'deferred-loop': {
    // "(" on an earlier line, then loop: this loop's clause keywords get their color.
    begin: `${PACKAGE_PREFIX}((?i:loop))${NOT_AFTER}`,
    beginCaptures: {
      ...scopesFrom(0, PACKAGE_SCOPES),
      3: { name: 'keyword.control.commonlisp' },
    },
    end: '(?=\\))',
    patterns: [{ include: '#loop-keyword' }, { include: '$self' }],
  },
  'head-wait': {
    // "(" ended its line: the first token of a later line is the head.
    begin: `(?<=\\()\\G${REST_OF_LINE_BLANK}`,
    end: `${PACKAGE_PREFIX}(?:(${ci([...declarations])})|(${ci(controlWords)})|(${ci(functions)}))${NOT_AFTER}|(?=\\S)`,
    endCaptures: {
      ...scopesFrom(0, PACKAGE_SCOPES),
      3: { name: 'keyword.other.declaration.commonlisp' },
      4: { name: 'keyword.control.commonlisp' },
      5: { name: 'support.function.commonlisp' },
    },
    applyEndPatternLast: 1,
    patterns: [
      ...WAIT_PATTERNS,
      { include: '#deferred-loop' },
      ...DEFINER_KINDS.map(({ id }) => ({ include: `#deferred-definer-${id}` })),
      { include: '#deferred-definer-struct' },
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
    patterns: [{ include: '#head-wait' }, { include: '$self' }],
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
  'reader-conditional-list': {
    // #+(or sbcl ccl) ... : the feature expression is a little language of its
    // own, so and/or/not read as reader-conditional operators and every other
    // symbol as a feature, however deeply nested and across lines.
    begin: `${NOT_BEFORE}(#[+-])\\s*(\\()`,
    beginCaptures: {
      1: { name: 'keyword.control.reader-conditional.commonlisp' },
      2: { name: PAREN_BEGIN },
    },
    end: '\\)',
    endCaptures: { 0: { name: PAREN_END } },
    contentName: 'meta.feature-expression.commonlisp',
    patterns: [{ include: '#feature-expression' }],
  },
  'feature-expression': {
    patterns: [
      { include: '#comment-block' },
      { include: '#comment-line' },
      {
        match: `${NOT_BEFORE_SYM}((?i:and|or|not))${NOT_AFTER}`,
        captures: { 1: { name: 'keyword.control.reader-conditional.commonlisp' } },
      },
      {
        begin: '\\(',
        beginCaptures: { 0: { name: PAREN_BEGIN } },
        end: '\\)',
        endCaptures: { 0: { name: PAREN_END } },
        patterns: [{ include: '#feature-expression' }],
      },
      { match: SYMBOL, name: 'constant.other.feature.commonlisp' },
    ],
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
  'symbol-escape': {
    // a\\|b or foo\\(bar: the backslash escapes one character of a symbol
    name: 'constant.character.escape.commonlisp',
    match: '\\\\.',
  },
  'escaped-symbol': {
    // |a symbol with spaces| -- may span lines, like the reader allows
    name: 'constant.other.symbol.escaped.commonlisp',
    begin: '\\|',
    end: '\\|',
    patterns: [{ include: '#symbol-escape' }],
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

Object.assign(repository, ...DEFINER_KINDS.map(definerRules));

// Order matters: at equal match positions the earlier rule wins.
const ORDER = [
  'comment-block', 'comment-shebang', 'comment-line', 'string', 'character',
  'definer-function', 'definer-class', 'definer-type', 'definer-struct', 'definer-variable', 'definer-constant',
  'definer-namespace', 'loop', 'paren',
  'number-radix', 'number-float', 'number-ratio', 'number-integer',
  'uninterned-symbol', 'function-quote', 'reader-conditional-list', 'reader-conditional', 'reader-macro', 'quote', 'keyword',
  'symbol-escape', 'escaped-symbol', 'lambda-list-keyword', 'constant-language',
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
