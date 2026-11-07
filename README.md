# moro

Common Lisp for Visual Studio Code: syntax highlighting, a language server, a REPL that works with any implementation, and structural editing. No Lisp-side dependencies: the language server is bundled with the extension and understands your code without a running image.

## Features

**Editing**

- Syntax highlighting generated from the real list of the 978 `COMMON-LISP` symbols (functions, macros, special operators, types, variables, constants), with FORMAT directives, reader macros, feature expressions, LOOP keywords and package prefixes.
- Lisp indentation on Enter and on format (Emacs/SLIME rules, including `&body` macros from your own code; override with `moro.indentation.specs`).
- Structural editing: slurp, barf, splice, raise, wrap, select top-level form. Smart select (Shift+Alt+Right) expands by form.
- Bracket matching and colorization, auto-closing parentheses and strings, `#| |#` block comments, folding by form and comment block, snippets for the common definers.
- Common Lisp code blocks in Markdown files are highlighted too.

**Language server**

- Outline and workspace symbols for `defun`, `defmacro`, `defgeneric`, `defmethod` (with qualifiers and specializers), `defvar`, `defparameter`, `defconstant`, `defclass` (slots and accessors), `defstruct` (slots, accessors, constructor, predicate, copier), `define-condition`, `deftype`, `defpackage`, `defsystem` and any other `def...` macro.
- Go to definition, find references, rename and highlight occurrences across the workspace, package-aware.
- Dependencies are indexed too: the systems your `.asd` files depend on (and anything you `ql:quickload` or `asdf:load-system`) are resolved transitively through `ocicl.csv`/`ocicl/`, `.qlot/`, Quicklisp, Roswell, `~/common-lisp`, the ASDF source-registry configuration and `CL_SOURCE_REGISTRY`. Their exported symbols appear in completion, every definition has hover and signature help, and go to definition opens the library source. Rename never edits them.
- Hover and signature help with the lambda list and docstring, for your definitions and for every standard symbol (arglists and docstrings extracted from SBCL, with a link to the HyperSpec page).
- Completion of standard symbols, workspace definitions, local variables and parameters in scope, keywords, package-qualified names (`pkg:`), LOOP keywords inside `loop`, and lambda-list keywords.
- Semantic highlighting of definition names, parameters, local variables, calls to your own functions and macros, and symbols used as types (`handler-case` and `typecase` clauses, declarations, `the`, `check-type`, quoted type arguments, method specializers, slot types, LOOP `of-type`).
- Diagnostics for unbalanced parentheses, unterminated strings and unterminated block comments.

**REPL**

- Runs your implementation in an integrated terminal: SBCL, Roswell, CCL, ECL, CLISP or ABCL are detected automatically, or set `moro.repl.command`.
- Evaluate the top-level form, the selection or the form before the cursor, load or compile-and-load the file, load or test an ASDF system found in the workspace, macroexpand, describe, apropos, interrupt.
- With the backend connected, evaluation runs in the image with its output and return values captured: the result appears after the form in the editor and in the **moro results** channel, errors come back with a backtrace instead of a debugger prompt, Interrupt Evaluation stops a running form, and **Inspect Form** opens an inspector panel where slots, elements and entries can be drilled into. Set `moro.repl.evaluateIn` to `terminal` to keep sending forms to the terminal.
- Before evaluating, the REPL switches to the package of the closest preceding `(in-package ...)` when that package exists in the image.
- The REPL starts with a small backend loaded (`lisp/moro-backend.lisp`). Through it the language server asks the running image for what the static index cannot know: completion, hover, signature help and go to definition for anything loaded in the REPL, in any package. The status bar shows which image is connected.

## Keybindings

All bindings apply in Common Lisp editors only.

| Command | Key |
| --- | --- |
| Evaluate top-level form | `Ctrl+Enter` |
| Evaluate selection or last form | `Shift+Enter` |
| Load file | `Ctrl+Alt+L` |
| Compile and load file | `Ctrl+Alt+K` |
| Macroexpand-1 form | `Ctrl+Alt+M` |
| Describe symbol | `Ctrl+Alt+D` |
| Inspect form | `Ctrl+Alt+N` |
| Start REPL | `Ctrl+Alt+R` |
| Interrupt evaluation | `Ctrl+Alt+B` |
| Slurp forward / barf forward | `Ctrl+Alt+Right` / `Ctrl+Alt+Left` |
| Splice form | `Ctrl+Alt+S` |
| Raise form | `Ctrl+Alt+P` |
| Wrap in parentheses | `Ctrl+Alt+W` |

Every command is also in the command palette under the **moro** category and in the editor context menu.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `moro.repl.command` | `""` | REPL executable; empty means auto-detect. |
| `moro.repl.args` | `[]` | Extra arguments (SBCL gets `--noinform`, Roswell gets `run` automatically). |
| `moro.repl.syncPackage` | `true` | Switch the REPL to the file's package before evaluating. |
| `moro.repl.systemLoader` | `asdf` | `asdf` uses `asdf:load-system`, `quicklisp` uses `ql:quickload`. |
| `moro.repl.revealOnEval` | `true` | Show the REPL terminal when something is sent to it. |
| `moro.repl.liveBackend` | `true` | Load the backend into the REPL image so the editor sees what is loaded (SBCL, ECL, CCL, ABCL, Roswell). |
| `moro.repl.evaluateIn` | `image` | Evaluate through the backend when connected (inline results, interrupt, no debugger prompt), or always in the terminal. |
| `moro.repl.inlineResults` | `true` | Show evaluation results after the form in the editor. |
| `moro.indentation.specs` | `{}` | Operator name to number of distinguished arguments, like Emacs `lisp-indent-function`. |
| `moro.indexing.exclude` | node_modules, .git, quicklisp, .qlot, ocicl, .cache | Globs the workspace index skips; library directories are left to the dependency scan. |
| `moro.indexing.maxFiles` | `3000` | Maximum number of files indexed per workspace. |
| `moro.dependencies.index` | `true` | Index the ASDF systems the workspace depends on. |
| `moro.dependencies.registries` | `[]` | Extra directories searched for `.asd` files, before the standard registries. |
| `moro.dependencies.maxFiles` | `4000` | Maximum number of dependency files indexed. |
| `moro.diagnostics.enabled` | `true` | Structural diagnostics. |
| `moro.hover.hyperspecUrl` | lispworks.com | Base URL for HyperSpec links; point it at a local mirror if you have one. |

The extension sets `editor.formatOnType`, two-space indentation and turns off word-based suggestions for Common Lisp files. In untrusted workspaces the REPL command and arguments are read from user settings only.

## How it works

The extension ships a TypeScript language server with an error-tolerant Common Lisp reader. It parses every `.lisp`, `.lsp`, `.cl`, `.asd` and `.ros` file in the workspace, extracts definitions and symbol occurrences, tracks `in-package`, and answers editor requests from that index. It then reads the workspace's `.asd` files and `ql:quickload` calls, resolves the dependency systems through the registries on your machine, and indexes their sources as read-only dependencies. Standard symbol information comes from `data/cl-symbols.json`, generated with `tools/gen-cl-symbols.lisp` by introspecting SBCL and the HyperSpec symbol map; the TextMate grammar is generated from the same data by `tools/build-grammar.mjs`.

The REPL is a plain terminal, so anything your implementation prints is shown as is and the debugger works exactly as it does in a shell. When the implementation has threads, the REPL is started with `--load lisp/moro-backend.lisp --eval (moro-backend:start PORT TOKEN-FILE)`: a background thread listens on a loopback port for one-line s-expression requests (`(:arglist "MAPCAR" "CL")`, `(:documentation ...)`, `(:complete "prefix" "PKG")`, `(:definition ...)`, `(:packages)`), authenticated by a token file only your user can read, read with `*read-eval*` bound to nil and never evaluated. The server uses it only when the standard library, the workspace and its dependencies have no answer, so the editor keeps working without a REPL. The extension itself opens two more connections to the same backend: one for evaluation and inspection (`(:eval text pkg)`, `(:inspect ...)`, `(:inspect-part n)`, `(:inspect-pop)`), which capture output and return values and report errors with a backtrace, and one for `(:interrupt)`, which stops the evaluation thread. Each connection is served by its own thread in the image, so an evaluation never blocks completion.

## Known limitations

Each one is tracked as an issue; fix sketches are in the issue bodies.

- Live-image answers need an implementation with threads (SBCL, ECL, CCL, ABCL, Roswell); CLISP's REPL runs without the backend. Source locations from the image come from SBCL only; other implementations answer arglists, documentation and completion. Macroexpansion, describe and apropos still go through the REPL terminal.
- Evaluations sent to the image never enter the debugger: an error is reported with its backtrace and the form is abandoned. For the implementation's interactive debugger, with restarts, set `moro.repl.evaluateIn` to `terminal` or type the form in the REPL.
- References and rename match symbol names across packages, and package nicknames are not resolved ([#8](https://github.com/juliojimenez/moro/issues/8)).
- Highlighting: type positions, definition names and superclass lists are colored by the language server, so they look right only while it is running; a `loop` whose `(` ends the previous line gets no LOOP keyword coloring.
- No tests run inside a real VS Code window yet ([#9](https://github.com/juliojimenez/moro/issues/9)).

## Development

```sh
npm install
npm run build        # bundle client and server into dist/
npm test             # unit tests (node --test) and grammar tests
npm run watch        # rebuild on change; then press F5 in VS Code
npm run grammar      # regenerate syntaxes/commonlisp.tmLanguage.json
npm run symbols      # regenerate data/cl-symbols.json (needs sbcl; CLHS_MAP=path/to/Map_Sym.txt adds HyperSpec links)
npm run package      # build the .vsix
```

Releases: push a `v*` tag matching `package.json`; the release workflow builds the `.vsix`, attaches it to a GitHub release and publishes to the Marketplace and Open VSX when the `VSCE_PAT` and `OVSX_PAT` secrets are set.

## License

Apache-2.0. Standard symbol arglists and docstrings are extracted from SBCL (public domain / BSD). HyperSpec page names come from LispWorks' `Map_Sym.txt`; the HyperSpec itself is © LispWorks Ltd.
