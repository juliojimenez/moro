/**
 * A terminal-hosted REPL. Any Common Lisp implementation works because we only
 * ever send text to its standard input.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface ReplCommand {
  command: string;
  args: string[];
}

/** Where the backend inside the REPL image listens; sent to the language server. */
export interface LiveImageInfo {
  port: number;
  tokenPath: string;
}

function implementationName(command: string): string {
  return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** Implementations whose command line can load the backend and that have threads for it. */
const BACKEND_IMPLEMENTATIONS = new Set(['sbcl', 'ecl', 'ccl', 'ccl64', 'lx86cl64', 'abcl', 'ros']);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const CANDIDATES = ['sbcl', 'ros', 'ccl', 'ccl64', 'lx86cl64', 'ecl', 'clisp', 'abcl'];

function implicitArgs(command: string): string[] {
  const base = implementationName(command);
  if (base === 'sbcl') return ['--noinform'];
  if (base === 'ros') return ['run'];
  return [];
}

/** Arguments that load the backend file and start it; `run` must stay last for Roswell. */
function backendArgs(command: string, backendPath: string, startForm: string): string[] {
  const base = implementationName(command);
  if (base === 'ros') return ['-l', backendPath, '-e', startForm];
  return ['--load', backendPath, '--eval', startForm];
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
  private tokenDirectory: string | undefined;
  /** Backend connection info of the running REPL, if it was started with one. */
  image: LiveImageInfo | null = null;
  /** Called when the backend info changes (REPL started with a backend, or closed). */
  onImage: (info: LiveImageInfo | null) => void = () => undefined;

  constructor(private readonly backendPath: string) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === this.terminal) {
          this.terminal = undefined;
          this.lastPackage = null;
          this.clearImage();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.terminal?.dispose();
    this.terminal = undefined;
    this.clearImage();
  }

  private clearImage(): void {
    if (this.tokenDirectory) {
      fs.rmSync(this.tokenDirectory, { recursive: true, force: true });
      this.tokenDirectory = undefined;
    }
    if (this.image) {
      this.image = null;
      this.onImage(null);
    }
  }

  /** A free loopback port and a token only this user can read, for the backend inside the image. */
  private async prepareImage(command: string): Promise<{ args: string[]; info: LiveImageInfo } | undefined> {
    if (!this.config.get<boolean>('liveBackend', true) || !BACKEND_IMPLEMENTATIONS.has(implementationName(command))) return undefined;
    try {
      const port = await freePort();
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-'));
      const tokenPath = path.join(directory, 'token');
      fs.writeFileSync(tokenPath, randomBytes(24).toString('hex'), { mode: 0o600 });
      this.tokenDirectory = directory;
      const startForm = `(moro-backend:start ${port} ${lispString(tokenPath.split(path.sep).join('/'))})`;
      return { args: backendArgs(command, this.backendPath.split(path.sep).join('/'), startForm), info: { port, tokenPath } };
    } catch (error) {
      void vscode.window.showWarningMessage(`moro: the live backend could not be prepared (${String(error)}); the REPL starts without it.`);
      return undefined;
    }
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
    this.clearImage();
    const image = await this.prepareImage(resolved.command);
    // Roswell wants `run` last; everything else takes the backend after its own options.
    const args = image
      ? implementationName(resolved.command) === 'ros'
        ? [...image.args, ...resolved.args]
        : [...resolved.args, ...image.args]
      : resolved.args;
    this.terminal = vscode.window.createTerminal({
      name: 'moro REPL',
      shellPath: resolved.command,
      shellArgs: args,
      cwd: this.workingDirectory(),
      iconPath: new vscode.ThemeIcon('symbol-misc'),
      isTransient: true,
    });
    this.terminal.show(true);
    if (image) {
      this.image = image.info;
      this.onImage(image.info);
    }
    return this.terminal;
  }

  stop(): void {
    this.terminal?.dispose();
    this.terminal = undefined;
    this.lastPackage = null;
    this.clearImage();
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
