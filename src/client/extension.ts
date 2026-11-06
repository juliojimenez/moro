/**
 * Moro: Common Lisp for Visual Studio Code.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as forms from './forms';
import * as paredit from './paredit';
import { Repl, lispPath, lispString } from './repl';

let client: LanguageClient | undefined;

const evalHighlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: false,
});

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'commonlisp' }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{lisp,lsp,cl,asd,asdf,ros}') },
    outputChannelName: 'Moro Language Server',
  };
  client = new LanguageClient('moro', 'Moro Language Server', serverOptions, clientOptions);
  context.subscriptions.push({ dispose: () => void client?.stop() });

  const repl = new Repl();
  context.subscriptions.push(repl, evalHighlight);

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  const lispEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'commonlisp') {
      void vscode.window.showInformationMessage('Moro: open a Common Lisp file first.');
      return undefined;
    }
    return editor;
  };

  const flash = (editor: vscode.TextEditor, start: number, end: number) => {
    const range = new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end));
    editor.setDecorations(evalHighlight, [range]);
    setTimeout(() => editor.setDecorations(evalHighlight, []), 250);
  };

  const evalSelection = async (editor: vscode.TextEditor, selection: forms.FormSelection | null, what: string) => {
    if (!selection) {
      void vscode.window.showInformationMessage(`Moro: no ${what} at the cursor.`);
      return;
    }
    const text = editor.document.getText();
    flash(editor, selection.start, selection.end);
    await repl.evalForm(selection.text, forms.packageAt(text, selection.start), forms.inPackageTarget(selection.text));
  };

  // REPL lifecycle
  register('moro.repl.start', () => repl.start());
  register('moro.repl.stop', () => repl.stop());
  register('moro.repl.restart', () => repl.restart());
  register('moro.repl.interrupt', () => repl.interrupt());

  // Evaluation
  register('moro.repl.evalTopLevelForm', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const text = editor.document.getText();
    await evalSelection(editor, forms.topLevelFormAtOffset(text, editor.document.offsetAt(editor.selection.active)), 'top-level form');
  });

  register('moro.repl.evalLastForm', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const document = editor.document;
    if (!editor.selection.isEmpty) {
      const start = document.offsetAt(editor.selection.start);
      const end = document.offsetAt(editor.selection.end);
      await evalSelection(editor, { start, end, text: document.getText(editor.selection) }, 'selection');
      return;
    }
    await evalSelection(editor, forms.lastFormBefore(document.getText(), document.offsetAt(editor.selection.active)), 'form');
  });

  register('moro.repl.evalBuffer', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const text = editor.document.getText();
    await repl.evalForm(text, null, forms.packageAt(text, text.length));
  });

  const loadFile = async (compile: boolean) => {
    const editor = lispEditor();
    if (!editor) return;
    if (editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Moro: save the file to disk before loading it.');
      return;
    }
    if (editor.document.isDirty) await editor.document.save();
    const file = lispPath(editor.document.uri.fsPath);
    await repl.send(compile ? `(load (compile-file ${file}))` : `(load ${file})`);
  };
  register('moro.repl.loadFile', () => loadFile(false));
  register('moro.repl.compileAndLoadFile', () => loadFile(true));

  const pickSystem = async (): Promise<{ name: string; directory: string } | undefined> => {
    const files = await vscode.workspace.findFiles('**/*.asd', '**/{node_modules,.git,.qlot}/**', 200);
    const systems: { name: string; directory: string }[] = [];
    for (const file of files) {
      const bytes = await vscode.workspace.fs.readFile(file);
      for (const name of forms.defsystemNames(Buffer.from(bytes).toString('utf8'))) {
        systems.push({ name, directory: path.dirname(file.fsPath) });
      }
    }
    if (!systems.length) {
      const typed = await vscode.window.showInputBox({ prompt: 'ASDF system name', placeHolder: 'my-system' });
      return typed ? { name: typed, directory: '' } : undefined;
    }
    if (systems.length === 1) return systems[0];
    const picked = await vscode.window.showQuickPick(
      systems.map((s) => ({ label: s.name, description: vscode.workspace.asRelativePath(s.directory), system: s })),
      { placeHolder: 'Select the system to load' },
    );
    return picked?.system;
  };

  const systemCommand = async (operation: 'load' | 'test') => {
    const system = await pickSystem();
    if (!system) return;
    const loader = vscode.workspace.getConfiguration('moro.repl').get<string>('systemLoader', 'asdf');
    const registry = system.directory ? `(pushnew #p${lispPath(system.directory + path.sep)} asdf:*central-registry* :test #'equal) ` : '';
    const action =
      operation === 'test'
        ? `(asdf:test-system ${lispString(system.name)})`
        : loader === 'quicklisp'
          ? `(ql:quickload ${lispString(system.name)})`
          : `(asdf:load-system ${lispString(system.name)})`;
    await repl.send(`(progn ${registry}${action})`);
  };
  register('moro.repl.loadSystem', () => systemCommand('load'));
  register('moro.repl.testSystem', () => systemCommand('test'));

  // Inspection
  const expand = async (expander: string) => {
    const editor = lispEditor();
    if (!editor) return;
    const text = editor.document.getText();
    const form = forms.innermostFormAt(text, editor.document.offsetAt(editor.selection.active));
    if (!form) {
      void vscode.window.showInformationMessage('Moro: no form at the cursor.');
      return;
    }
    flash(editor, form.start, form.end);
    await repl.syncPackage(forms.packageAt(text, form.start));
    await repl.send(`(pprint (${expander} (quote ${form.text})))`);
  };
  register('moro.repl.macroexpand1', () => expand('macroexpand-1'));
  register('moro.repl.macroexpand', () => expand('macroexpand'));

  const symbolAtCursor = (editor: vscode.TextEditor): string | null => {
    const document = editor.document;
    if (!editor.selection.isEmpty) return document.getText(editor.selection).trim() || null;
    return forms.symbolTextAt(document.getText(), document.offsetAt(editor.selection.active));
  };

  register('moro.repl.describe', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const symbol = symbolAtCursor(editor) ?? (await vscode.window.showInputBox({ prompt: 'Symbol to describe' }));
    if (!symbol) return;
    await repl.syncPackage(forms.packageAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active)));
    await repl.send(`(describe '${symbol})`);
  });

  register('moro.repl.apropos', async () => {
    const editor = vscode.window.activeTextEditor;
    const initial = editor && editor.document.languageId === 'commonlisp' ? symbolAtCursor(editor) ?? '' : '';
    const query = await vscode.window.showInputBox({ prompt: 'Apropos: substring of the symbol names to search for', value: initial });
    if (!query) return;
    await repl.send(`(apropos ${lispString(query)})`);
  });

  register('moro.repl.syncPackage', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const pkg = forms.packageAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
    if (!pkg) {
      void vscode.window.showInformationMessage('Moro: no (in-package ...) form precedes the cursor.');
      return;
    }
    await repl.syncPackage(pkg, true);
  });

  // Structural editing
  const applyEdit = async (editor: vscode.TextEditor, result: paredit.EditResult | null) => {
    if (!result) return;
    const document = editor.document;
    const ok = await editor.edit((builder) => {
      for (const edit of result.edits) {
        const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
        if (edit.start === edit.end) builder.insert(range.start, edit.newText);
        else if (edit.newText === '') builder.delete(range);
        else builder.replace(range, edit.newText);
      }
    });
    if (ok) {
      const position = document.positionAt(result.cursor);
      editor.selection = new vscode.Selection(position, position);
    }
  };

  const structural = (operation: (text: string, offset: number) => paredit.EditResult | null) => async () => {
    const editor = lispEditor();
    if (!editor) return;
    const offset = editor.document.offsetAt(editor.selection.active);
    await applyEdit(editor, operation(editor.document.getText(), offset));
  };
  register('moro.edit.slurpForward', structural(paredit.slurpForward));
  register('moro.edit.barfForward', structural(paredit.barfForward));
  register('moro.edit.spliceForm', structural(paredit.spliceForm));
  register('moro.edit.raiseForm', structural(paredit.raiseForm));
  register('moro.edit.wrapParens', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const document = editor.document;
    await applyEdit(editor, paredit.wrapParens(document.getText(), document.offsetAt(editor.selection.start), document.offsetAt(editor.selection.end)));
  });
  register('moro.edit.selectTopLevelForm', () => {
    const editor = lispEditor();
    if (!editor) return;
    const document = editor.document;
    const range = paredit.topLevelRange(document.getText(), document.offsetAt(editor.selection.active));
    if (range) editor.selection = new vscode.Selection(document.positionAt(range[0]), document.positionAt(range[1]));
  });

  register('moro.server.restart', async () => {
    await client?.restart();
  });

  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
