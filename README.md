# Moro

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
- Hover and signature help with the lambda list and docstring, for your definitions and for every standard symbol (arglists and docstrings extracted from SBCL, with a link to the HyperSpec page).
- Completion of standard symbols, workspace definitions, local variables and parameters in scope, keywords, package-qualified names (`pkg:`), LOOP keywords inside `loop`, and lambda-list keywords.
- Semantic highlighting of parameters, local variables and calls to your own functions and macros.
- Diagnostics for unbalanced parentheses, unterminated strings and unterminated block comments.

**REPL**

- Runs your implementation in an integrated terminal: SBCL, Roswell, CCL, ECL, CLISP or ABCL are detected automatically, or set `moro.repl.command`.
- Evaluate the top-level form, the selection or the form before the cursor, load or compile-and-load the file, load or test an ASDF system found in the workspace, macroexpand, describe, apropos, interrupt.
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
| Start REPL | `Ctrl+Alt+R` |
| Interrupt evaluation | `Ctrl+Alt+B` |
| Slurp forward / barf forward | `Ctrl+Alt+Right` / `Ctrl+Alt+Left` |
| Splice form | `Ctrl+Alt+S` |
| Raise form | `Ctrl+Alt+P` |
| Wrap in parentheses | `Ctrl+Alt+W` |

Every command is also in the command palette under the **Moro** category and in the editor context menu.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `moro.repl.command` | `""` | REPL executable; empty means auto-detect. |
| `moro.repl.args` | `[]` | Extra arguments (SBCL gets `--noinform`, Roswell gets `run` automatically). |
| `moro.repl.syncPackage` | `true` | Switch the REPL to the file's package before evaluating. |
| `moro.repl.systemLoader` | `asdf` | `asdf` uses `asdf:load-system`, `quicklisp` uses `ql:quickload`. |
| `moro.repl.revealOnEval` | `true` | Show the REPL terminal when something is sent to it. |
| `moro.indentation.specs` | `{}` | Operator name to number of distinguished arguments, like Emacs `lisp-indent-function`. |
| `moro.indexing.exclude` | node_modules, .git, quicklisp dists, .qlot, .cache | Globs the workspace index skips. |
| `moro.indexing.maxFiles` | `3000` | Maximum number of files indexed per workspace. |
| `moro.diagnostics.enabled` | `true` | Structural diagnostics. |
| `moro.hover.hyperspecUrl` | lispworks.com | Base URL for HyperSpec links; point it at a local mirror if you have one. |

The extension sets `editor.formatOnType`, two-space indentation and turns off word-based suggestions for Common Lisp files. In untrusted workspaces the REPL command and arguments are read from user settings only.

## How it works

The extension ships a TypeScript language server with an error-tolerant Common Lisp reader. It parses every `.lisp`, `.lsp`, `.cl`, `.asd` and `.ros` file in the workspace, extracts definitions and symbol occurrences, tracks `in-package`, and answers editor requests from that index. Standard symbol information comes from `data/cl-symbols.json`, generated with `tools/gen-cl-symbols.lisp` by introspecting SBCL and the HyperSpec symbol map; the TextMate grammar is generated from the same data by `tools/build-grammar.mjs`.

The REPL is a plain terminal, so anything your implementation prints is shown as is and the debugger works exactly as it does in a shell.

## Known limitations

Each one is tracked as an issue; fix sketches are in the issue bodies.

- The server has no live image: completion, hover and signature help know the standard library and what is written in the workspace, not what is loaded in your REPL ([#6](https://github.com/juliojimenez/moro/issues/6)). Macroexpansion, describe and apropos go through the REPL for that reason.
- The REPL is a terminal: there is no inspector, no debugger UI and no return-value capture beyond what the implementation prints ([#7](https://github.com/juliojimenez/moro/issues/7)).
- References and rename match symbol names across packages, and package nicknames are not resolved ([#8](https://github.com/juliojimenez/moro/issues/8)).
- Highlighting cannot tell a type from a function with the same name, so `(error (e) ...)` in `handler-case` is colored as a call ([#1](https://github.com/juliojimenez/moro/issues/1)); definer names must be on the same line as the definer ([#2](https://github.com/juliojimenez/moro/issues/2)); compound `#+` expressions and multi-line `|...|` symbols get plain scoping ([#3](https://github.com/juliojimenez/moro/issues/3)).
- LOOP indentation unwinds only one level of nested `when`/`if`/`unless`, and continuation keywords on their own line align under the previous clause's form rather than four columns in ([#4](https://github.com/juliojimenez/moro/issues/4)); a `#+feature` on its own line counts as an argument ([#5](https://github.com/juliojimenez/moro/issues/5)).
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
