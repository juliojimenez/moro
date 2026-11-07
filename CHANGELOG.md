# Changelog

## 0.4.1

- Add ASDF System from Outside the Workspace no longer fails when the chosen `.asd` cannot be written to `moro.systems`, which happens when a moro update was applied without reloading the window and the setting is not registered yet. It explains, suggests the reload, and still offers the chosen system for loading now.

## 0.4.0

- Systems outside the workspace. The system picker of Load ASDF System and Test ASDF System lists the systems defined in the workspace and those in the new `moro.systems` setting (`.asd` files or directories, absolute, `~`-prefixed or relative to a workspace folder), and offers to browse for an `.asd` anywhere on disk, remembering it in that setting; the new **Add ASDF System from Outside the Workspace…** command does the same from the palette. The directories of all known systems go on ASDF's central registry before a load, so systems that depend on each other resolve without a source-registry setup. The language server indexes the systems in `moro.systems` like dependencies: completion, hover, signature help and go to definition for their exports, read-only. `moro.repl.loadOnStart` names systems to load as soon as the REPL is up and the backend has connected. Both commands accept a system name as an argument, for keybindings and tasks. The server also reads its settings from `initializationOptions.settings` for clients without `workspace/configuration`.

## 0.3.1

- Backtraces from Clozure CL show the frames of your code only, with arguments printed plainly, instead of CCL's error machinery and evaluator frames with quoted arguments.
- README: the getting-started steps and the known limitations describe the debugger panel and what each implementation reports.

## 0.3.0

- Go to definition through the live image works on Clozure CL, ECL and ABCL as well as SBCL: the backend reads CCL's source notes, ECL's location annotations and ABCL's source property, and the language server maps each implementation's idea of a position (the start of the form, or where the reader stood before it) to the form in the file. Smoke tests run the backend on each of these implementations when it is installed; CI runs them on SBCL and ECL. Fixes #27.
- Fixed: go to definition through an SBCL image landed on the form before the definition, because SBCL reports where the reader stood before reading the form. CCL arglists show keyword parameters as plain names (`&key b`, not `&key :b`).
- An error in an evaluation sent to the image opens the **moro debugger** panel instead of abandoning the form: the condition, the restarts established inside the evaluation and the backtrace. A restart resumes the evaluation in the image (`use-value` and `store-value` prompt for a form; number keys choose a restart); Abort, closing the panel or Interrupt Evaluation abandon it and report the error with the backtrace. Frames expand to their local variables (SBCL), and locals and the condition open in the inspector. The status bar shows `moro: debugger` while an evaluation waits there, and new evaluations are refused until it is answered. New setting `moro.repl.debugger` (on by default) restores the plain backtrace behaviour when off. Fixes #26.
- Fixed: Load ASDF System and Test ASDF System failed with "Package ASDF does not exist" in an image started without an init file. The forms sent now require ASDF first and name its functions without reading `asdf:` symbols; a workspace with `ocicl.csv` loads the ocicl runtime, one with `.qlot/setup.lisp` loads it, and the `quicklisp` loader loads `~/quicklisp/setup.lisp` when Quicklisp is not in the image yet.

## 0.2.2

- Macroexpand, describe and apropos run through the image when the backend is connected: the expansion opens as a highlighted Common Lisp document beside the editor and is logged to the results channel; describe and apropos output appears in the results channel. The terminal remains the fallback. Fixes #24.
- LOOP clause keywords are colored when the `(` of the loop ends the previous line. Fixes #25.
- Fixed: a form spanning several lines failed to evaluate, inspect or macroexpand through the image with an end-of-file error, and the leftover lines could misalign later answers. The backend now reads whole request forms instead of lines. Backtraces reported for errors in the image no longer include the evaluator and compiler frames.

## 0.2.1

- Documentation release: the README opens with what moro is, has a getting-started section and documents every setting; the Marketplace description says the same. No code changes.

## 0.2.0

- Highlighting works when a `(` ends its line (the first token of a later line is classified as the head) and when a definer ends its line (the name on a later line is captured, including `(setf name)`, strings and `(name options)` for `defstruct`). The language server also emits semantic tokens for every definition name, so names are colored wherever they sit. Fixes #2.
- Feature expressions after `#+` and `#-` are highlighted as such: `and`, `or` and `not` share the reader-conditional color and every other symbol is a feature, nested and across lines. `|escaped symbols|` may span lines, and a backslash escape inside a symbol (`a\|b`, `foo\(bar`) is recognized. Fixes #3.
- LOOP indentation follows SLIME's `common-lisp-indent-loop-macro-1`: a conditional, or an `else`/`and` alone on its line, indents the next clause two more; continuation keywords (`in`, `=`, `then`, `by`, `of-type`, ...) go two past the clause keyword and align with each other; `and` takes the indentation of the nearest earlier clause line; a body keyword alone on its line indents its forms three in; a form where a clause was expected aligns under the previous form. A conditional whose body clause is on the same line does not indent what follows. Fixes #4.
- A `#+feature` or `#-feature` alone on a line is indented as the argument it guards, and the form on the next line gets the same indentation instead of being counted as a further argument; this also holds inside LOOP and lambda lists, and a feature-prefixed LOOP keyword still introduces its clause. Fixes #5.
- The systems a workspace depends on are indexed as read-only dependencies: `:depends-on` of its `.asd` files and `ql:quickload`/`asdf:load-system` calls are resolved transitively through `ocicl.csv` and `ocicl/`, `.qlot/`, Quicklisp, Roswell, `~/common-lisp`, the ASDF source-registry configuration and `CL_SOURCE_REGISTRY`. Exported dependency symbols complete (after workspace and standard symbols), every dependency definition has hover, signature help and go to definition, and rename leaves library files alone. New settings `moro.dependencies.index`, `moro.dependencies.registries` and `moro.dependencies.maxFiles`; `quicklisp/`, `.qlot/` and `ocicl/` are excluded from the workspace scan by default. Part of #6.
- The REPL starts with a backend loaded into the image (`lisp/moro-backend.lisp`) and the language server asks it, when the static sources have no answer, for completion, hover, signature help and go to definition of whatever is loaded, in any package: a background thread on a loopback port, a token file readable only by you, requests read with `*read-eval*` nil and never evaluated. SBCL, ECL, Clozure CL, ABCL and Roswell; source locations from SBCL. The status bar shows the connected image; `moro.repl.liveBackend` turns it off. Fixes #6.
- Evaluation through the image: Evaluate Top-Level Form, Evaluate Selection and Evaluate Buffer run in the REPL image when the backend is connected, with output and return values captured. Results appear after the form in the editor and in the new **moro results** channel; errors are reported with a backtrace instead of a debugger prompt; Interrupt Evaluation stops the running form through the backend; a new **Inspect Form** command (`Ctrl+Alt+N`) opens an inspector panel with drill-down into slots, elements, hash table entries, symbols, packages, functions and pathnames. New settings `moro.repl.evaluateIn` and `moro.repl.inlineResults`. Fixes #7.
- References, rename, highlights, go to definition, hover and signature help are package-aware. A package model built from every `defpackage`/`define-package` in the index (nicknames, `:local-nicknames`, `:use`, `:import-from`, `:shadowing-import-from`, `:shadow`, `:export`, uiop's `:mix`/`:reexport`) resolves each occurrence to its home package from the file's `in-package` and any explicit prefix: `app::run` and `other::run` are different symbols, inherited and imported symbols resolve to the package that exports them, standard symbols to `COMMON-LISP`. Names in a defpackage's `:export`/`:import-from` lists rename along with the symbol; package designators (`(:use #:cl)`, `(in-package ...)`) are no longer references and cannot be renamed. Files whose package has no definition in the index stay lenient and match by name. `pkg:` completion accepts nicknames and includes re-exported symbols. Fixes #8.
- Extension host tests (`npm run test:vscode`, run in CI on Linux under xvfb) start a real VS Code with a fixture workspace and check activation, every manifest command, the `[commonlisp]` editor defaults, hover, completion, symbols, definition and formatting through the extension host, structural editing on a document, the REPL terminal sending forms to a fake Lisp, and, with SBCL installed, a REPL started with the backend answering a hover from the live image. Fixes #9.

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
