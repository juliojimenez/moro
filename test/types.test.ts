import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/common/reader';
import { typePositions } from '../src/server/types';

function types(src: string): string[] {
  const result = parse(src);
  return typePositions(result).map((p) => src.slice(p.start, p.end));
}

test('handler-case, handler-bind and typecase clause heads', () => {
  assert.deepEqual(types('(handler-case (f) (error (e) e) (:no-error (v) v))'), ['error']);
  assert.deepEqual(types('(handler-bind ((error #\'handle) (warning (lambda (w) w))) (f))'), ['error', 'warning']);
  assert.deepEqual(types('(typecase x (string 1) ((or list vector) 2) (t 3) (otherwise 4))'), ['string', 'list', 'vector']);
  assert.deepEqual(types('(etypecase x ((integer 0 10) 1) ((member :a :b) 2) ((eql 3) 3))'), ['integer', 'member', 'eql']);
});

test('declarations, including the shorthand form', () => {
  assert.deepEqual(
    types('(declare (type fixnum a) (fixnum b) (ftype (function (list &optional string) (values integer &rest t)) g) (optimize (speed 3)) (ignore c))'),
    ['fixnum', 'fixnum', 'function', 'list', 'string', 'values', 'integer'],
  );
  assert.deepEqual(types('(declaim (inline foo) (type (simple-array character (*)) *buf*))'), ['simple-array', 'character']);
  assert.deepEqual(types("(proclaim '(special *x*)) (proclaim '(type string *y*))"), ['string']);
});

test('the, check-type and quoted type arguments', () => {
  assert.deepEqual(types('(the (simple-array character (*)) s)'), ['simple-array', 'character']);
  assert.deepEqual(types('(check-type n (integer 0 10))'), ['integer']);
  assert.deepEqual(types("(typep x 'string) (typep x y) (coerce x '(vector fixnum)) (make-instance 'point :x 1)"), ['string', 'vector', 'fixnum', 'point']);
  assert.deepEqual(types("(error 'my-error :code 1) (error e) (error \"~a\" e) (cerror \"go\" 'bad-thing) (signal 'sig) (warn 'w)"), ['my-error', 'bad-thing', 'sig', 'w']);
  assert.deepEqual(types("(make-array 3 :element-type 'character) (make-array 3 :element-type et)"), ['character']);
  assert.deepEqual(types("(concatenate 'string a b) (map 'list #'f xs) (make-sequence 'vector 3)"), ['string', 'list', 'vector']);
});

test('defmethod specializers, slot types and loop of-type', () => {
  assert.deepEqual(types('(defmethod m :around ((o point) (n integer) (k (eql 1)) &key (x list)) o)'), ['point', 'integer']);
  assert.deepEqual(types('(defclass c () ((x :type fixnum :initarg :x) y (z :type (or null string))))'), ['fixnum', 'null', 'string']);
  assert.deepEqual(types('(defstruct s (a 0 :type fixnum) b)'), ['fixnum']);
  assert.deepEqual(types('(define-condition e (error) ((code :type integer)))'), ['integer']);
  assert.deepEqual(types('(loop for i of-type fixnum from 0 below 3 for s of-type (or null string) in xs collect s)'), ['fixnum', 'null', 'string']);
});

test('nothing is reported for ordinary calls and variables', () => {
  assert.deepEqual(types('(error (format nil "x")) (list 1 2) (string x) (the-thing y) (typep x (type-of y))'), []);
});
