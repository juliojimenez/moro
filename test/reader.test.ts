import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enclosingList,
  formBefore,
  headName,
  inPackageAt,
  isNumberToken,
  nodeAt,
  normalizeSymbolName,
  parse,
  positionAt,
  splitSymbolToken,
  symbolAt,
  textOf,
  topLevelFormAt,
  AtomNode,
  ListNode,
} from '../src/common/reader';

function list(node: unknown): ListNode {
  assert.ok(node && (node as ListNode).kind === 'list', 'expected a list');
  return node as ListNode;
}

function atom(node: unknown): AtomNode {
  assert.ok(node && (node as { kind: string }).kind !== 'list', 'expected an atom');
  return node as AtomNode;
}

test('parses nested lists with offsets', () => {
  const result = parse('(a (b c) d)');
  assert.equal(result.forms.length, 1);
  const outer = list(result.forms[0]);
  assert.equal(outer.children.length, 3);
  assert.equal(outer.start, 0);
  assert.equal(outer.end, 11);
  assert.ok(outer.closed);
  const inner = list(outer.children[1]);
  assert.equal(textOf(result, inner), '(b c)');
  assert.equal(inner.parent, outer);
  assert.deepEqual(result.errors, []);
});

test('symbols are normalized and package prefixes split', () => {
  const result = parse('(cl:car sb-ext::posix-getenv :key #:uninterned foo\\:bar |Mixed Case| plain)');
  const [car, getenv, key, uninterned, escaped, mixed, plain] = list(result.forms[0]).children.map(atom);
  assert.equal(car.name, 'CAR');
  assert.equal(car.pkg, 'CL');
  assert.equal(car.nameStart, 4);
  assert.equal(getenv.name, 'POSIX-GETENV');
  assert.equal(getenv.pkg, 'SB-EXT');
  assert.equal(key.kind, 'keyword');
  assert.equal(key.name, 'KEY');
  assert.equal(key.pkg, 'KEYWORD');
  assert.equal(uninterned.name, 'UNINTERNED');
  assert.equal(uninterned.uninterned, true);
  assert.equal(escaped.name, 'FOO:BAR');
  assert.equal(escaped.pkg, null);
  assert.equal(mixed.name, 'Mixed Case');
  assert.equal(plain.name, 'PLAIN');
});

test('numbers vs symbols', () => {
  for (const n of ['42', '-7', '+3', '1.', '1/3', '3.14', '.5', '1e10', '1.5d0', '-2.5E-3']) assert.ok(isNumberToken(n), n);
  for (const s of ['1+', '-', '+', '1-', '+x+', 'a1', '1a', '1/', '/2', '1.5.2']) assert.ok(!isNumberToken(s), s);
  const result = parse('(#xFF #b1010 #o17 #36rZZ 1+ -)');
  const kinds = list(result.forms[0]).children.map((c) => c.kind);
  assert.deepEqual(kinds, ['number', 'number', 'number', 'number', 'symbol', 'symbol']);
});

test('strings, characters and comments do not break structure', () => {
  const src = '(list #\\( #\\) #\\; #\\" #\\Space "a \\" (b" ; comment (x\n #| block (y #| nested |# |# z)';
  const result = parse(src);
  assert.deepEqual(result.errors, []);
  const form = list(result.forms[0]);
  assert.ok(form.closed);
  assert.deepEqual(
    form.children.map((c) => c.kind),
    ['symbol', 'char', 'char', 'char', 'char', 'char', 'string', 'symbol'],
  );
  assert.equal(atom(form.children[6]).text, '"a \\" (b"');
  assert.deepEqual(result.comments.map((c) => c.kind), ['line', 'block']);
});

test('prefixes are attached to the following form', () => {
  const result = parse("'foo `(a ,b ,@c) #'car #+sbcl (require :x) #-(or ccl ecl) 1 #.(+ 1 2) #p\"/tmp\" #c(1 2) #2A((1) (2))");
  const forms = result.forms;
  assert.equal(forms.length, 9);
  assert.equal(forms[0].prefix, "'");
  assert.equal(atom(forms[0]).name, 'FOO');
  assert.equal(forms[0].start, 0);
  assert.equal(forms[0].formStart, 1);
  const bq = list(forms[1]);
  assert.equal(bq.prefix, '`');
  assert.equal(bq.children[1].prefix, ',');
  assert.equal(bq.children[2].prefix, ',@');
  assert.equal(forms[2].prefix, "#'");
  assert.equal(forms[3].prefix, '#+sbcl ');
  assert.equal(headName(forms[3]), 'REQUIRE');
  assert.equal(forms[4].prefix, '#-(or ccl ecl) ');
  assert.equal(atom(forms[4]).kind, 'number');
  assert.equal(forms[5].prefix, '#.');
  assert.equal(forms[6].prefix, '#p');
  assert.equal(forms[7].prefix, '#c');
  assert.equal(forms[8].prefix, '#2A');
  assert.deepEqual(result.errors, []);
});

test('vectors, bit vectors and labels', () => {
  const result = parse('(#(1 2 3) #*0101 #1=(a . #1#) #3(x))');
  const [vector, bits, labelled, sized] = list(result.forms[0]).children;
  assert.equal(list(vector).open, '#(');
  assert.equal(list(vector).children.length, 3);
  assert.equal(atom(bits).kind, 'reader');
  assert.equal(labelled.prefix, '#1=');
  assert.equal(atom(list(labelled).children[2]).text, '#1#');
  assert.equal(list(sized).open, '#3(');
});

test('errors are reported and parsing continues', () => {
  const result = parse('(ok))\n(defun broken (a\n"unterminated');
  assert.ok(result.errors.some((e) => e.message.includes('Unclosed')));
  assert.ok(result.errors.some((e) => e.message.includes('Unmatched')));
  assert.ok(result.errors.some((e) => e.message.includes('Unterminated string')));
  assert.equal(result.forms.length, 2);
  assert.ok(list(result.forms[0]).closed);
  const broken = list(result.forms[1]);
  assert.equal(broken.closed, false);
  assert.equal(headName(broken), 'DEFUN');
  assert.equal(list(broken.children[2]).closed, false);
});

test('unterminated block comment and unknown reader macro', () => {
  const result = parse('(a) #| never closed');
  assert.equal(result.forms.length, 1);
  assert.ok(result.errors.some((e) => e.message.includes('block comment')));
  const result2 = parse('(a #?x b)');
  assert.ok(result2.errors.some((e) => e.message.includes('Unknown reader macro')));
  assert.equal(list(result2.forms[0]).children.length, 3);
});

test('shebang lines are comments', () => {
  const result = parse('#!/usr/bin/sbcl --script\n(print 1)');
  assert.equal(result.forms.length, 1);
  assert.equal(result.comments.length, 1);
});

test('nodeAt, enclosingList, symbolAt', () => {
  const src = '(defun foo (x)\n  (bar x "str"))';
  const result = parse(src);
  const xOffset = src.indexOf('(bar x') + 5;
  assert.equal(atom(nodeAt(result, xOffset)).name, 'X');
  assert.equal(symbolAt(result, xOffset)?.name, 'X');
  assert.equal(headName(enclosingList(result, xOffset)), 'BAR');
  assert.equal(headName(enclosingList(result, 1)), 'DEFUN');
  assert.equal(enclosingList(result, 0), null);
  assert.equal(nodeAt(result, src.indexOf('"str"') + 2)?.kind, 'string');
  assert.equal(symbolAt(result, src.indexOf('"str"') + 2), null);
  // cursor right after the closing paren is outside
  assert.equal(enclosingList(result, src.length), null);
});

test('topLevelFormAt and formBefore', () => {
  const src = '(a 1)\n\n(b (c 2) 3)\n';
  const result = parse(src);
  assert.equal(headName(topLevelFormAt(result, 2)), 'A');
  assert.equal(headName(topLevelFormAt(result, 6)), 'A', 'between forms picks the preceding one');
  assert.equal(headName(topLevelFormAt(result, src.indexOf('(c'))), 'B');
  assert.equal(textOf(result, formBefore(result, src.indexOf(' 3'))!), '(c 2)');
  assert.equal(textOf(result, formBefore(result, src.indexOf('3') + 1)!), '3');
  assert.equal(textOf(result, formBefore(result, src.length)!), '(b (c 2) 3)');
});

test('inPackageAt follows the last preceding in-package', () => {
  const src = '(in-package :foo)\n(x)\n(in-package "BAR")\n(y)\n(in-package #:baz)';
  const result = parse(src);
  assert.equal(inPackageAt(result, 0), null);
  assert.equal(inPackageAt(result, src.indexOf('(x)')), 'FOO');
  assert.equal(inPackageAt(result, src.indexOf('(y)')), 'BAR');
  assert.equal(inPackageAt(result, src.length), 'BAZ');
});

test('positions use UTF-16 offsets and line starts', () => {
  const result = parse('ab\ncd\n\nef');
  assert.deepEqual(positionAt(result, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAt(result, 3), { line: 1, character: 0 });
  assert.deepEqual(positionAt(result, 4), { line: 1, character: 1 });
  assert.deepEqual(positionAt(result, 7), { line: 3, character: 0 });
});

test('normalizeSymbolName and splitSymbolToken', () => {
  assert.equal(normalizeSymbolName('foo-bar'), 'FOO-BAR');
  assert.equal(normalizeSymbolName('|foo|'), 'foo');
  assert.equal(normalizeSymbolName('a\\bc'), 'AbC');
  assert.deepEqual(splitSymbolToken('pkg::name'), { pkg: 'PKG', name: 'NAME', nameOffset: 5 });
  assert.deepEqual(splitSymbolToken(':kw'), { pkg: 'KEYWORD', name: 'KW', nameOffset: 1 });
  assert.deepEqual(splitSymbolToken('|a:b|'), { pkg: null, name: 'a:b', nameOffset: 0 });
});
