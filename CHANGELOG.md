# Changelog

## 0.1.2

- The name is spelled `moro`, lowercase, everywhere: Marketplace listing, command palette category, context menu, settings section, output channel, REPL terminal and messages.

## 0.1.1

- Symbols used as types are now highlighted as types by the language server: `handler-case`, `handler-bind` and `typecase` clause heads, `declare`/`declaim`/`proclaim` specifiers including the `(fixnum x)` shorthand, `the`, `check-type`, quoted type arguments of `typep`, `coerce`, `make-instance`, `error` and friends, `defmethod` specializers, slot `:type` options and LOOP `of-type`. Fixes #1, where `(error (e) ...)` was colored as a function call.

## 0.1.0

First release.

- Syntax highlighting generated from the standard symbol database, with LOOP keywords, FORMAT directives, reader macros and package prefixes.
- Language server: outline, workspace symbols, go to definition, references, rename, highlights, hover, signature help, completion, semantic tokens, folding, selection ranges, diagnostics and Lisp-aware formatting (on type, document and range).
- REPL in the integrated terminal for SBCL, Roswell, CCL, ECL, CLISP and ABCL: evaluate forms, load and compile files, load and test ASDF systems, macroexpand, describe, apropos, interrupt, package sync.
- Structural editing: slurp, barf, splice, raise, wrap, select top-level form.
- Snippets and Markdown code block highlighting.
