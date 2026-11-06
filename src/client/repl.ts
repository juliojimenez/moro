/**
 * A terminal-hosted REPL. Any Common Lisp implementation works because we only
 * ever send text to its standard input.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface ReplCommand {
  command: string;
  args: string[];
}

const CANDIDATES = ['sbcl', 'ros', 'ccl', 'ccl64', 'lx86cl64', 'ecl', 'clisp', 'abcl'];

function implicitArgs(command: string): string[] {
  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (base === 'sbcl') return ['--noinform'];
  if (base === 'ros') return ['run'];
  return [];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file, fs.constants.X_OK);
    const stat = await fs.promises.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Resolves a bare command name against PATH; returns the input when it already has a directory part. */
export async function resolveOnPath(command: string): Promise<string | undefined> {
  if (command.includes('/') || command.includes('\\')) return (await isExecutable(command)) ? command : undefined;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function lispString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function lispPath(fsPath: string): string {
  return lispString(fsPath.split(path.sep).join('/'));
}

export class Repl implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private lastPackage: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === this.terminal) {
          this.terminal = undefined;
          this.lastPackage = null;
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.terminal?.dispose();
    this.terminal = undefined;
  }

  get running(): boolean {
    return this.terminal !== undefined;
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('moro.repl');
  }

  private async resolveCommand(): Promise<ReplCommand | undefined> {
    const configured = this.config.get<string>('command', '').trim();
    const extraArgs = this.config.get<string[]>('args', []);
    if (configured) {
      const resolved = (await resolveOnPath(configured)) ?? configured;
      return { command: resolved, args: [...implicitArgs(resolved), ...extraArgs] };
    }
    for (const candidate of CANDIDATES) {
      const resolved = await resolveOnPath(candidate);
      if (resolved) return { command: resolved, args: [...implicitArgs(resolved), ...extraArgs] };
    }
    const choice = await vscode.window.showErrorMessage(
      'moro could not find a Common Lisp implementation (sbcl, ros, ccl, ecl, clisp or abcl) on your PATH.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'moro.repl.command');
    }
    return undefined;
  }

  private workingDirectory(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) return folder.uri.fsPath;
      return path.dirname(editor.document.uri.fsPath);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async start(): Promise<vscode.Terminal | undefined> {
    const resolved = await this.resolveCommand();
    if (!resolved) return undefined;
    this.terminal?.dispose();
    this.lastPackage = null;
    this.terminal = vscode.window.createTerminal({
      name: 'moro REPL',
      shellPath: resolved.command,
      shellArgs: resolved.args,
      cwd: this.workingDirectory(),
      iconPath: new vscode.ThemeIcon('symbol-misc'),
      isTransient: true,
    });
    this.terminal.show(true);
    return this.terminal;
  }

  stop(): void {
    this.terminal?.dispose();
    this.terminal = undefined;
    this.lastPackage = null;
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  private async ensure(): Promise<vscode.Terminal | undefined> {
    return this.terminal ?? (await this.start());
  }

  /** Sends raw text followed by a newline. */
  async send(text: string): Promise<boolean> {
    const terminal = await this.ensure();
    if (!terminal) return false;
    terminal.sendText(text, true);
    if (this.config.get<boolean>('revealOnEval', true)) terminal.show(true);
    return true;
  }

  /** Switches the REPL to `pkg` when it exists in the image; a no-op otherwise. */
  async syncPackage(pkg: string | null, force = false): Promise<void> {
    if (!pkg) return;
    if (!force && (pkg === this.lastPackage || !this.config.get<boolean>('syncPackage', true))) return;
    const ok = await this.send(`(setf *package* (or (find-package ${lispString(pkg)}) *package*))`);
    if (ok) this.lastPackage = pkg;
  }

  /** Evaluates a form, first syncing the package it was written in. */
  async evalForm(form: string, pkg: string | null, inPackageTarget: string | null): Promise<void> {
    await this.syncPackage(pkg);
    const ok = await this.send(form);
    if (ok && inPackageTarget) this.lastPackage = inPackageTarget;
  }

  interrupt(): void {
    this.terminal?.sendText('\u0003', false);
    this.terminal?.show(true);
  }
}
