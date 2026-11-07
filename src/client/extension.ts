/**
 * moro: Common Lisp for Visual Studio Code.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { ImageSession } from './evaluation';
import * as forms from './forms';
import * as paredit from './paredit';
import { LiveImageInfo, Repl, lispPath, lispString } from './repl';

let client: LanguageClient | undefined;

interface LiveStatus {
  connected: boolean;
  implementation?: string;
  version?: string;
}

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
    outputChannelName: 'moro language server',
  };
  client = new LanguageClient('moro', 'moro language server', serverOptions, clientOptions);
  context.subscriptions.push({ dispose: () => void client?.stop() });

  const repl = new Repl(context.asAbsolutePath(path.join('lisp', 'moro-backend.lisp')));
  context.subscriptions.push(repl, evalHighlight);
  const session = new ImageSession((message) => client?.outputChannel.appendLine(`[client] ${message}`));
  context.subscriptions.push(session);

  // Status bar: which image the language server is talking to.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = 'moro live image';
  status.command = 'moro.repl.start';
  const showStatus = (live: LiveStatus) => {
    if (live.connected) {
      status.text = `$(plug) moro: ${live.implementation ?? 'image'}${live.version ? ` ${live.version}` : ''}`;
      status.tooltip = 'moro: completion, hover and signature help also come from this REPL image';
    } else {
      status.text = '$(debug-disconnect) moro: no image';
      status.tooltip = 'moro: start a REPL to get completion and documentation for what is loaded';
    }
    status.show();
  };
  showStatus({ connected: false });
  context.subscriptions.push(status);
  const sendImage = (info: LiveImageInfo | null) => void client?.sendNotification('moro/liveImage', info);
  let busy = false;
  let lastStatus: LiveStatus = { connected: false };
  const refreshStatus = () => {
    if (busy) {
      status.text = `$(sync~spin) moro: evaluating`;
      status.tooltip = 'moro: evaluating in the image (Interrupt Evaluation stops it)';
      status.show();
    } else {
      showStatus(lastStatus);
    }
  };
  session.onBusy = (b) => {
    busy = b;
    refreshStatus();
  };
  repl.onImage = (info) => {
    sendImage(info);
    if (info) void session.connect(info);
    else session.disconnect();
  };
  /** Whether evaluation should go through the image rather than the terminal. */
  const useImage = () => session.connected && vscode.workspace.getConfiguration('moro.repl').get<string>('evaluateIn', 'image') === 'image';

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  const lispEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'commonlisp') {
      void vscode.window.showInformationMessage('moro: open a Common Lisp file first.');
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
      void vscode.window.showInformationMessage(`moro: no ${what} at the cursor.`);
      return;
    }
    const text = editor.document.getText();
    flash(editor, selection.start, selection.end);
    const pkg = forms.packageAt(text, selection.start);
    if (useImage()) {
      const range = new vscode.Range(editor.document.positionAt(selection.start), editor.document.positionAt(selection.end));
      await session.evaluate(editor, range, selection.text, pkg);
      return;
    }
    await repl.evalForm(selection.text, pkg, forms.inPackageTarget(selection.text));
  };

  // REPL lifecycle
  register('moro.repl.start', () => repl.start());
  register('moro.repl.stop', () => repl.stop());
  register('moro.repl.restart', () => repl.restart());
  register('moro.repl.interrupt', async () => {
    if (session.connected && (await session.interrupt())) return;
    repl.interrupt();
  });

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
    if (useImage()) {
      const range = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(text.length));
      await session.evaluate(editor, range, text, forms.packageAt(text, 0));
      return;
    }
    await repl.evalForm(text, null, forms.packageAt(text, text.length));
  });

  register('moro.repl.inspect', async () => {
    const editor = lispEditor();
    if (!editor) return;
    if (!session.connected) {
      void vscode.window.showInformationMessage('moro: the inspector needs a REPL started with the live backend (Start REPL).');
      return;
    }
    const document = editor.document;
    const text = document.getText();
    const selection = editor.selection.isEmpty
      ? forms.lastFormBefore(text, document.offsetAt(editor.selection.active)) ?? forms.innermostFormAt(text, document.offsetAt(editor.selection.active))
      : { start: document.offsetAt(editor.selection.start), end: document.offsetAt(editor.selection.end), text: document.getText(editor.selection) };
    if (!selection) {
      void vscode.window.showInformationMessage('moro: no form at the cursor.');
      return;
    }
    flash(editor, selection.start, selection.end);
    await session.inspect(selection.text, forms.packageAt(text, selection.start));
  });

  register('moro.repl.clearResults', () => session.clearResults());

  const loadFile = async (compile: boolean) => {
    const editor = lispEditor();
    if (!editor) return;
    if (editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('moro: save the file to disk before loading it.');
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
  const expand = async (expander: 'macroexpand-1' | 'macroexpand') => {
    const editor = lispEditor();
    if (!editor) return;
    const text = editor.document.getText();
    const form = forms.innermostFormAt(text, editor.document.offsetAt(editor.selection.active));
    if (!form) {
      void vscode.window.showInformationMessage('moro: no form at the cursor.');
      return;
    }
    flash(editor, form.start, form.end);
    const pkg = forms.packageAt(text, form.start);
    if (useImage()) {
      await session.macroexpand(expander, form.text, pkg);
      return;
    }
    await repl.syncPackage(pkg);
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
    const pkg = forms.packageAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
    if (useImage()) {
      await session.describe(symbol, pkg);
      return;
    }
    await repl.syncPackage(pkg);
    await repl.send(`(describe '${symbol})`);
  });

  register('moro.repl.apropos', async () => {
    const editor = vscode.window.activeTextEditor;
    const initial = editor && editor.document.languageId === 'commonlisp' ? symbolAtCursor(editor) ?? '' : '';
    const query = await vscode.window.showInputBox({ prompt: 'Apropos: substring of the symbol names to search for', value: initial });
    if (!query) return;
    if (useImage()) {
      await session.apropos(query, editor ? forms.packageAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active)) : null);
      return;
    }
    await repl.send(`(apropos ${lispString(query)})`);
  });

  register('moro.repl.syncPackage', async () => {
    const editor = lispEditor();
    if (!editor) return;
    const pkg = forms.packageAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
    if (!pkg) {
      void vscode.window.showInformationMessage('moro: no (in-package ...) form precedes the cursor.');
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
    sendImage(repl.image);
  });

  await client.start();
  context.subscriptions.push(
    client.onNotification('moro/liveStatus', (live: LiveStatus) => {
      lastStatus = live;
      refreshStatus();
    }),
  );
  if (repl.image) sendImage(repl.image);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
