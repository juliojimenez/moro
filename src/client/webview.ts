/** Helpers shared by the webview panels (inspector, debugger). */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A fresh nonce for the panel's Content-Security-Policy. */
export function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Styles common to the panels: VS Code's font and colors, plain buttons that look like links. */
export const panelStyles = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1em 1em; }
  h1 { font-size: 1.1em; font-family: var(--vscode-editor-font-family); word-break: break-word; white-space: pre-wrap; }
  h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 1.5em 0 0.5em; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 1em; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; vertical-align: top; padding: 0.25em 1em 0.25em 0; color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; }
  td { padding: 0.25em 0; font-family: var(--vscode-editor-font-family); word-break: break-all; }
  code { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
  button.link { font: inherit; text-align: left; background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; white-space: pre-wrap; }
  button.link:hover, button.link:focus { text-decoration: underline; outline: none; }
  button.link:disabled { color: var(--vscode-disabledForeground); text-decoration: none; cursor: default; }
  button.action { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 0.3em 0.8em; border-radius: 2px; cursor: pointer; }
  button.action.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.action:disabled { opacity: 0.5; cursor: default; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
`;
