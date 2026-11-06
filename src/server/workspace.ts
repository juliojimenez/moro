/**
 * The workspace index: every Lisp file we know about, parsed and analyzed,
 * with lookups by symbol name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, ParseResult, isList, isSymbol, LAMBDA_LIST_KEYWORDS } from '../common/reader';
import { analyze, Definition, FileAnalysis, Occurrence } from './analysis';

export const LISP_EXTENSIONS = new Set(['.lisp', '.lsp', '.cl', '.asd', '.asdf', '.ros']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexedFile {
  uri: string;
  parse: ParseResult;
  analysis: FileAnalysis;
  /** True when the content came from disk rather than an open editor. */
  fromDisk: boolean;
}

export interface FoundDefinition {
  file: IndexedFile;
  def: Definition;
}

export interface FoundOccurrence {
  file: IndexedFile;
  occurrence: Occurrence;
}

export interface IndexingSettings {
  exclude: string[];
  maxFiles: number;
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export class WorkspaceIndex {
  readonly files = new Map<string, IndexedFile>();
  settings: IndexingSettings = { exclude: [], maxFiles: 3000 };
  private scanning: Promise<number> | null = null;

  get(uri: string): IndexedFile | undefined {
    return this.files.get(uri);
  }

  update(uri: string, text: string, fromDisk: boolean): IndexedFile {
    const result = parse(text);
    const file: IndexedFile = { uri, parse: result, analysis: analyze(result), fromDisk };
    this.files.set(uri, file);
    return file;
  }

  remove(uri: string): void {
    this.files.delete(uri);
  }

  /** Re-reads a file from disk; removes it when it no longer exists. */
  async refreshFromDisk(uri: string): Promise<void> {
    if (!uri.startsWith('file:')) return;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return;
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        this.remove(uri);
        return;
      }
      const text = await fs.promises.readFile(filePath, 'utf8');
      this.update(uri, text, true);
    } catch {
      this.remove(uri);
    }
  }

  /** Indexes every Lisp file under the given folders. Returns the number of files read. */
  scanFolders(folders: string[], log: (message: string) => void): Promise<number> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan(folders, log).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(folders: string[], log: (message: string) => void): Promise<number> {
    const excludes = this.settings.exclude.map(globToRegExp);
    const budget = { remaining: this.settings.maxFiles };
    let count = 0;
    const started = Date.now();
    for (const folder of folders) {
      const files: string[] = [];
      await collectFiles(folder, folder, excludes, budget, files);
      for (const filePath of files) {
        const uri = pathToFileURL(filePath).toString();
        const existing = this.files.get(uri);
        if (existing && !existing.fromDisk) continue; // an open editor is authoritative
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = await fs.promises.readFile(filePath, 'utf8');
          this.update(uri, text, true);
          count++;
        } catch (error) {
          log(`Could not index ${filePath}: ${String(error)}`);
        }
      }
    }
    log(`Indexed ${count} Lisp files in ${Date.now() - started} ms`);
    return count;
  }

  /** Definitions named `name`, preferring those in package `pkg` when given. */
  findDefinitions(name: string, pkg: string | null = null): FoundDefinition[] {
    const all: FoundDefinition[] = [];
    for (const file of this.files.values()) {
      for (const def of file.analysis.flat) {
        if (def.name === name) all.push({ file, def });
      }
    }
    if (pkg && pkg !== 'KEYWORD') {
      const inPackage = all.filter((found) => found.def.pkg === pkg);
      if (inPackage.length) return inPackage;
    }
    return all;
  }

  /** Occurrences of `name`; keyword occurrences only when `asKeyword`, otherwise symbol occurrences only. */
  findOccurrences(name: string, asKeyword: boolean): FoundOccurrence[] {
    const out: FoundOccurrence[] = [];
    for (const file of this.files.values()) {
      const list = file.analysis.occurrences.get(name);
      if (!list) continue;
      for (const occurrence of list) {
        const isKeyword = occurrence.node.kind === 'keyword';
        if (isKeyword === asKeyword) out.push({ file, occurrence });
      }
    }
    return out;
  }

  *allDefinitions(): IterableIterator<FoundDefinition> {
    for (const file of this.files.values()) {
      for (const def of file.analysis.flat) yield { file, def };
    }
  }

  /** Names known to belong to package `pkg`: definitions made in it plus its exports. */
  symbolsInPackage(pkg: string): Map<string, FoundDefinition | null> {
    const names = new Map<string, FoundDefinition | null>();
    for (const found of this.allDefinitions()) {
      if (found.def.pkg === pkg && !names.has(found.def.name)) names.set(found.def.name, found);
      if (found.def.kind === 'package' && found.def.name === pkg) {
        for (const exported of found.def.exports ?? []) {
          if (!names.has(exported)) names.set(exported, null);
        }
      }
    }
    return names;
  }

  allKeywords(): Set<string> {
    const out = new Set<string>();
    for (const file of this.files.values()) {
      for (const keyword of file.analysis.keywords) out.add(keyword);
    }
    return out;
  }

  allPackages(): string[] {
    const out = new Set<string>();
    for (const file of this.files.values()) {
      for (const pkg of file.analysis.packages) out.add(pkg);
    }
    return [...out];
  }
}

async function collectFiles(root: string, dir: string, excludes: RegExp[], budget: { remaining: number }, out: string[]): Promise<void> {
  if (budget.remaining <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    const probe = entry.isDirectory() ? `${relative}/` : relative;
    if (excludes.some((re) => re.test(relative) || re.test(probe) || re.test(full.split(path.sep).join('/')))) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      await collectFiles(root, full, excludes, budget, out);
    } else if (entry.isFile() && LISP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
      budget.remaining--;
    }
  }
}

/**
 * Number of required parameters before &body in a lambda list, or undefined
 * when the lambda list has no &body (the operator is then indented as a call).
 */
export function bodyArity(lambdaList: string): number | undefined {
  const result = parse(lambdaList);
  const list = result.forms[0];
  if (!isList(list)) return undefined;
  let required = 0;
  let counting = true;
  let skipNext = false;
  for (const param of list.children) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isSymbol(param) && LAMBDA_LIST_KEYWORDS.has(param.name)) {
      if (param.name === '&BODY') return required;
      if (param.name === '&WHOLE' || param.name === '&ENVIRONMENT') {
        skipNext = true;
      } else {
        // &optional, &rest, &key, &aux end the required parameters but a
        // later &body still counts: (name &optional doc &body body).
        counting = false;
      }
      continue;
    }
    if (counting) required++;
  }
  return undefined;
}
