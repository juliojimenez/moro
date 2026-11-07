# moro

Common Lisp for Visual Studio Code. Syntax highlighting, a language server that understands your code and its dependencies without a running image, a REPL for any implementation and, while the REPL runs, a connection into the image: evaluation with inline results, completion and documentation for whatever is loaded, and an inspector.

Nothing to install on the Lisp side. The language server is bundled with the extension, and the REPL backend is a single dependency-free Lisp file the extension loads into your REPL.

## Getting started

1. Install `juliojimenez.moro` from the Marketplace or Open VSX. Editing, navigation and documentation work on their own.
2. For the REPL, have an implementation on your `PATH`: SBCL, Roswell, Clozure CL, ECL, CLISP and ABCL are detected automatically; anything else goes in `moro.repl.command`.
3. Open a `.lisp` file and press `Ctrl+Alt+R`. The REPL opens in a terminal, and the status bar shows the connected image once the backend answers.
4. Put the cursor in a form and press `Ctrl+Enter`. The result appears after the form and in the **moro results** channel; errors arrive with a backtrace. `Ctrl+Alt+N` opens the inspector on the value of the form before the cursor.
5. **Load ASDF System** in the command palette finds the systems defined in the workspace and loads one.

## Features

**Editing**

- Syntax highlighting generated from the real list of the 978 `COMMON-LISP` symbols (functions, macros, special operators, types, variables, constants), with FORMAT directives, reader macros, feature expressions, LOOP keywords and package prefixes.
- Lisp indentation on Enter and on format (Emacs/SLIME rules, including `&body` macros from your own code; override with `moro.indentation.specs`).
- Structural editing: slurp, barf, splice, raise, wrap, select top-level form. Smart select (Shift+Alt+Right) expands by form.
- Bracket matching and colorization, auto-closing parentheses and strings, `#| |#` block comments, folding by form and comment block, snippets for the common definers.
- Common Lisp code blocks in Markdown files are highlighted too.

**Language server**

- Outline and workspace symbols for `defun`, `defmacro`, `defgeneric`, `defmethod` (with qualifiers and specializers), `defvar`, `defparameter`, `defconstant`, `defclass` (slots and accessors), `defstruct` (slots, accessors, constructor, predicate, copier), `define-condition`, `deftype`, `defpackage`, `defsystem` and any other `def...` macro.
- Go to definition, find references, rename and highlight occurrences across the workspace, package-aware: every occurrence is resolved to its home package from the file's `in-package` and the `defpackage` forms in the index (`:use`, `:import-from`, `:shadow`, `:export`, nicknames and local nicknames), so `app::run` and `other::run` are different symbols. Files whose package has no definition, such as scratch files in `CL-USER`, match by name.
- Dependencies are indexed too: the systems your `.asd` files depend on (and anything you `ql:quickload` or `asdf:load-system`) are resolved transitively through `ocicl.csv`/`ocicl/`, `.qlot/`, Quicklisp, Roswell, `~/common-lisp`, the ASDF source-registry configuration and `CL_SOURCE_REGISTRY`. Their exported symbols appear in completion, every definition has hover and signature help, and go to definition opens the library source. Rename never edits them.
- Hover and signature help with the lambda list and docstring, for your definitions and for every standard symbol (arglists and docstrings extracted from SBCL, with a link to the HyperSpec page).
- Completion of standard symbols, workspace definitions, local variables and parameters in scope, keywords, package-qualified names (`pkg:`), LOOP keywords inside `loop`, and lambda-list keywords.
- Semantic highlighting of definition names, parameters, local variables, calls to your own functions and macros, and symbols used as types (`handler-case` and `typecase` clauses, declarations, `the`, `check-type`, quoted type arguments, method specializers, slot types, LOOP `of-type`).
- Diagnostics for unbalanced parentheses, unterminated strings and unterminated block comments.

**REPL and live image**

- Runs your implementation in an integrated terminal: SBCL, Roswell, CCL, ECL, CLISP or ABCL are detected automatically, or set `moro.repl.command`. The terminal is a real one: the implementation's own debugger and restarts work as in a shell.
- The REPL starts with a small backend loaded (`lisp/moro-backend.lisp`). Through it the language server asks the running image for what the static index cannot know: completion, hover, signature help and go to definition for anything loaded in the REPL, in any package. Definition locations come from the image's own records on SBCL, Clozure CL, ECL and ABCL. The status bar shows which image is connected.
- Evaluation runs in the image with its output and return values captured: the result appears after the form in the editor and in the **moro results** channel, and Interrupt Evaluation stops a running form. Set `moro.repl.evaluateIn` to `terminal` to send forms to the terminal instead.
- An error opens the **moro debugger** panel: the condition, the restarts the evaluation offers and the backtrace. Choosing a restart resumes the evaluation inside the image (`use-value` and `store-value` ask for a form to evaluate; number keys work too); Abort, closing the panel or Interrupt Evaluation abandon it, and the error is then reported with the backtrace. Each frame expands to its local variables (SBCL), and any local, like the condition itself, can be opened in the inspector. Set `moro.repl.debugger` to `false` to skip the panel and get the backtrace right away.
- **Inspect Form** opens an inspector panel on the value of a form: slots of instances, structures and conditions, elements of lists and vectors, hash table entries, a symbol's cells, package and pathname parts, each drillable.
- Evaluate the top-level form, the selection or the form before the cursor, or the whole buffer; load or compile-and-load the file; load or test an ASDF system found in the workspace. Macroexpand opens the expansion as a Common Lisp document beside the editor; describe and apropos answer in the results channel. Without a connected image all of these go through the terminal.
- Before evaluating, the REPL switches to the package of the closest preceding `(in-package ...)` when that package exists in the image.

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

Every command is also in the command palette under the **moro** category, and the most used ones in the editor context menu. Without a default key: Stop REPL, Restart REPL, Evaluate Buffer, Load ASDF System, Test ASDF System, Macroexpand Form, Apropos, Switch REPL to File's Package, Clear Inline Results, Select Top-Level Form and Restart Language Server.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `moro.repl.command` | `""` | REPL executable; empty means auto-detect. |
| `moro.repl.args` | `[]` | Extra arguments (SBCL gets `--noinform`, Roswell gets `run` automatically). |
| `moro.repl.syncPackage` | `true` | Switch the REPL to the file's package before evaluating. |
| `moro.repl.systemLoader` | `asdf` | `asdf` uses `asdf:load-system`, `quicklisp` uses `ql:quickload`. |
| `moro.repl.revealOnEval` | `true` | Show the REPL terminal when something is sent to it. |
| `moro.repl.liveBackend` | `true` | Load the backend into the REPL image so the editor sees what is loaded (SBCL, ECL, CCL, ABCL, Roswell). |
| `moro.repl.evaluateIn` | `image` | Evaluate through the backend when connected (inline results, interrupt, debugger panel), or always in the terminal. |
| `moro.repl.inlineResults` | `true` | Show evaluation results after the form in the editor. |
| `moro.repl.debugger` | `true` | Open the debugger panel when an evaluation in the image signals an error; off, the error comes back with a backtrace and the form is abandoned. |
| `moro.indentation.specs` | `{}` | Operator name to number of distinguished arguments, like Emacs `lisp-indent-function`. |
| `moro.indexing.exclude` | node_modules, .git, quicklisp, .qlot, ocicl, .cache | Globs the workspace index skips; library directories are left to the dependency scan. |
| `moro.indexing.maxFiles` | `3000` | Maximum number of files indexed per workspace. |
| `moro.dependencies.index` | `true` | Index the ASDF systems the workspace depends on. |
| `moro.dependencies.registries` | `[]` | Extra directories searched for `.asd` files, before the standard registries. |
| `moro.dependencies.maxFiles` | `4000` | Maximum number of dependency files indexed. |
| `moro.diagnostics.enabled` | `true` | Structural diagnostics. |
| `moro.hover.hyperspecUrl` | lispworks.com | Base URL for HyperSpec links; point it at a local mirror if you have one. |
| `moro.trace.server` | `off` | Trace the messages between VS Code and the language server (`messages` or `verbose`) in the **moro language server** output channel. |

The extension sets `editor.formatOnType`, two-space indentation and turns off word-based suggestions for Common Lisp files. In untrusted workspaces the REPL command and arguments are read from user settings only.

## How it works

The extension ships a TypeScript language server with an error-tolerant Common Lisp reader. It parses every `.lisp`, `.lsp`, `.cl`, `.asd` and `.ros` file in the workspace, extracts definitions and symbol occurrences, tracks `in-package`, and answers editor requests from that index. It then reads the workspace's `.asd` files and `ql:quickload` calls, resolves the dependency systems through the registries on your machine, and indexes their sources as read-only dependencies. Standard symbol information comes from `data/cl-symbols.json`, generated with `tools/gen-cl-symbols.lisp` by introspecting SBCL and the HyperSpec symbol map; the TextMate grammar is generated from the same data by `tools/build-grammar.mjs`.

The REPL is a plain terminal, so anything your implementation prints is shown as is and the debugger works exactly as it does in a shell. When the implementation has threads, the REPL is started with `--load lisp/moro-backend.lisp --eval (moro-backend:start PORT TOKEN-FILE)`: a background thread listens on a loopback port for one-line s-expression requests (`(:arglist "MAPCAR" "CL")`, `(:documentation ...)`, `(:complete "prefix" "PKG")`, `(:definition ...)`, `(:packages)`), authenticated by a token file only your user can read, read with `*read-eval*` bound to nil and never evaluated. The server uses it only when the standard library, the workspace and its dependencies have no answer, so the editor keeps working without a REPL. The extension itself opens two more connections to the same backend: one for evaluation and inspection (`(:eval text pkg :debugger t)`, `(:inspect ...)`, `(:inspect-part n)`, `(:inspect-pop)`), which capture output and return values, and one for `(:interrupt)`, which stops the evaluation thread. When an evaluation signals an error, the backend sends a `(:debug ...)` event with the condition, the restarts established inside the evaluation and the frames above it, and waits on the evaluation thread for `(:invoke-restart n args...)`, `(:frame-locals n)`, `(:inspect-local frame n)`, `(:inspect-condition)` or `(:abort)`; the evaluation's own answer follows once a restart completed it or it was abandoned. Each connection is served by its own thread in the image, so an evaluation never blocks completion.

## Known limitations

- Live-image answers need an implementation with threads (SBCL, ECL, CCL, ABCL, Roswell); CLISP's REPL runs without the backend. The local variables of debugger frames and the frames of a backtrace come from SBCL (CCL has backtraces too); every supported implementation answers arglists, documentation, completion, evaluation, the debugger's restarts and go to definition.
- Type positions, definition names and superclass lists are colored by the language server, so they revert to plain coloring while it is starting.

## Development

```sh
npm install
npm run build        # bundle client and server into dist/
npm test             # unit tests (node --test), the language server over stdio, and grammar tests
npm run test:vscode  # extension host tests in a real VS Code window (downloads VS Code into .vscode-test)
npm run watch        # rebuild on change; then press F5 in VS Code
npm run grammar      # regenerate syntaxes/commonlisp.tmLanguage.json
npm run symbols      # regenerate data/cl-symbols.json (needs sbcl; CLHS_MAP=path/to/Map_Sym.txt adds HyperSpec links)
npm run package      # build the .vsix
```

Releases: push a `v*` tag matching `package.json`; the release workflow builds the `.vsix`, attaches it to a GitHub release and publishes to the Marketplace and Open VSX when the `VSCE_PAT` and `OVSX_PAT` secrets are set.

## License

Apache-2.0. Standard symbol arglists and docstrings are extracted from SBCL (public domain / BSD). HyperSpec page names come from LispWorks' `Map_Sym.txt`; the HyperSpec itself is © LispWorks Ltd.
