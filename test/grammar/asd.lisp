; SYNTAX TEST "source.commonlisp"

(defsystem "my-system"
; <- punctuation.section.parens.begin.commonlisp
;^^^^^^^^^ storage.type.commonlisp
;          ^^^^^^^^^^^ entity.name.namespace.commonlisp
  :description "Example"
; ^^^^^^^^^^^^ constant.other.keyword.commonlisp
;              ^^^^^^^^^ string.quoted.double.commonlisp
  :version "0.1.0"
; ^^^^^^^^ constant.other.keyword.commonlisp
;          ^^^^^^^ string.quoted.double.commonlisp
  :depends-on ("alexandria" "cl-ppcre")
; ^^^^^^^^^^^ constant.other.keyword.commonlisp
;              ^^^^^^^^^^^^ string.quoted.double.commonlisp
  :components ((:module "src"
; ^^^^^^^^^^^ constant.other.keyword.commonlisp
;               ^^^^^^^ constant.other.keyword.commonlisp
;                       ^^^^^ string.quoted.double.commonlisp
                :components ((:file "package")
;                             ^^^^^ constant.other.keyword.commonlisp
;                                   ^^^^^^^^^ string.quoted.double.commonlisp
                             (:file "main" :depends-on ("package")))))
;                             ^^^^^ constant.other.keyword.commonlisp
;                                          ^^^^^^^^^^^ constant.other.keyword.commonlisp
  :in-order-to ((test-op (test-op "my-system/tests"))))
; ^^^^^^^^^^^^ constant.other.keyword.commonlisp
;                ^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                 ^^^^^^^^^^^^^^^^^ string.quoted.double.commonlisp
;                                                  ^^^^ punctuation.section.parens.end.commonlisp
(asdf:defsystem #:foo :class :package-inferred-system)
;^^^^ entity.name.namespace.package.commonlisp
;    ^ punctuation.accessor.commonlisp
;     ^^^^^^^^^ storage.type.commonlisp
;               ^^^^^ entity.name.namespace.commonlisp
;                     ^^^^^^ constant.other.keyword.commonlisp
;                            ^^^^^^^^^^^^^^^^^^^^^^^^ constant.other.keyword.commonlisp
(defsystem my-system/tests :depends-on ("my-system" "fiveam") :perform (test-op (o c) (symbol-call :fiveam :run! :my-system)))
;          ^^^^^^^^^^^^^^^ entity.name.namespace.commonlisp
;                                                             ^^^^^^^^ constant.other.keyword.commonlisp
;                                                                                      ^^^^^^^^^^^ - support.function.commonlisp support.type.commonlisp keyword.control.commonlisp keyword.control.loop.commonlisp constant.other.keyword.commonlisp constant.character.commonlisp constant.numeric.integer.commonlisp constant.numeric.float.commonlisp entity.name.function.commonlisp entity.name.type.class.commonlisp variable.other.global.commonlisp entity.name.namespace.commonlisp storage.type.commonlisp keyword.other.declaration.commonlisp constant.other.feature.commonlisp support.variable.commonlisp support.constant.commonlisp
;                                                                                                          ^^^^^ constant.other.keyword.commonlisp
