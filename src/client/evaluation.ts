/**
 * Evaluation and inspection through the backend inside the REPL image:
 * results shown inline after the form and in the "moro results" channel,
 * interrupts over a second connection, a debugger panel for errors with
 * restarts, and an inspector panel.
 */
import * as vscode from 'vscode';
import { DebuggerEvent, LiveImage, LiveEvaluation, InspectorResult, InspectorView, lispString } from '../common/live';
import { DebuggerPanel } from './debugger';
import type { LiveImageInfo } from './repl';
import { channelText, formSummary, inlineText } from './results';
import { escapeHtml, nonce } from './webview';

/** What the session is doing, for the status bar. */
export type SessionState = 'idle' | 'evaluating' | 'debugger';

export class ImageSession implements vscode.Disposable {
  /** Long-running requests: evaluation and the first inspect. */
  readonly evaluator = new LiveImage();
  /** Short requests: interrupt and inspector navigation. */
  readonly control = new LiveImage();
  private readonly channel = vscode.window.createOutputChannel('moro results', 'lisp');
  private readonly resultType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly errorType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', color: new vscode.ThemeColor('editorError.foreground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly results = new Map<string, { ok: vscode.DecorationOptions[]; error: vscode.DecorationOptions[] }>();
  private inspector: InspectorPanel | undefined;
  private debuggerPanel: DebuggerPanel | undefined;
  private evaluating = 0;
  private state: SessionState = 'idle';
  private readonly disposables: vscode.Disposable[] = [];
  onState: (state: SessionState) => void = () => undefined;

  constructor(private readonly log: (message: string) => void) {
    this.evaluator.log = log;
    this.control.log = log;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.clearResults(event.document.uri)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redraw()),
    );
  }

  dispose(): void {
    this.disconnect();
    for (const d of this.disposables) d.dispose();
    this.channel.dispose();
    this.resultType.dispose();
    this.errorType.dispose();
    this.inspector?.dispose();
    this.debuggerPanel?.dispose();
  }

  get connected(): boolean {
    return this.evaluator.connected;
  }

  /** True while an evaluation waits in the debugger for a restart. */
  get debuggerActive(): boolean {
    return this.evaluator.debuggerActive;
  }

  async connect(info: LiveImageInfo): Promise<void> {
    await Promise.all([this.evaluator.connect(info), this.control.connect(info)]);
  }

  disconnect(): void {
    this.evaluator.disconnect();
    this.control.disconnect();
    this.closeDebugger();
  }

  /**
   * Evaluates `text` in `pkg` in the image; null (after a warning) when the
   * image did not answer or another evaluation is waiting in the debugger.
   * With `moro.repl.debugger` on, an error opens the debugger panel and the
   * promise resolves once a restart completed the evaluation or it was aborted.
   */
  async run(text: string, pkg: string | null): Promise<LiveEvaluation | null> {
    if (this.refuseWhileDebugging()) return null;
    this.setBusy(1);
    try {
      const withDebugger = vscode.workspace.getConfiguration('moro.repl').get<boolean>('debugger', true);
      const result = await this.evaluator.evaluate(
        text,
        pkg,
        withDebugger ? { onDebug: (event) => this.showDebugger(event), onDebugError: (message) => this.debuggerFailed(message) } : {},
      );
      this.closeDebugger();
      if (!result) {
        this.log('evaluation: no answer from the image');
        void vscode.window.showWarningMessage('moro: the image did not answer; the REPL may have closed.');
      }
      return result;
    } finally {
      this.setBusy(-1);
    }
  }

  /** Evaluates `text` in `pkg`, decorating `range` in `editor` with the result. */
  async evaluate(editor: vscode.TextEditor, range: vscode.Range, text: string, pkg: string | null): Promise<LiveEvaluation | null> {
    const result = await this.run(text, pkg);
    if (!result) return null;
    this.channel.append(channelText(text, result));
    if (!result.ok) this.channel.show(true);
    this.showResult(editor, range, result);
    return result;
  }

  /** Macroexpands `form` with `expander` in the image and opens the expansion beside the editor. */
  async macroexpand(expander: 'macroexpand-1' | 'macroexpand', form: string, pkg: string | null): Promise<void> {
    const result = await this.run(`(${expander} (quote ${form}))`, pkg);
    if (!result) return;
    if (!result.ok) {
      this.channel.append(channelText(`${expander} ${formSummary(form)}`, result));
      this.channel.show(true);
      void vscode.window.showErrorMessage(`moro: ${expander} failed: ${result.error ?? 'error'}`);
      return;
    }
    const expansion = result.values[0] ?? '';
    this.channel.append(`;; ${expander}: ${formSummary(form)}\n${expansion}\n`);
    const document = await vscode.workspace.openTextDocument({ language: 'commonlisp', content: `${expansion}\n` });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  }

  /** Runs a form whose output is the answer (describe, apropos) and shows the output in the results channel. */
  async showOutput(heading: string, text: string, pkg: string | null): Promise<void> {
    const result = await this.run(text, pkg);
    if (!result) return;
    if (!result.ok) {
      this.channel.append(channelText(heading, result));
    } else {
      this.channel.append(`;; ${heading}\n${result.output.trim() ? result.output.replace(/\n$/, '') : '; nothing to show'}\n`);
    }
    this.channel.show(true);
  }

  describe(symbol: string, pkg: string | null): Promise<void> {
    return this.showOutput(`describe ${symbol}`, `(describe (quote ${symbol}))`, pkg);
  }

  apropos(query: string, pkg: string | null): Promise<void> {
    return this.showOutput(`apropos ${JSON.stringify(query)}`, `(apropos ${lispString(query)})`, pkg);
  }

  /** Interrupts the running evaluation, or abandons the one waiting in the debugger. */
  async interrupt(): Promise<boolean> {
    if (this.evaluator.debuggerActive) {
      this.debuggerPanel?.resuming();
      return this.evaluator.abortDebugger();
    }
    return this.control.interrupt();
  }

  /** Inspects the value of `text` evaluated in `pkg`, opening the inspector panel. */
  async inspect(text: string, pkg: string | null): Promise<void> {
    if (this.refuseWhileDebugging()) return;
    this.setBusy(1);
    try {
      const result = await this.evaluator.inspect(text, pkg);
      this.showInspector(result, text);
    } finally {
      this.setBusy(-1);
    }
  }

  private showInspector(result: InspectorResult, subject?: string): void {
    if (!result) {
      void vscode.window.showWarningMessage('moro: the image did not answer; the REPL may have closed.');
      return;
    }
    if ('error' in result) {
      void vscode.window.showErrorMessage(`moro: ${result.error}`);
      return;
    }
    if (!this.inspector) {
      this.inspector = new InspectorPanel(
        (index) => void this.control.inspectPart(index).then((r) => this.showInspector(r)),
        () => void this.control.inspectPop().then((r) => this.showInspector(r)),
        () => (this.inspector = undefined),
      );
    }
    this.inspector.show(result.view, subject);
  }

  private refuseWhileDebugging(): boolean {
    if (!this.evaluator.debuggerActive) return false;
    void vscode.window.showWarningMessage('moro: an evaluation is waiting in the debugger; choose a restart or abort it first.');
    this.debuggerPanel?.reveal();
    return true;
  }

  private showDebugger(event: DebuggerEvent): void {
    if (!this.debuggerPanel) {
      this.debuggerPanel = new DebuggerPanel({
        onRestart: (index) => void this.invokeRestart(index),
        onAbort: () => {
          this.debuggerPanel?.resuming();
          this.evaluator.abortDebugger();
        },
        onFrame: (index) => this.evaluator.frameLocals(index),
        onInspectCondition: () => void this.evaluator.inspectCondition().then((result) => this.showInspector(result, 'the condition')),
        onInspectLocal: (frame, local) => void this.evaluator.inspectLocal(frame, local).then((result) => this.showInspector(result, `frame ${frame}`)),
        onClose: () => {
          // Closing the panel abandons the evaluation, as quitting a debugger does.
          this.debuggerPanel = undefined;
          if (this.evaluator.debuggerActive) this.evaluator.abortDebugger();
          this.updateState();
        },
      });
    }
    this.debuggerPanel.show(event);
    this.updateState();
  }

  private closeDebugger(): void {
    const panel = this.debuggerPanel;
    this.debuggerPanel = undefined;
    panel?.dispose();
    this.updateState();
  }

  /** Invokes restart `index` of the current debugger event, asking for a value form when the restart takes one. */
  private async invokeRestart(index: number): Promise<void> {
    const restart = this.debuggerPanel?.event?.restarts.find((r) => r.index === index);
    if (!restart || !this.evaluator.debuggerActive) return;
    const args: string[] = [];
    if (/^(USE-VALUE|STORE-VALUE)$/.test(restart.name)) {
      const form = await vscode.window.showInputBox({
        title: `moro: ${restart.name}`,
        prompt: `A form, evaluated in the image, for the value to use (${restart.description})`,
        placeHolder: '42',
        ignoreFocusOut: true,
      });
      if (form === undefined || !form.trim()) return;
      args.push(form);
    }
    if (this.evaluator.invokeRestart(index, args)) this.debuggerPanel?.resuming();
  }

  private debuggerFailed(message: string): void {
    this.log(`debugger: ${message}`);
    this.debuggerPanel?.failed(message);
  }

  private setBusy(delta: number): void {
    this.evaluating += delta;
    this.updateState();
  }

  private updateState(): void {
    const state: SessionState = this.debuggerPanel && this.evaluator.debuggerActive ? 'debugger' : this.evaluating > 0 ? 'evaluating' : 'idle';
    if (state !== this.state) {
      this.state = state;
      this.onState(state);
    }
  }

  private showResult(editor: vscode.TextEditor, range: vscode.Range, result: LiveEvaluation): void {
    if (!vscode.workspace.getConfiguration('moro.repl').get<boolean>('inlineResults', true)) return;
    const key = editor.document.uri.toString();
    const entry = this.results.get(key) ?? { ok: [], error: [] };
    const line = range.end.line;
    entry.ok = entry.ok.filter((d) => d.range.end.line !== line);
    entry.error = entry.error.filter((d) => d.range.end.line !== line);
    const decoration: vscode.DecorationOptions = {
      range: new vscode.Range(range.end, range.end),
      renderOptions: { after: { contentText: `=> ${inlineText(result)}` } },
      hoverMessage: new vscode.MarkdownString(`\`\`\`lisp\n${result.ok ? result.values.join('\n') : result.error ?? ''}\n\`\`\``),
    };
    (result.ok ? entry.ok : entry.error).push(decoration);
    this.results.set(key, entry);
    editor.setDecorations(this.resultType, entry.ok);
    editor.setDecorations(this.errorType, entry.error);
  }

  clearResults(uri?: vscode.Uri): void {
    const keys = uri ? [uri.toString()] : [...this.results.keys()];
    for (const key of keys) this.results.delete(key);
    this.redraw();
  }

  private redraw(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = this.results.get(editor.document.uri.toString());
      editor.setDecorations(this.resultType, entry?.ok ?? []);
      editor.setDecorations(this.errorType, entry?.error ?? []);
    }
  }
}

/** A webview listing the parts of the inspected object; parts with parts of their own are buttons. */
class InspectorPanel {
  private readonly panel: vscode.WebviewPanel;
  private subject: string | undefined;

  constructor(onPart: (index: number) => void, onBack: () => void, onClose: () => void) {
    this.panel = vscode.window.createWebviewPanel('moro.inspector', 'moro inspector', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage((message: { command?: string; index?: number }) => {
      if (message.command === 'part' && typeof message.index === 'number') onPart(message.index);
      else if (message.command === 'back') onBack();
    });
    this.panel.onDidDispose(onClose);
  }

  dispose(): void {
    this.panel.dispose();
  }

  show(view: InspectorView, subject?: string): void {
    if (subject !== undefined) this.subject = subject;
    this.panel.title = `moro inspector: ${view.type}`;
    this.panel.webview.html = this.render(view);
    this.panel.reveal(undefined, true);
  }

  private render(view: InspectorView): string {
    const n = nonce();
    const rows = view.parts
      .map((part) => {
        const value = escapeHtml(part.value);
        const cell = part.expandable ? `<button class="part" data-index="${part.index}" title="Inspect">${value}</button>` : `<code>${value}</code>`;
        return `<tr><th scope="row">${escapeHtml(part.label)}</th><td>${cell}</td></tr>`;
      })
      .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<title>moro inspector</title>
<style nonce="${n}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1em; }
  h1 { font-size: 1.1em; font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 1em; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; vertical-align: top; padding: 0.25em 1em 0.25em 0; color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; }
  td { padding: 0.25em 0; font-family: var(--vscode-editor-font-family); word-break: break-all; }
  code { white-space: pre-wrap; }
  button.part { font: inherit; text-align: left; background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; white-space: pre-wrap; }
  button.part:hover, button.part:focus { text-decoration: underline; outline: none; }
  button.back { margin: 1em 0; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 0.3em 0.8em; border-radius: 2px; cursor: pointer; }
  button.back:disabled { opacity: 0.5; cursor: default; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
<h1>${escapeHtml(view.title)}</h1>
<div class="meta">${escapeHtml(view.type)}${this.subject ? ` · from <code>${escapeHtml(this.subject)}</code>` : ''} · depth ${view.depth}</div>
<button class="back" ${view.depth > 1 ? '' : 'disabled'}>← back</button>
${rows ? `<table>${rows}</table>` : '<p class="empty">No parts.</p>'}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  for (const button of document.querySelectorAll('button.part')) {
    button.addEventListener('click', () => vscode.postMessage({ command: 'part', index: Number(button.dataset.index) }));
  }
  document.querySelector('button.back').addEventListener('click', () => vscode.postMessage({ command: 'back' }));
</script>
</body>
</html>`;
  }
}
