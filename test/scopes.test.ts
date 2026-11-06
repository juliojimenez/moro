import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/common/reader';
import { allBindings, bindingsAt } from '../src/server/scopes';

function visible(src: string, marker = '|'): string[] {
  const offset = src.indexOf(marker);
  const text = src.replace(marker, '');
  return bindingsAt(parse(text), offset).map((b) => b.label);
}

test('let and let* scopes', () => {
  assert.deepEqual(visible('(let ((a 1) (b a)) |)'), ['a', 'b']);
  assert.deepEqual(visible('(let ((a 1) (b |a)) )'), [], 'let inits do not see the variables');
  assert.deepEqual(visible('(let* ((a 1) (b |a)) )'), ['a'], 'let* inits see earlier variables');
  assert.deepEqual(visible('(let (a (b 2)) |)'), ['a', 'b']);
});

test('lambda lists with &optional, &key and supplied-p', () => {
  assert.deepEqual(visible('(defun f (a &optional (b 1 b-p) &rest r &key c ((:dee d) 2) &aux (e 3)) |)'), ['a', 'b', 'b-p', 'r', 'c', 'd', 'e']);
  assert.deepEqual(visible('(lambda (x y) |)'), ['x', 'y']);
  assert.deepEqual(visible('(defmethod m ((o point) (n integer) &key k) |)'), ['o', 'n', 'k']);
});

test('macro lambda lists destructure', () => {
  assert.deepEqual(visible('(defmacro with-it ((var &optional val) &body body) |)'), ['var', 'val', 'body']);
  assert.deepEqual(visible('(destructuring-bind (a (b c) &rest d) form |)'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(visible('(destructuring-bind (a) |form)'), []);
});

test('flet names are visible in the body, labels also in the definitions', () => {
  assert.deepEqual(visible('(flet ((helper (x) |x)) (helper 1))'), ['x']);
  assert.deepEqual(visible('(flet ((helper (x) x)) |)'), ['helper']);
  assert.deepEqual(visible('(labels ((rec (n) (|rec n))) (rec 1))'), ['rec', 'n']);
});

test('multiple-value-bind, do, dolist, dotimes', () => {
  assert.deepEqual(visible('(multiple-value-bind (q r) (floor 7 2) |)'), ['q', 'r']);
  assert.deepEqual(visible('(multiple-value-bind (q r) (floor |7 2) )'), []);
  assert.deepEqual(visible('(do ((i 0 (1+ i)) (acc nil)) ((> i 3)) |)'), ['i', 'acc']);
  assert.deepEqual(visible('(dolist (item items) |)'), ['item']);
  assert.deepEqual(visible('(dotimes (i 10) |)'), ['i']);
});

test('loop variables', () => {
  assert.deepEqual(visible('(loop for x in xs for y = (f x) with z = 1 collect |x into acc)'), ['x', 'y', 'z', 'acc']);
  assert.deepEqual(visible('(loop for (a . b) in pairs and c = 0 do |)'), ['a', 'b', 'c']);
});

test('with-* macros and handler-case', () => {
  assert.deepEqual(visible('(with-open-file (in "x" :direction :input) |)'), ['in']);
  assert.deepEqual(visible('(with-slots (a (bee b)) obj |)'), ['a', 'bee']);
  assert.deepEqual(visible('(with-output-to-string (s) |)'), ['s']);
  assert.deepEqual(visible('(with-custom ((p 1) (q 2)) |)'), ['p', 'q']);
  assert.deepEqual(visible('(handler-case (risky) (error (e) |))'), ['e']);
  assert.deepEqual(visible('(handler-case (|risky) (error (e) nil))'), []);
});

test('shadowing keeps both bindings in scope order', () => {
  const names = visible('(defun f (x) (let ((x 2)) |x))');
  assert.deepEqual(names, ['x', 'x']);
});

test('allBindings covers the whole file', () => {
  const all = allBindings(parse('(defun f (a) (let ((b 1)) (lambda (c) (list a b c))))'));
  assert.deepEqual(all.map((b) => `${b.kind}:${b.label}`), ['parameter:a', 'variable:b', 'parameter:c']);
});
