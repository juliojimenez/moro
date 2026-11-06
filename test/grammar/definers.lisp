; SYNTAX TEST "source.commonlisp"

(defun foo (a b &optional c) "doc" (list a b c))
; <- punctuation.section.parens.begin.commonlisp
;^^^^^ storage.type.commonlisp
;      ^^^ entity.name.function.commonlisp
;               ^^^^^^^^^ storage.modifier.lambda-list.commonlisp
;                            ^^^^^ string.quoted.double.commonlisp
;                                   ^^^^ support.function.commonlisp
;                                            ^^^ - entity.name.function.commonlisp
;                                             ^^ punctuation.section.parens.end.commonlisp
(defun (setf foo) (value obj) value)
;^^^^^ storage.type.commonlisp
;       ^^^^ keyword.control.commonlisp
;            ^^^ entity.name.function.commonlisp
;      ^ punctuation.section.parens.begin.commonlisp
;               ^ punctuation.section.parens.end.commonlisp
;                  ^^^^^ - entity.name.function.commonlisp
(defmacro with-thing ((var val) &body body) `(let ((,var ,val)) ,@body))
;^^^^^^^^ storage.type.commonlisp
;         ^^^^^^^^^^ entity.name.function.commonlisp
;                               ^^^^^ storage.modifier.lambda-list.commonlisp
;                                           ^ keyword.operator.quote.commonlisp
;                                             ^^^ keyword.control.commonlisp
;                                                   ^ keyword.operator.quote.commonlisp
;                                                               ^^ keyword.operator.quote.commonlisp
;                                                    ^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(defgeneric area (shape) (:documentation "Area."))
;^^^^^^^^^^ storage.type.commonlisp
;           ^^^^ entity.name.function.commonlisp
;                         ^^^^^^^^^^^^^^ constant.other.keyword.commonlisp
;                                        ^^^^^^^ string.quoted.double.commonlisp
(defmethod print-object ((o foo) stream) (print-unreadable-object (o stream :type t)))
;^^^^^^^^^ storage.type.commonlisp
;          ^^^^^^^^^^^^ entity.name.function.commonlisp
;                                ^^^^^^ support.type.commonlisp
;                                         ^^^^^^^^^^^^^^^^^^^^^^^ keyword.control.commonlisp
;                                                                           ^^^^^ constant.other.keyword.commonlisp
;                                                                                 ^ constant.language.commonlisp
(defmethod (setf area) :around (value (s square)) (call-next-method))
;^^^^^^^^^ storage.type.commonlisp
;           ^^^^ keyword.control.commonlisp
;                ^^^^ entity.name.function.commonlisp
;                      ^^^^^^^ constant.other.keyword.commonlisp
;                                                  ^^^^^^^^^^^^^^^^ support.function.commonlisp
(defvar *registry* (make-hash-table) "Doc.")
;^^^^^^ storage.type.commonlisp
;       ^^^^^^^^^^ variable.other.global.commonlisp
;                   ^^^^^^^^^^^^^^^ support.function.commonlisp
;                                    ^^^^^^ string.quoted.double.commonlisp
(defparameter *count* 0)
;^^^^^^^^^^^^ storage.type.commonlisp
;             ^^^^^^^ variable.other.global.commonlisp
;                     ^ constant.numeric.integer.commonlisp
(defconstant +limit+ 100)
;^^^^^^^^^^^ storage.type.commonlisp
;            ^^^^^^^ variable.other.constant.commonlisp
;                    ^^^ constant.numeric.integer.commonlisp
(defclass point (shape) ((x :initarg :x :accessor point-x)) (:documentation "A point."))
;^^^^^^^^ storage.type.commonlisp
;         ^^^^^ entity.name.type.class.commonlisp
;                ^^^^^ entity.other.inherited-class.commonlisp
;                         ^^^ - entity.name.type.class.commonlisp entity.name.function.commonlisp
;                           ^^^^^^^^ constant.other.keyword.commonlisp
;                                                 ^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(defclass circle (shape drawable)
;^^^^^^^^ storage.type.commonlisp
;         ^^^^^^ entity.name.type.class.commonlisp
;                 ^^^^^ entity.other.inherited-class.commonlisp
;                       ^^^^^^^^ entity.other.inherited-class.commonlisp
  ((radius :initarg :radius)))
;   ^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp entity.other.inherited-class.commonlisp
;          ^^^^^^^^ constant.other.keyword.commonlisp
(deftype my-list (item) `(cons ,item list))
;^^^^^^^ storage.type.commonlisp
;        ^^^^^^^ entity.name.type.class.commonlisp
;                 ^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp entity.other.inherited-class.commonlisp
;                         ^^^^ support.function.commonlisp
;                                    ^^^^ support.type.commonlisp
(define-condition my-error (error) ((code :reader code)))
;^^^^^^^^^^^^^^^^ storage.type.commonlisp
;                 ^^^^^^^^ entity.name.type.class.commonlisp
;                           ^^^^^ entity.other.inherited-class.commonlisp
;                                    ^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(deftype octet () '(unsigned-byte 8))
;^^^^^^^ storage.type.commonlisp
;        ^^^^^ entity.name.type.class.commonlisp
;                 ^ keyword.operator.quote.commonlisp
;                   ^^^^^^^^^^^^^ support.type.commonlisp
;                                 ^ constant.numeric.integer.commonlisp
(defstruct point x y)
;^^^^^^^^^ storage.type.commonlisp
;          ^^^^^ entity.name.type.class.commonlisp
;                ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                  ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(defstruct (pt (:constructor make-pt) (:copier nil)) (x 0 :type fixnum) y)
;^^^^^^^^^ storage.type.commonlisp
;          ^ punctuation.section.parens.begin.commonlisp
;           ^^ entity.name.type.class.commonlisp
;               ^^^^^^^^^^^^ constant.other.keyword.commonlisp
;                            ^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                      ^^^^^^^ constant.other.keyword.commonlisp
;                                              ^^^ constant.language.commonlisp
;                                                     ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                                       ^ constant.numeric.integer.commonlisp
;                                                         ^^^^^ constant.other.keyword.commonlisp
;                                                               ^^^^^^ support.type.commonlisp
;                                                                       ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                                                        ^ punctuation.section.parens.end.commonlisp
(car z)
;^^^ support.function.commonlisp
(defpackage #:my-pkg (:use #:cl) (:export #:foo "BAR"))
;^^^^^^^^^^ storage.type.commonlisp
;           ^^^^^^^^ entity.name.namespace.commonlisp
;                     ^^^^ constant.other.keyword.commonlisp
;                          ^^^^ constant.other.symbol.uninterned.commonlisp
;                                 ^^^^^^^ constant.other.keyword.commonlisp
;                                         ^^^^^ constant.other.symbol.uninterned.commonlisp
;                                               ^^^^^ string.quoted.double.commonlisp
(in-package :my-pkg)
;^^^^^^^^^^ storage.type.commonlisp
;           ^^^^^^^ entity.name.namespace.commonlisp
(in-package "MY-PKG")
;^^^^^^^^^^ storage.type.commonlisp
;           ^^^^^^^^ entity.name.namespace.commonlisp
(uiop:define-package #:other (:mix :cl))
;^^^^ entity.name.namespace.package.commonlisp
;    ^ punctuation.accessor.commonlisp
;     ^^^^^^^^^^^^^^ storage.type.commonlisp
;                    ^^^^^^^ entity.name.namespace.commonlisp
;                             ^^^^ constant.other.keyword.commonlisp
(define-symbol-macro here *here*)
;^^^^^^^^^^^^^^^^^^^ storage.type.commonlisp
;                    ^^^^ variable.other.global.commonlisp
(defsetf foo set-foo)
;^^^^^^^ storage.type.commonlisp
;        ^^^ entity.name.function.commonlisp
;            ^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(define-modify-macro appendf (&rest args) append)
;^^^^^^^^^^^^^^^^^^^ storage.type.commonlisp
;                    ^^^^^^^ entity.name.function.commonlisp
;                             ^^^^^ storage.modifier.lambda-list.commonlisp
;                                         ^^^^^^ support.function.commonlisp
(define-compiler-macro square (&whole form x) form)
;^^^^^^^^^^^^^^^^^^^^^ storage.type.commonlisp
;                      ^^^^^^ entity.name.function.commonlisp
;                              ^^^^^^ storage.modifier.lambda-list.commonlisp
(defun-ish x)
; <- punctuation.section.parens.begin.commonlisp
;^^^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(DEFUN BAR (X) X)
;^^^^^ storage.type.commonlisp
;      ^^^ entity.name.function.commonlisp
(my-pkg:defun baz () 1)
;^^^^^^ entity.name.namespace.package.commonlisp
;      ^ punctuation.accessor.commonlisp
;       ^^^^^ storage.type.commonlisp
;             ^^^ entity.name.function.commonlisp
