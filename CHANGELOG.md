# Changelog

## Unreleased

- Highlighting works when a `(` ends its line (the first token of a later line is classified as the head) and when a definer ends its line (the name on a later line is captured, including `(setf name)`, strings and `(name options)` for `defstruct`). The language server also emits semantic tokens for every definition name, so names are colored wherever they sit. Fixes #2.
- Feature expressions after `#+` and `#-` are highlighted as such: `and`, `or` and `not` share the reader-conditional color and every other symbol is a feature, nested and across lines. `|escaped symbols|` may span lines, and a backslash escape inside a symbol (`a\|b`, `foo\(bar`) is recognized. Fixes #3.
- LOOP indentation follows SLIME's `common-lisp-indent-loop-macro-1`: a conditional, or an `else`/`and` alone on its line, indents the next clause two more; continuation keywords (`in`, `=`, `then`, `by`, `of-type`, ...) go two past the clause keyword and align with each other; `and` takes the indentation of the nearest earlier clause line; a body keyword alone on its line indents its forms three in; a form where a clause was expected aligns under the previous form. A conditional whose body clause is on the same line does not indent what follows. Fixes #4.
- A `#+feature` or `#-feature` alone on a line is indented as the argument it guards, and the form on the next line gets the same indentation instead of being counted as a further argument; this also holds inside LOOP and lambda lists, and a feature-prefixed LOOP keyword still introduces its clause. Fixes #5.
- The systems a workspace depends on are indexed as read-only dependencies: `:depends-on` of its `.asd` files and `ql:quickload`/`asdf:load-system` calls are resolved transitively through `ocicl.csv` and `ocicl/`, `.qlot/`, Quicklisp, Roswell, `~/common-lisp`, the ASDF source-registry configuration and `CL_SOURCE_REGISTRY`. Exported dependency symbols complete (after workspace and standard symbols), every dependency definition has hover, signature help and go to definition, and rename leaves library files alone. New settings `moro.dependencies.index`, `moro.dependencies.registries` and `moro.dependencies.maxFiles`; `quicklisp/`, `.qlot/` and `ocicl/` are excluded from the workspace scan by default. Part of #6.
- The REPL starts with a backend loaded into the image (`lisp/moro-backend.lisp`) and the language server asks it, when the static sources have no answer, for completion, hover, signature help and go to definition of whatever is loaded, in any package: a background thread on a loopback port, a token file readable only by you, requests read with `*read-eval*` nil and never evaluated. SBCL, ECL, Clozure CL, ABCL and Roswell; source locations from SBCL. The status bar shows the connected image; `moro.repl.liveBackend` turns it off. Fixes #6.

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
