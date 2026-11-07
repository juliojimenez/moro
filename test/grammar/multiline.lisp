; SYNTAX TEST "source.commonlisp"

(
 defun foo ()
;^^^^^ storage.type.commonlisp
;      ^^^ entity.name.function.commonlisp
 nil)

(defun
    very-long-method-name ()
;   ^^^^^^^^^^^^^^^^^^^^^ entity.name.function.commonlisp
  nil)

(defun
    (setf thing) (value obj)
;   ^ punctuation.section.parens.begin.commonlisp
;    ^^^^ keyword.control.commonlisp
;         ^^^^^ entity.name.function.commonlisp
;              ^ punctuation.section.parens.end.commonlisp
;                 ^^^^^ - entity.name.function.commonlisp
  value)

(defmacro   ; a comment after the definer
  with-it ((var) &body body)
; ^^^^^^^ entity.name.function.commonlisp
;          ^^^ - entity.name.function.commonlisp
  `(let ((,var 1)) ,@body))

(defvar
  *level* 42)
; ^^^^^^^ variable.other.global.commonlisp
;         ^^ constant.numeric.integer.commonlisp
;         ^^ - variable.other.global.commonlisp

(defconstant
  +limit+ 10 "doc")
; ^^^^^^^ variable.other.constant.commonlisp
;            ^^^^^ string.quoted.double.commonlisp

(defclass
    thing (base mixin)
;   ^^^^^ entity.name.type.class.commonlisp
;          ^^^^ - entity.name.type.class.commonlisp
  ())

(define-condition
  my-error (error)
; ^^^^^^^^ entity.name.type.class.commonlisp
  ())

(deftype
  octet () '(unsigned-byte 8))
; ^^^^^ entity.name.type.class.commonlisp

(defpackage
  #:pkg
; ^^^^^ entity.name.namespace.commonlisp
  (:use #:cl))

(defsystem
  "my-system"
; ^^^^^^^^^^^ entity.name.namespace.commonlisp
  :components ())

(defstruct
  point x y)
; ^^^^^ entity.name.type.class.commonlisp
;       ^ - entity.name.type.class.commonlisp

(defstruct
  (pt (:constructor make-pt))
; ^ punctuation.section.parens.begin.commonlisp
;  ^^ entity.name.type.class.commonlisp
;      ^^^^^^^^^^^^ constant.other.keyword.commonlisp
  x)

(
  when x
; ^^^^ keyword.control.commonlisp
  (list x))

(
  list 1 2)
; ^^^^ support.function.commonlisp
;      ^ constant.numeric.integer.commonlisp

(
  cl:car xs)
; ^^ entity.name.namespace.package.commonlisp
;   ^ punctuation.accessor.commonlisp
;    ^^^ support.function.commonlisp

(   ; comment right after the paren
  declare (optimize (speed 3)))
; ^^^^^^^ keyword.other.declaration.commonlisp

(
  defstruct node value next)
; ^^^^^^^^^ storage.type.commonlisp
;           ^^^^ entity.name.type.class.commonlisp
;                ^^^^^ - entity.name.type.class.commonlisp

(
  defclass
; ^^^^^^^^ storage.type.commonlisp
    widget (base)
;   ^^^^^^ entity.name.type.class.commonlisp
  ())

(
  my-function 1 2)
; ^^^^^^^^^^^ - keyword.control.commonlisp support.function.commonlisp storage.type.commonlisp
;             ^ constant.numeric.integer.commonlisp

(list (foo)
  when)
; ^^^^ - keyword.control.commonlisp

(defun same-line (x) x)
;      ^^^^^^^^^ entity.name.function.commonlisp
;                 ^ - entity.name.function.commonlisp
