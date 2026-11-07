/**
 * The ASDF systems the REPL commands can load: those defined by `.asd` files
 * in the workspace and those listed in the `moro.systems` setting, which may
 * live anywhere on disk. Browsing for an `.asd` file adds it to that setting.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defsystemNames } from './forms';

export interface KnownSystem {
  /** Lower-case system name as written in the defsystem. */
  name: string;
  /** Directory holding the .asd file, or '' when only the name is known. */
  directory: string;
  asdPath: string;
  origin: 'workspace' | 'configured' | 'name';
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function asdFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.asd'))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

export function workspaceFolderPaths(): string[] {
  return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
}

/** The `moro.systems` entries that resolve to existing .asd files: absolute, `~`-prefixed, or relative to a workspace folder; a directory stands for the .asd files in it. */
export function configuredAsdFiles(): string[] {
  const entries = vscode.workspace.getConfiguration('moro').get<unknown[]>('systems', []);
  const folders = workspaceFolderPaths();
  const out: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const entry = raw.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    const candidates = path.isAbsolute(entry) ? [entry] : folders.map((folder) => path.resolve(folder, entry));
    const resolved = candidates.find(exists);
    if (!resolved) continue;
    if (isDirectory(resolved)) out.push(...asdFilesIn(resolved));
    else if (resolved.toLowerCase().endsWith('.asd')) out.push(resolved);
  }
  return [...new Set(out)];
}

/** The systems a .asd file defines. */
export async function systemsDefinedIn(asdPath: string, origin: KnownSystem['origin']): Promise<KnownSystem[]> {
  try {
    const text = await fs.promises.readFile(asdPath, 'utf8');
    return defsystemNames(text).map((name) => ({ name, directory: path.dirname(asdPath), asdPath, origin }));
  } catch {
    return [];
  }
}

export async function workspaceSystems(): Promise<KnownSystem[]> {
  const files = await vscode.workspace.findFiles('**/*.asd', '**/{node_modules,.git,.qlot}/**', 200);
  const out: KnownSystem[] = [];
  for (const file of files) out.push(...(await systemsDefinedIn(file.fsPath, 'workspace')));
  return out;
}

export async function configuredSystems(): Promise<KnownSystem[]> {
  const out: KnownSystem[] = [];
  for (const asd of configuredAsdFiles()) out.push(...(await systemsDefinedIn(asd, 'configured')));
  return out;
}

/** Workspace systems first, then the configured ones, without duplicates. */
export async function knownSystems(): Promise<KnownSystem[]> {
  const seen = new Set<string>();
  const out: KnownSystem[] = [];
  for (const system of [...(await workspaceSystems()), ...(await configuredSystems())]) {
    const key = `${system.name}@${system.asdPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(system);
  }
  return out;
}

/**
 * How an .asd file is written into `moro.systems`: relative to the first
 * workspace folder when it is inside it or at most one level above (a sibling
 * project), so the setting travels with the project; absolute otherwise.
 */
export function settingEntryFor(asdPath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return asdPath;
  const relative = path.relative(folder, asdPath);
  if (!relative || path.isAbsolute(relative)) return asdPath;
  const climbs = relative.split(path.sep).filter((part) => part === '..').length;
  return climbs <= 1 ? relative.split(path.sep).join('/') : asdPath;
}

/** Adds an .asd file to `moro.systems` (workspace settings, or user settings without a workspace); returns the entry written. */
export async function rememberSystemFile(asdPath: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('moro');
  const current = config.get<unknown[]>('systems', []).filter((e): e is string => typeof e === 'string');
  const entry = settingEntryFor(asdPath);
  if (!current.includes(entry) && !current.includes(asdPath)) {
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('systems', [...current, entry], target);
  }
  return entry;
}

/** Lets the user pick an .asd file anywhere on disk. */
export async function browseForAsd(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: folder ? vscode.Uri.joinPath(folder, '..') : undefined,
    filters: { 'ASDF system definitions': ['asd'] },
    openLabel: 'Add system',
    title: 'moro: choose an .asd file whose systems the REPL can load',
  });
  return picked?.[0]?.fsPath;
}
