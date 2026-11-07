/**
 * Runs inside the VS Code extension host against the fixture workspace
 * (test/vscode/fixture): activation, commands, editor defaults, language
 * features through the extension host, structural editing, the terminal REPL
 * against a fake Lisp, and, when sbcl is installed, the REPL started with the
 * backend and the live image answering a hover.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { test, waitFor } from './harness';

const fixture = process.env.MORO_FIXTURE ?? path.resolve(__dirname, '..', '..', '..', '..', 'test', 'vscode', 'fixture');
const demoPath = path.join(fixture, 'demo.lisp');
const fakeLisp = path.join(fixture, 'fake-lisp.sh');
const sentLog = path.join(fixture, 'sent.log');
const externalDir = path.join(path.dirname(fixture), 'external');
const externalAsd = path.join(externalDir, 'extsys.asd');
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string }> };
};
const hasSbcl = process.platform !== 'win32' && spawnSync('sbcl', ['--version'], { stdio: 'ignore' }).status === 0;

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
    .join('\n');
}

async function openDemo(): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(demoPath);
  return vscode.window.showTextDocument(document);
}

function positionOf(document: vscode.TextDocument, needle: string, extra = 0): vscode.Position {
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `${needle} in ${document.fileName}`);
  return document.positionAt(offset + extra);
}

test('the extension activates for a Common Lisp file', async () => {
  const editor = await openDemo();
  assert.equal(editor.document.languageId, 'commonlisp');
  const extension = vscode.extensions.getExtension('juliojimenez.moro');
  assert.ok(extension, 'extension found by id');
  await extension.activate();
  assert.equal(extension.isActive, true);
});

test('every command in the manifest is registered', async () => {
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = manifest.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
  assert.deepEqual(missing, []);
});

test('editor defaults for the language apply', () => {
  const editor = vscode.workspace.getConfiguration('editor', { languageId: 'commonlisp' });
  assert.equal(editor.get('formatOnType'), true);
  assert.equal(editor.get('tabSize'), 2);
  assert.equal(editor.get('insertSpaces'), true);
  assert.equal(editor.get('wordBasedSuggestions'), 'off');
});

test('hover: standard symbols and workspace definitions through the language server', async () => {
  const editor = await openDemo();
  const document = editor.document;
  const standard = await waitFor(
    async () => {
      const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, positionOf(document, 'mapcar', 2)));
      return /more-lists/.test(text) ? text : undefined;
    },
    30000,
    'the language server to answer a hover on mapcar',
  );
  assert.match(standard, /HyperSpec/);
  const own = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, positionOf(document, '(greet "world")', 3)));
  assert.match(own, /\(greet name &optional \(greeting "Hello"\)\)/);
  assert.match(own, /Greet NAME\./);
});

test('completion, document symbols, definition and formatting', async () => {
  const editor = await openDemo();
  const document = editor.document;
  const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, positionOf(document, '(format t', 1));
  const labels = new Set(completion.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label)));
  assert.ok(labels.has('greeting'), 'local parameter');
  assert.ok(labels.has('main'), 'workspace function');
  assert.ok(labels.has('mapcar'), 'standard function');
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
  assert.deepEqual(symbols.map((s) => s.name), ['demo', 'greet', 'main']);
  const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', document.uri, positionOf(document, '(greet "world")', 3));
  assert.equal(definitions.length, 1);
  const target = 'targetUri' in definitions[0] ? definitions[0].targetUri : definitions[0].uri;
  assert.equal(target.fsPath, document.uri.fsPath);
  const ugly = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(defun f (x)\n(let ((y 1))\n(list x y)))\n' });
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', ugly.uri, { tabSize: 2, insertSpaces: true });
  assert.deepEqual(edits.map((e) => [e.range.start.line, e.newText]), [[1, '  '], [2, '    ']]);
});

test('structural editing commands change the document', async () => {
  const document = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(a b) c' });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(new vscode.Position(0, 4), new vscode.Position(0, 4));
  await vscode.commands.executeCommand('moro.edit.slurpForward');
  assert.equal(document.getText(), '(a b c)');
  await vscode.commands.executeCommand('moro.edit.barfForward');
  assert.equal(document.getText(), '(a b) c');
  editor.selection = new vscode.Selection(new vscode.Position(0, 1), new vscode.Position(0, 1));
  await vscode.commands.executeCommand('moro.edit.wrapParens');
  assert.equal(document.getText(), '((a) b) c');
});

test('the REPL terminal sends evaluated forms to the implementation', async () => {
  fs.chmodSync(fakeLisp, 0o755);
  fs.rmSync(sentLog, { force: true });
  await vscode.workspace.getConfiguration('moro.repl').update('command', fakeLisp, vscode.ConfigurationTarget.Global);
  const editor = await openDemo();
  await vscode.commands.executeCommand('moro.repl.start');
  await waitFor(() => vscode.window.terminals.find((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal');
  const position = positionOf(editor.document, '(defun greet', 3);
  editor.selection = new vscode.Selection(position, position);
  await vscode.commands.executeCommand('moro.repl.evalTopLevelForm');
  const log = await waitFor(() => (fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8') : '').includes('(defun greet') ? fs.readFileSync(sentLog, 'utf8') : undefined, 15000, 'the fake Lisp to receive the form');
  assert.match(log, /\(setf \*package\* \(or \(find-package "DEMO"\) \*package\*\)\)/, 'the package is synced first');
  assert.match(log, /\(format t "~a, ~a!~%" greeting name\)\)/, 'the whole defun arrives');
  await vscode.commands.executeCommand('moro.repl.stop');
  await waitFor(() => !vscode.window.terminals.some((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal to close');
});

function readSentLog(): string {
  return fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8') : '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('systems outside the workspace: moro.systems, load on start, and commands taking a system name', async () => {
  fs.chmodSync(fakeLisp, 0o755);
  const replConfig = vscode.workspace.getConfiguration('moro.repl');
  const moroConfig = vscode.workspace.getConfiguration('moro');
  await replConfig.update('command', fakeLisp, vscode.ConfigurationTarget.Global);
  await moroConfig.update('systems', [externalAsd], vscode.ConfigurationTarget.Global);
  await replConfig.update('loadOnStart', ['extsys'], vscode.ConfigurationTarget.Global);
  const posix = (p: string) => p.split(path.sep).join('/');
  try {
    // The language server indexes the external system like a dependency.
    const probe = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(extsys:ext-fn 1)\n' });
    await vscode.window.showTextDocument(probe);
    const hover = await waitFor(
      async () => {
        const t = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', probe.uri, new vscode.Position(1, 9)));
        return /External system function\./.test(t) ? t : undefined;
      },
      30000,
      'hover on a symbol of the system listed in moro.systems',
    );
    assert.match(hover, /\(dependency\)/);

    // Starting the REPL loads the systems in moro.repl.loadOnStart, with the external directory on the central registry.
    fs.rmSync(sentLog, { force: true });
    await vscode.commands.executeCommand('moro.repl.start');
    await waitFor(() => vscode.window.terminals.find((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal');
    const startup = await waitFor(() => (readSentLog().includes('"LOAD-SYSTEM"') ? readSentLog() : undefined), 15000, 'the start-up load to reach the fake Lisp');
    assert.match(startup, /\(require "asdf"\)/);
    assert.match(startup, new RegExp(escapeRegExp(`#p"${posix(externalDir)}/"`)), 'the external directory goes on the central registry');
    assert.match(startup, /\(funcall \(intern "LOAD-SYSTEM" "ASDF"\) "extsys"\)/);

    // Load ASDF System and Test ASDF System take a system name and skip the picker.
    await vscode.commands.executeCommand('moro.repl.loadSystem', 'demo');
    const loaded = await waitFor(() => (readSentLog().includes('"demo"') ? readSentLog() : undefined), 15000, 'the demo load');
    assert.match(loaded, /\(funcall \(intern "LOAD-SYSTEM" "ASDF"\) "demo"\)/);
    assert.match(loaded, new RegExp(escapeRegExp(`#p"${posix(fixture)}/"`)), 'the workspace system directory is registered');
    assert.match(loaded, new RegExp(escapeRegExp(`#p"${posix(externalDir)}/"`)), 'and so is the external one');
    await vscode.commands.executeCommand('moro.repl.testSystem', 'extsys');
    const tested = await waitFor(() => (readSentLog().includes('"TEST-SYSTEM"') ? readSentLog() : undefined), 15000, 'the test-system form');
    assert.match(tested, /\(funcall \(intern "TEST-SYSTEM" "ASDF"\) "extsys"\)/);
  } finally {
    await replConfig.update('loadOnStart', undefined, vscode.ConfigurationTarget.Global);
    await moroConfig.update('systems', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('moro.repl.stop');
    await waitFor(() => !vscode.window.terminals.some((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal to close');
  }
});

test('the REPL started with the backend answers hovers from the live image (sbcl)', async () => {
  await vscode.workspace.getConfiguration('moro.repl').update('command', 'sbcl', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('moro.repl.start');
  await waitFor(() => vscode.window.terminals.find((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal');
  const document = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(sb-ext:posix-getenv "HOME")\n' });
  await vscode.window.showTextDocument(document);
  const position = new vscode.Position(1, 10);
  const text = await waitFor(
    async () => {
      const t = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position));
      return /posix-getenv/.test(t) ? t : undefined;
    },
    60000,
    'the live image to answer a hover on sb-ext:posix-getenv',
  );
  assert.match(text, /live image/);

  // A form spanning several lines evaluates in the image; the image then knows it.
  const multi = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(defun defined-over-lines (a &optional b)\n  "Two lines."\n  (list a b))\n' });
  const multiEditor = await vscode.window.showTextDocument(multi);
  multiEditor.selection = new vscode.Selection(new vscode.Position(2, 4), new vscode.Position(2, 4));
  await vscode.commands.executeCommand('moro.repl.evalTopLevelForm');
  await waitFor(
    async () => {
      const t = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', multi.uri, new vscode.Position(1, 10)));
      return /\(defined-over-lines a &optional b\)/.test(t) && /Two lines\./.test(t) ? t : undefined;
    },
    30000,
    'the image to know the function evaluated from several lines',
  );

  // Macroexpansion through the image opens the expansion beside the editor.
  const source = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(when (foo) (bar) (baz))\n' });
  const editor = await vscode.window.showTextDocument(source);
  editor.selection = new vscode.Selection(new vscode.Position(1, 3), new vscode.Position(1, 3));
  await vscode.commands.executeCommand('moro.repl.macroexpand1');
  const expansion = await waitFor(
    () => vscode.window.visibleTextEditors.find((e) => e.document !== source && e.document.languageId === 'commonlisp' && /\(IF \(FOO\)/.test(e.document.getText())),
    15000,
    'the macroexpansion document',
  );
  assert.match(expansion.document.getText(), /\(PROGN \(BAR\) \(BAZ\)\)/);
  await vscode.commands.executeCommand('moro.repl.stop');
}, { skip: !hasSbcl });

test('an error in the image opens the debugger panel and Interrupt Evaluation aborts it (sbcl)', async () => {
  await vscode.workspace.getConfiguration('moro.repl').update('command', 'sbcl', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('moro.repl.start');
  await waitFor(() => vscode.window.terminals.find((t) => t.name === 'moro REPL'), 10000, 'the REPL terminal');
  const probe = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(sb-ext:posix-getenv "HOME")\n' });
  await vscode.window.showTextDocument(probe);
  await waitFor(
    async () => /live image/.test(hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', probe.uri, new vscode.Position(1, 10)))),
    60000,
    'the live image to be connected',
  );

  const failing = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: '(in-package #:cl-user)\n(error "boom from the test")\n' });
  const editor = await vscode.window.showTextDocument(failing);
  editor.selection = new vscode.Selection(new vscode.Position(1, 3), new vscode.Position(1, 3));
  const debuggerTab = () =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.label)
      .find((label) => label.startsWith('moro debugger'));
  // The evaluation does not finish until a restart is chosen or it is aborted, so it is not awaited here.
  const evaluation = vscode.commands.executeCommand('moro.repl.evalTopLevelForm');
  const label = await waitFor(debuggerTab, 30000, 'the debugger panel');
  assert.match(label, /SIMPLE-ERROR/);
  await vscode.commands.executeCommand('moro.repl.interrupt');
  await waitFor(() => !debuggerTab(), 15000, 'the debugger panel to close');
  await evaluation;
  await vscode.commands.executeCommand('moro.repl.stop');
}, { skip: !hasSbcl });
