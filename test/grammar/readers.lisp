; SYNTAX TEST "source.commonlisp"

'(a b c)
; <- keyword.operator.quote.commonlisp
;^ punctuation.section.parens.begin.commonlisp
; ^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
'foo
; <- keyword.operator.quote.commonlisp
;^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
#'mapcar
; <-- keyword.operator.function.commonlisp
; ^^^^^^ support.function.commonlisp
#'my-fn
; <-- keyword.operator.function.commonlisp
; ^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
#'list
; <-- keyword.operator.function.commonlisp
; ^^^^ support.function.commonlisp
#'(lambda (x) x)
; <-- keyword.operator.function.commonlisp
;  ^^^^^^ keyword.control.commonlisp
(funcall #'cl:car xs)
;^^^^^^^ support.function.commonlisp
;        ^^ keyword.operator.function.commonlisp
;          ^^ entity.name.namespace.package.commonlisp
;            ^ punctuation.accessor.commonlisp
;             ^^^ support.function.commonlisp
`(foo ,bar ,@baz ,.qux)
; <- keyword.operator.quote.commonlisp
; ^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;     ^ keyword.operator.quote.commonlisp
;          ^^ keyword.operator.quote.commonlisp
;                ^^ keyword.operator.quote.commonlisp
;                  ^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
#+sbcl (require :sb-posix)
; <-- keyword.control.reader-conditional.commonlisp
; ^^^^ constant.other.feature.commonlisp
;       ^^^^^^^ support.function.commonlisp
;               ^^^^^^^^^ constant.other.keyword.commonlisp
#-(or ccl ecl) 1
; <-- keyword.control.reader-conditional.commonlisp
; ^ punctuation.section.parens.begin.commonlisp
;  ^^ keyword.control.reader-conditional.commonlisp
;  ^^ meta.feature-expression.commonlisp
;     ^^^ constant.other.feature.commonlisp
;         ^^^ constant.other.feature.commonlisp
;            ^ punctuation.section.parens.end.commonlisp
;              ^ constant.numeric.integer.commonlisp
;              ^ - meta.feature-expression.commonlisp constant.other.feature.commonlisp
#+(and sbcl unix) nil
; <-- keyword.control.reader-conditional.commonlisp
;  ^^^ keyword.control.reader-conditional.commonlisp
;      ^^^^ constant.other.feature.commonlisp
;           ^^^^ constant.other.feature.commonlisp
;                 ^^^ constant.language.commonlisp
;                 ^^^ - constant.other.feature.commonlisp
#+(and sbcl (not (or :win32 darwin))) (list 1)
;  ^^^ keyword.control.reader-conditional.commonlisp
;      ^^^^ constant.other.feature.commonlisp
;           ^ punctuation.section.parens.begin.commonlisp
;            ^^^ keyword.control.reader-conditional.commonlisp
;                 ^^ keyword.control.reader-conditional.commonlisp
;                    ^^^^^^ constant.other.feature.commonlisp
;                           ^^^^^^ constant.other.feature.commonlisp
;                                      ^^^^ support.function.commonlisp
;                                      ^^^^ - constant.other.feature.commonlisp meta.feature-expression.commonlisp
#+(or sbcl   ; a comment inside the expression
;  ^^ keyword.control.reader-conditional.commonlisp
;     ^^^^ constant.other.feature.commonlisp
;            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ comment.line.semicolon.commonlisp
      ccl) (progn)
;     ^^^ constant.other.feature.commonlisp
;           ^^^^^ keyword.control.commonlisp
;           ^^^^^ - constant.other.feature.commonlisp
(list |multi
;     ^^^^^^ constant.other.symbol.escaped.commonlisp
line| 'next a\|b foo\(bar)
; <---- constant.other.symbol.escaped.commonlisp
;     ^ keyword.operator.quote.commonlisp
;      ^^^^ - constant.other.symbol.escaped.commonlisp
;            ^^ constant.character.escape.commonlisp
;              ^ - constant.other.symbol.escaped.commonlisp
;                   ^^ constant.character.escape.commonlisp
;                     ^^^ - punctuation.section.parens.begin.commonlisp
;                        ^ punctuation.section.parens.end.commonlisp
|with \| bar|
; <----------- constant.other.symbol.escaped.commonlisp
;     ^^ constant.character.escape.commonlisp
#+nil (broken)
; <-- keyword.control.reader-conditional.commonlisp
; ^^^ constant.other.feature.commonlisp
(cl:car x)
;^^ entity.name.namespace.package.commonlisp
;  ^ punctuation.accessor.commonlisp
;   ^^^ support.function.commonlisp
(uiop:getenv "HOME")
;^^^^ entity.name.namespace.package.commonlisp
;    ^ punctuation.accessor.commonlisp
;     ^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;            ^^^^^^ string.quoted.double.commonlisp
(sb-ext::posix-getenv "HOME")
;^^^^^^ entity.name.namespace.package.commonlisp
;      ^^ punctuation.accessor.commonlisp
;        ^^^^^^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
(cl:list 1 2)
;^^ entity.name.namespace.package.commonlisp
;   ^^^^ support.function.commonlisp
(coerce x 'cl:string)
;          ^^ entity.name.namespace.package.commonlisp
;             ^^^^^^ support.type.commonlisp
#(1 2 3)
; <- keyword.operator.reader-macro.commonlisp
;^ punctuation.section.parens.begin.commonlisp
; ^ constant.numeric.integer.commonlisp
;      ^ punctuation.section.parens.end.commonlisp
#*0101
; <------ keyword.operator.reader-macro.commonlisp
#.(+ 1 2)
; <-- keyword.operator.reader-macro.commonlisp
;  ^ support.function.commonlisp
#p"/tmp/"
; <-- keyword.operator.reader-macro.commonlisp
; ^^^^^^^ string.quoted.double.commonlisp
#c(1 2)
; <-- keyword.operator.reader-macro.commonlisp
; ^ punctuation.section.parens.begin.commonlisp
#s(point :x 1)
; <-- keyword.operator.reader-macro.commonlisp
;  ^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;        ^^ constant.other.keyword.commonlisp
#2A((1 2) (3 4))
; <--- keyword.operator.reader-macro.commonlisp
;          ^ constant.numeric.integer.commonlisp
#1=(a . #1#)
; <--- keyword.operator.reader-macro.commonlisp
;       ^^^ keyword.operator.reader-macro.commonlisp
#:uninterned
; <------------ constant.other.symbol.uninterned.commonlisp
:keyword
; <-------- constant.other.keyword.commonlisp
|odd symbol|
; <------------ constant.other.symbol.escaped.commonlisp
(list cl:t cl:nil)
;     ^^ entity.name.namespace.package.commonlisp
;       ^ punctuation.accessor.commonlisp
;        ^ constant.language.commonlisp
;             ^^^ constant.language.commonlisp
