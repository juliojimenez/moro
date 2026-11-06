; SYNTAX TEST "source.commonlisp"

(loop for x in xs
; <- punctuation.section.parens.begin.commonlisp
;^^^^ keyword.control.commonlisp
;     ^^^ keyword.control.loop.commonlisp
;           ^^ keyword.control.loop.commonlisp
;              ^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
      for y = (in x)
;     ^^^ keyword.control.loop.commonlisp
;           ^ keyword.control.loop.commonlisp
;              ^^ - keyword.control.loop.commonlisp
      when (evenp y)
;     ^^^^ keyword.control.loop.commonlisp
;           ^^^^^ support.function.commonlisp
        collect (format nil "~a" y) into result
;       ^^^^^^^ keyword.control.loop.commonlisp
;                ^^^^^^ support.function.commonlisp
;                       ^^^ constant.language.commonlisp
;                           ^ string.quoted.double.commonlisp
;                            ^^ constant.other.placeholder.format.commonlisp
;                                   ^^^^ keyword.control.loop.commonlisp
;                                        ^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
      finally (return result))
;     ^^^^^^^ keyword.control.loop.commonlisp
;              ^^^^^^ keyword.control.commonlisp - keyword.control.loop.commonlisp
;                           ^^ punctuation.section.parens.end.commonlisp
(loop repeat 3 do (print "hi"))
;     ^^^^^^ keyword.control.loop.commonlisp
;            ^ constant.numeric.integer.commonlisp
;              ^^ keyword.control.loop.commonlisp
;                  ^^^^^ support.function.commonlisp
(cl:loop for i below 10 sum i)
;^^ entity.name.namespace.package.commonlisp
;   ^^^^ keyword.control.commonlisp
;        ^^^ keyword.control.loop.commonlisp
;              ^^^^^ keyword.control.loop.commonlisp
;                       ^^^ keyword.control.loop.commonlisp
(loop for a in as nconc (loop for b in bs collect (cons a b)))
;                        ^^^^ keyword.control.commonlisp
;                             ^^^ keyword.control.loop.commonlisp
;                 ^^^^^ keyword.control.loop.commonlisp
;                                         ^^^^^^^ keyword.control.loop.commonlisp
;                                                  ^^^^ support.function.commonlisp
(loop with x = 1 and y = 2 while (< x 10) do (incf x) (incf y))
;     ^^^^ keyword.control.loop.commonlisp
;                ^^^ keyword.control.loop.commonlisp
;                          ^^^^^ keyword.control.loop.commonlisp
;                                 ^ support.function.commonlisp
;                                         ^^ keyword.control.loop.commonlisp
;                                             ^^^^ keyword.control.commonlisp
(loop for k being the hash-keys of h using (hash-value v) collect k)
;           ^^^^^ keyword.control.loop.commonlisp
;                 ^^^ keyword.control.loop.commonlisp
;                     ^^^^^^^^^ keyword.control.loop.commonlisp
;                               ^^ keyword.control.loop.commonlisp
;                                    ^^^^^ keyword.control.loop.commonlisp
;                                           ^^^^^^^^^^ - keyword.control.loop.commonlisp
(loop)
;^^^^ keyword.control.commonlisp
;    ^ punctuation.section.parens.end.commonlisp
(list for in do collect)
;     ^^^ - keyword.control.loop.commonlisp
;         ^^ - keyword.control.loop.commonlisp
;            ^^ - keyword.control.loop.commonlisp keyword.control.commonlisp
;               ^^^^^^^ - keyword.control.loop.commonlisp
(dolist (x xs) (loop for y in x do (print y)))
;^^^^^^ keyword.control.commonlisp
;                    ^^^ keyword.control.loop.commonlisp
;                                   ^^^^^ support.function.commonlisp
