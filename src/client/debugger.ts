/**
 * The debugger panel: the condition an evaluation in the image signalled, the
 * restarts the evaluation offers, and the backtrace with the locals of each
 * frame. Pressing a restart resumes the evaluation inside the image; Abort,
 * closing the panel or Interrupt Evaluation abandon it.
 */
import * as vscode from 'vscode';
import type { DebuggerEvent, FrameLocal } from '../common/live';
import { escapeHtml, nonce, panelStyles } from './webview';

export interface DebuggerHandlers {
  /** A restart was chosen (by button or number key). */
  onRestart: (index: number) => void;
  onAbort: () => void;
  /** A frame was expanded; resolves with its locals (empty when the implementation has none). */
  onFrame: (index: number) => Promise<FrameLocal[]>;
  onInspectCondition: () => void;
  onInspectLocal: (frame: number, local: number) => void;
  /** The user closed the panel while the debugger was still waiting. */
  onClose: () => void;
}

interface PanelMessage {
  command?: string;
  index?: number;
  frame?: number;
  local?: number;
}

export class DebuggerPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private current: DebuggerEvent | undefined;
  private closedByUser = true;

  constructor(private readonly handlers: DebuggerHandlers) {
    this.panel = vscode.window.createWebviewPanel('moro.debugger', 'moro debugger', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      if (this.closedByUser) handlers.onClose();
    });
  }

  /** Closes the panel because the evaluation finished (not a user abort). */
  dispose(): void {
    this.closedByUser = false;
    this.panel.dispose();
  }

  /** The event being shown. */
  get event(): DebuggerEvent | undefined {
    return this.current;
  }

  show(event: DebuggerEvent): void {
    this.current = event;
    this.panel.title = `moro debugger: ${event.type}`;
    this.panel.webview.html = this.render(event);
    this.panel.reveal(undefined, false);
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  /** A restart or abort was sent: controls wait for the image's next word. */
  resuming(): void {
    void this.panel.webview.postMessage({ command: 'resuming' });
  }

  /** The image refused the restart or abort; the debugger is still waiting. */
  failed(message: string): void {
    void this.panel.webview.postMessage({ command: 'failed', message });
  }

  private async receive(message: PanelMessage): Promise<void> {
    switch (message.command) {
      case 'restart':
        if (typeof message.index === 'number') this.handlers.onRestart(message.index);
        break;
      case 'abort':
        this.handlers.onAbort();
        break;
      case 'frame':
        if (typeof message.index === 'number') {
          const locals = await this.handlers.onFrame(message.index);
          void this.panel.webview.postMessage({ command: 'locals', frame: message.index, locals });
        }
        break;
      case 'inspect-condition':
        this.handlers.onInspectCondition();
        break;
      case 'inspect-local':
        if (typeof message.frame === 'number' && typeof message.local === 'number') this.handlers.onInspectLocal(message.frame, message.local);
        break;
    }
  }

  private render(event: DebuggerEvent): string {
    const n = nonce();
    const restarts = event.restarts
      .map(
        (restart) =>
          `<li><button class="link restart" data-index="${restart.index}"><kbd>${restart.index}</kbd> <span class="name">${escapeHtml(restart.name || '(anonymous)')}</span>` +
          `${restart.description ? ` <span class="desc">${escapeHtml(restart.description)}</span>` : ''}</button></li>`,
      )
      .join('\n');
    const frames = event.frames
      .map(
        (frame) =>
          `<li><button class="link frame" data-index="${frame.index}" aria-expanded="false"><span class="index">${frame.index}</span> <code>${escapeHtml(frame.text)}</code></button>` +
          `<div class="locals" id="locals-${frame.index}" hidden></div></li>`,
      )
      .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<title>moro debugger</title>
<style nonce="${n}">${panelStyles}
  ol { list-style: none; padding: 0; margin: 0; }
  li { margin: 0.2em 0; }
  kbd { display: inline-block; min-width: 1.4em; text-align: center; font-family: var(--vscode-editor-font-family); font-size: 0.9em; padding: 0 0.3em; border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground)); border-radius: 3px; color: var(--vscode-foreground); }
  .restart .name { font-weight: 600; }
  .restart .desc { color: var(--vscode-descriptionForeground); }
  .frame .index { display: inline-block; min-width: 1.6em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .frame { color: var(--vscode-foreground); }
  .locals { margin: 0.2em 0 0.6em 2.4em; }
  .actions { margin-top: 1.5em; display: flex; gap: 0.5em; align-items: center; }
  #status { color: var(--vscode-descriptionForeground); margin-left: 0.5em; }
  #status.error { color: var(--vscode-errorForeground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 1.5em; }
</style>
</head>
<body>
<h1>${escapeHtml(event.condition || '(no message)')}</h1>
<div class="meta">${escapeHtml(event.type)}${event.level > 1 ? ` · debugger level ${event.level}` : ''}</div>
<h2>Restarts</h2>
${restarts ? `<ol class="restarts">${restarts}</ol>` : '<p class="empty">No restarts.</p>'}
<h2>Backtrace</h2>
${frames ? `<ol class="frames">${frames}</ol>` : '<p class="empty">No frames available.</p>'}
<div class="actions">
  <button class="action secondary" id="inspect">Inspect condition</button>
  <button class="action" id="abort">Abort</button>
  <span id="status"></span>
</div>
<p class="hint">Number keys choose a restart, <kbd>a</kbd> aborts. Click a frame for its locals.</p>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const status = document.getElementById('status');
  const controls = () => document.querySelectorAll('button');
  const setBusy = (busy, message, isError) => {
    for (const button of controls()) button.disabled = busy;
    status.textContent = message || '';
    status.className = isError ? 'error' : '';
  };
  for (const button of document.querySelectorAll('button.restart')) {
    button.addEventListener('click', () => vscode.postMessage({ command: 'restart', index: Number(button.dataset.index) }));
  }
  for (const button of document.querySelectorAll('button.frame')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      const locals = document.getElementById('locals-' + index);
      if (!locals.hidden) {
        locals.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        return;
      }
      locals.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      if (!locals.dataset.loaded) {
        locals.innerHTML = '<span class="empty">loading…</span>';
        vscode.postMessage({ command: 'frame', index });
      }
    });
  }
  document.getElementById('inspect').addEventListener('click', () => vscode.postMessage({ command: 'inspect-condition' }));
  document.getElementById('abort').addEventListener('click', () => vscode.postMessage({ command: 'abort' }));
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (/^[0-9]$/.test(e.key)) {
      const button = document.querySelector('button.restart[data-index="' + e.key + '"]');
      if (button && !button.disabled) button.click();
    } else if (e.key === 'a') {
      const abort = document.getElementById('abort');
      if (!abort.disabled) abort.click();
    }
  });
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.addEventListener('message', (e) => {
    const message = e.data;
    if (message.command === 'resuming') setBusy(true, 'Resuming…', false);
    else if (message.command === 'failed') setBusy(false, message.message, true);
    else if (message.command === 'locals') {
      const locals = document.getElementById('locals-' + message.frame);
      if (!locals) return;
      locals.dataset.loaded = '1';
      if (!message.locals.length) {
        locals.innerHTML = '<span class="empty">no local variables recorded for this frame</span>';
        return;
      }
      locals.innerHTML = '<table>' + message.locals.map((local, i) =>
        '<tr><th scope="row">' + escape(local.name) + '</th><td><button class="link local" data-frame="' + message.frame + '" data-local="' + i + '">' + escape(local.value) + '</button></td></tr>').join('') + '</table>';
      for (const button of locals.querySelectorAll('button.local')) {
        button.addEventListener('click', () => vscode.postMessage({ command: 'inspect-local', frame: Number(button.dataset.frame), local: Number(button.dataset.local) }));
      }
    }
  });
</script>
</body>
</html>`;
  }
}
