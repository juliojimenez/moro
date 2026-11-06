; SYNTAX TEST "source.commonlisp"

;; a line comment
; <----------------- comment.line.semicolon.commonlisp
#| block #| nested |# still comment |# (car x)
; <-------------------------------------- comment.block.commonlisp
;                                       ^^^ support.function.commonlisp
;                                           ^^ - comment.block.commonlisp
#!/usr/bin/env sbcl --script
; <---------------------------- comment.line.shebang.commonlisp
#!/bin/sh
; <--------- comment.line.shebang.commonlisp
#|-*- mode:lisp -*-|#
; <--------------------- comment.block.commonlisp
#|
; <-- comment.block.commonlisp
exec ros -Q -- $0 "$@"
; <---------------------- comment.block.commonlisp
|#
; <-- comment.block.commonlisp
(print "after the roswell header")
;^^^^^ support.function.commonlisp
;      ^^^^^^ string.quoted.double.commonlisp
"a string with \" escape and ~a ~5,'0d ~% ~{~a~^, ~} ~/my-fn/ ~:@(x~) ~2,8:@T directives"
; <--------- string.quoted.double.commonlisp
;              ^^ string.quoted.double.commonlisp constant.character.escape.commonlisp
;                            ^^ string.quoted.double.commonlisp constant.other.placeholder.format.commonlisp
;                               ^^^^^^ constant.other.placeholder.format.commonlisp
;                                      ^^ constant.other.placeholder.format.commonlisp
;                                         ^^ constant.other.placeholder.format.commonlisp
;                                             ^^ constant.other.placeholder.format.commonlisp
;                                                 ^^ constant.other.placeholder.format.commonlisp
;                                                    ^^^^^^^^ constant.other.placeholder.format.commonlisp
;                                                             ^^^^ constant.other.placeholder.format.commonlisp
;                                                                  ^^ constant.other.placeholder.format.commonlisp
;                                                                     ^^^^^^^ constant.other.placeholder.format.commonlisp
;                                                                             ^^^^^^^^^^ string.quoted.double.commonlisp - constant.other.placeholder.format.commonlisp
(format t "~a~%" x)
;^^^^^^ support.function.commonlisp
;       ^ constant.language.commonlisp
;         ^ string.quoted.double.commonlisp
;          ^^ constant.other.placeholder.format.commonlisp
;            ^^ constant.other.placeholder.format.commonlisp
;                ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(list #\a #\Space #\( #\) #\; #\" #\U+1F600 #\\ #\  x)
;^^^^ support.function.commonlisp
;     ^^^ constant.character.commonlisp
;         ^^^^^^^ constant.character.commonlisp
;                 ^^^ constant.character.commonlisp
;                     ^^^ constant.character.commonlisp
;                         ^^^ constant.character.commonlisp
;                             ^^^ constant.character.commonlisp
;                                 ^^^^^^^^^ constant.character.commonlisp
;                                           ^^^ constant.character.commonlisp
;                                               ^^^ constant.character.commonlisp
;                                                   ^ - constant.character.commonlisp comment.line.semicolon.commonlisp string.quoted.double.commonlisp
;                                                   ^^ - constant.character.commonlisp
(loop for c in (list #\( #\)) do (print c))
;^^^^ keyword.control.commonlisp
;     ^^^ keyword.control.loop.commonlisp
;                             ^^ keyword.control.loop.commonlisp
;                                 ^^^^^ support.function.commonlisp
(list 42 -7 +3 1. 1/3 -2/5 3.14 .5 -.5 1e10 1.5d0 2.e3 1.0f-3 #xFF #x-1a #b1010 #o17 #36rZZ #2r101/11)
;     ^^ constant.numeric.integer.commonlisp
;        ^^ constant.numeric.integer.commonlisp
;           ^^ constant.numeric.integer.commonlisp
;              ^^ constant.numeric.integer.commonlisp
;                 ^^^ constant.numeric.ratio.commonlisp
;                     ^^^^ constant.numeric.ratio.commonlisp
;                          ^^^^ constant.numeric.float.commonlisp
;                               ^^ constant.numeric.float.commonlisp
;                                  ^^^ constant.numeric.float.commonlisp
;                                      ^^^^ constant.numeric.float.commonlisp
;                                           ^^^^^ constant.numeric.float.commonlisp
;                                                 ^^^^ constant.numeric.float.commonlisp
;                                                      ^^^^^^ constant.numeric.float.commonlisp
;                                                             ^^^^ constant.numeric.radix.commonlisp
;                                                                  ^^^^^ constant.numeric.radix.commonlisp
;                                                                        ^^^^^^ constant.numeric.radix.commonlisp
;                                                                               ^^^^ constant.numeric.radix.commonlisp
;                                                                                    ^^^^^^ constant.numeric.radix.commonlisp
;                                                                                           ^^^^^^^^^ constant.numeric.radix.commonlisp
(list 1+ 1- - + * / = /= < > <= >= +x+ foo-1 1x 12abc)
;     ^^ support.function.commonlisp
;        ^^ support.function.commonlisp
;           ^ support.function.commonlisp
;             ^ support.function.commonlisp
;               ^ support.function.commonlisp
;                 ^ support.function.commonlisp
;                   ^ support.function.commonlisp
;                     ^^ support.function.commonlisp
;                        ^ support.function.commonlisp
;                          ^ support.function.commonlisp
;                            ^^ support.function.commonlisp
;                               ^^ support.function.commonlisp
;                                  ^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                      ^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                            ^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                               ^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(:use #:cl :foo |Mixed Case| &optional &key &rest &allow-other-keys)
;^^^^ constant.other.keyword.commonlisp
;     ^^^^ constant.other.symbol.uninterned.commonlisp
;          ^^^^ constant.other.keyword.commonlisp
;               ^^^^^^^^^^^^ constant.other.symbol.escaped.commonlisp
;                            ^^^^^^^^^ storage.modifier.lambda-list.commonlisp
;                                      ^^^^ storage.modifier.lambda-list.commonlisp
;                                           ^^^^^ storage.modifier.lambda-list.commonlisp
;                                                 ^^^^^^^^^^^^^^^^^ storage.modifier.lambda-list.commonlisp
(if (null x) t nil)
;^^ keyword.control.commonlisp
;    ^^^^ support.function.commonlisp
;            ^ constant.language.commonlisp
;              ^^^ constant.language.commonlisp
(IF (NULL X) T NIL)
;^^ keyword.control.commonlisp
;    ^^^^ support.function.commonlisp
;            ^ constant.language.commonlisp
;              ^^^ constant.language.commonlisp
(let ((*print-base* 16) (y pi)) (print most-positive-fixnum))
;^^^ keyword.control.commonlisp
;      ^^^^^^^^^^^^ support.variable.commonlisp
;                   ^^ constant.numeric.integer.commonlisp
;                          ^^ support.constant.commonlisp
;                                ^^^^^ support.function.commonlisp
;                                      ^^^^^^^^^^^^^^^^^^^^ support.constant.commonlisp
(declare (type fixnum x) (optimize (speed 3) (safety 1)) (ignore y))
;^^^^^^^ keyword.other.declaration.commonlisp
;         ^^^^ keyword.other.declaration.commonlisp
;              ^^^^^^ support.type.commonlisp
;                         ^^^^^^^^ keyword.other.declaration.commonlisp
;                                   ^^^^^ keyword.other.declaration.commonlisp
;                                         ^ constant.numeric.integer.commonlisp
;                                             ^^^^^^ keyword.other.declaration.commonlisp
;                                                         ^^^^^^ keyword.other.declaration.commonlisp
;                                                                ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(declaim (inline foo) (ftype (function (fixnum) fixnum) bar))
;^^^^^^^ keyword.other.declaration.commonlisp
;         ^^^^^^ keyword.other.declaration.commonlisp
;                      ^^^^^ keyword.other.declaration.commonlisp
;                             ^^^^^^^^ keyword.control.commonlisp
;                                       ^^^^^^ support.type.commonlisp
(proclaim '(special *x*))
;^^^^^^^^ keyword.other.declaration.commonlisp
;           ^^^^^^^ keyword.other.declaration.commonlisp
(the fixnum (car xs))
;^^^ keyword.control.commonlisp
;    ^^^^^^ support.type.commonlisp
;            ^^^ support.function.commonlisp
(make-array 3 :element-type 'character :initial-element #\a)
;^^^^^^^^^^ support.function.commonlisp
;             ^^^^^^^^^^^^^ constant.other.keyword.commonlisp
;                           ^ keyword.operator.quote.commonlisp
;                            ^^^^^^^^^ support.type.commonlisp
;                                                       ^^^ constant.character.commonlisp
(string x)
;^^^^^^ support.function.commonlisp
(coerce x 'string)
;^^^^^^ support.function.commonlisp
;          ^^^^^^ support.type.commonlisp
(mapcar car lists)
;^^^^^^ support.function.commonlisp
;   ^^^ support.function.commonlisp
(case x (otherwise 1))
;^^^^ keyword.control.commonlisp
;        ^^^^^^^^^ keyword.control.commonlisp
( when x)
; ^^^^ keyword.control.commonlisp
(setf (gethash k h) v)
;^^^^ keyword.control.commonlisp
;      ^^^^^^^ support.function.commonlisp
(funcall fn speed type)
;           ^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                 ^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(handler-case (foo) (error (e) (print e)))
;^^^^^^^^^^^^ keyword.control.commonlisp
;                    ^^^^^ support.function.commonlisp
;                               ^^^^^ support.function.commonlisp
(lambda (x) (* x x))
;^^^^^^ keyword.control.commonlisp
;            ^ support.function.commonlisp
(function car)
;^^^^^^^^ keyword.control.commonlisp
;         ^^^ support.function.commonlisp
