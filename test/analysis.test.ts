import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/common/reader';
import { analyze, Definition } from '../src/server/analysis';

function defs(src: string): Definition[] {
  return analyze(parse(src)).definitions;
}

test('defun with docstring and lambda list', () => {
  const [d] = defs('(defun greet (name &optional (greeting "hi"))\n  "Say hello."\n  (format t "~a ~a" greeting name))');
  assert.equal(d.name, 'GREET');
  assert.equal(d.label, 'greet');
  assert.equal(d.kind, 'function');
  assert.equal(d.lambdaList, '(name &optional (greeting "hi"))');
  assert.equal(d.docstring, 'Say hello.');
  assert.deepEqual(d.nameRange, [7, 12]);
});

test('a lone string body is not a docstring', () => {
  const [d] = defs('(defun k () "value")');
  assert.equal(d.docstring, undefined);
});

test('declarations before the docstring are skipped', () => {
  const [d] = defs('(defun f (x) (declare (ignore x)) "doc" nil)');
  assert.equal(d.docstring, 'doc');
});

test('setf functions and macros', () => {
  const [setf, mac] = defs('(defun (setf thing) (value obj) value)\n(defmacro with-thing ((var) &body body) `(let ((,var 1)) ,@body))');
  assert.equal(setf.name, 'THING');
  assert.equal(setf.label, '(setf thing)');
  assert.equal(mac.kind, 'macro');
  assert.equal(mac.lambdaList, '((var) &body body)');
});

test('defmethod records qualifiers and specializers', () => {
  const [m] = defs('(defmethod print-object :around ((o point) stream)\n  "Doc."\n  (call-next-method))');
  assert.equal(m.kind, 'method');
  assert.equal(m.detail, ':around (point t)');
  assert.equal(m.docstring, 'Doc.');
});

test('defvar/defparameter/defconstant', () => {
  const [a, b, c] = defs('(defvar *a*)\n(defparameter *b* 1 "B doc")\n(defconstant +c+ 2)');
  assert.equal(a.kind, 'variable');
  assert.equal(a.docstring, undefined);
  assert.equal(b.docstring, 'B doc');
  assert.equal(c.kind, 'constant');
  assert.equal(c.label, '+c+');
});

test('defclass slots and accessors become children', () => {
  const [cls] = defs(`(defclass point ()
  ((x :initarg :x :accessor point-x)
   (y :initarg :y :reader point-y :writer (setf point-y!))
   z)
  (:documentation "A point."))`);
  assert.equal(cls.kind, 'class');
  assert.equal(cls.docstring, 'A point.');
  const kids = cls.children!.map((c) => `${c.kind}:${c.label}`);
  assert.deepEqual(kids, ['slot:x', 'accessor:point-x', 'slot:y', 'accessor:point-y', 'accessor:(setf point-y!)', 'slot:z']);
});

test('defstruct derives accessors, constructor, predicate and copier', () => {
  const [s] = defs('(defstruct (pt (:constructor make-pt (x y)) (:conc-name p-))\n  "A pt."\n  x (y 0))');
  assert.equal(s.kind, 'struct');
  assert.equal(s.docstring, 'A pt.');
  const labels = s.children!.map((c) => c.label);
  assert.deepEqual(labels, ['x', 'p-x', 'y', 'p-y', 'make-pt', 'pt-p', 'copy-pt']);
  const [plain] = defs('(defstruct node value next)');
  assert.deepEqual(plain.children!.map((c) => c.label), ['value', 'node-value', 'next', 'node-next', 'make-node', 'node-p', 'copy-node']);
});

test('defpackage exports and in-package tracking', () => {
  const analysis = analyze(parse('(defpackage #:app (:use #:cl) (:export #:run "MAIN" :helper))\n(in-package #:app)\n(defun run ())'));
  const [pkg, run] = analysis.definitions;
  assert.equal(pkg.kind, 'package');
  assert.equal(pkg.name, 'APP');
  assert.deepEqual(pkg.exports, ['RUN', 'MAIN', 'HELPER']);
  assert.equal(run.pkg, 'APP');
  assert.equal(pkg.pkg, null);
  assert.deepEqual(analysis.packages, ['APP']);
});

test('defsystem and define-condition', () => {
  const [sys, cond] = defs('(defsystem "my-sys" :description "Does things" :depends-on ("alexandria"))\n(define-condition my-error (error) ((code :initarg :code :reader my-error-code)))');
  assert.equal(sys.kind, 'system');
  assert.equal(sys.name, 'MY-SYS');
  assert.equal(sys.docstring, 'Does things');
  assert.equal(cond.kind, 'condition');
  assert.equal(cond.children!.length, 2);
});

test('unknown def-macros and nested top-level forms are picked up', () => {
  const list = defs('(eval-when (:compile-toplevel) (defun early ()))\n(progn (defvar *late*))\n(deftest my-test () (assert t))\n(let ((x 1)) (defun closure () x))');
  assert.deepEqual(list.map((d) => `${d.kind}:${d.label}`), ['function:early', 'variable:*late*', 'other:my-test', 'function:closure']);
  assert.equal(list[2].detail, 'deftest');
});

test('occurrences and keywords', () => {
  const analysis = analyze(parse('(defun f (x) (g x :mode x))'));
  assert.equal(analysis.occurrences.get('X')!.length, 3);
  assert.equal(analysis.occurrences.get('G')!.length, 1);
  assert.ok(analysis.keywords.has('MODE'));
  assert.equal(analysis.occurrences.get('MODE')![0].pkg, 'KEYWORD');
});
