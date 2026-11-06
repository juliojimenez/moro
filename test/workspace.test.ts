import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyArity, globToRegExp, WorkspaceIndex } from '../src/server/workspace';

test('globToRegExp', () => {
  const re = globToRegExp('**/node_modules/**');
  assert.ok(re.test('node_modules/foo.lisp'));
  assert.ok(re.test('a/b/node_modules/c/d.lisp'));
  assert.ok(!re.test('src/main.lisp'));
  assert.ok(globToRegExp('*.lisp').test('main.lisp'));
  assert.ok(!globToRegExp('*.lisp').test('src/main.lisp'));
  assert.ok(globToRegExp('src/**').test('src/deep/file.lisp'));
  assert.ok(globToRegExp('**/.qlot/**').test('.qlot/dists/x.lisp'));
});

test('bodyArity counts required parameters before &body', () => {
  assert.equal(bodyArity('(name lambda-list &body body)'), 2);
  assert.equal(bodyArity('((stream filespec &rest options) &body body)'), 1);
  assert.equal(bodyArity('(&body body)'), 0);
  assert.equal(bodyArity('(&whole w name &optional doc &body body)'), 1);
  assert.equal(bodyArity('(test then &optional else)'), undefined);
  assert.equal(bodyArity('(&rest forms)'), undefined);
  assert.equal(bodyArity('(place &optional (delta 1))'), undefined);
});

test('index lookups across files', () => {
  const index = new WorkspaceIndex();
  index.update('file:///a.lisp', '(defpackage #:app (:use #:cl) (:export #:run))\n(in-package #:app)\n(defun run () (helper))\n(defmacro with-x (a &body b))', false);
  index.update('file:///b.lisp', '(in-package #:other)\n(defun helper () (run))\n(defun run () :other)', true);
  assert.equal(index.findDefinitions('RUN').length, 2);
  assert.equal(index.findDefinitions('RUN', 'APP').length, 1);
  assert.equal(index.findDefinitions('RUN', 'NOWHERE').length, 2, 'unknown package falls back to all');
  assert.equal(index.findOccurrences('RUN', false).length, 4);
  assert.equal(index.findOccurrences('RUN', true).length, 0);
  assert.deepEqual([...index.symbolsInPackage('APP').keys()].sort(), ['RUN', 'WITH-X']);
  assert.deepEqual(index.allPackages(), ['APP']);
  index.remove('file:///b.lisp');
  assert.equal(index.findDefinitions('HELPER').length, 0);
});
