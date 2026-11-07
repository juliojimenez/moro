/**
 * The workspace index: every Lisp file we know about, parsed and analyzed,
 * with lookups by symbol name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AtomNode, parse, ParseResult, isList, isSymbol, LAMBDA_LIST_KEYWORDS } from '../common/reader';
import { analyze, Definition, FileAnalysis, Occurrence, packageAtOffset } from './analysis';
import { PackageModel, ResolvedSymbol, sameSymbol } from './packages';
import {
  LISP_EXTENSIONS,
  SystemRecord,
  collectSystemFiles,
  defaultRegistryRoots,
  discoverSystems,
  ociclSystems,
  primarySystemName,
  resolveDependencies,
} from './systems';

export { LISP_EXTENSIONS };
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type FileSource = 'workspace' | 'dependency';

export interface IndexedFile {
  uri: string;
  parse: ParseResult;
  analysis: FileAnalysis;
  /** True when the content came from disk rather than an open editor. */
  fromDisk: boolean;
  /** Workspace files are the user's; dependency files come from ASDF systems the workspace uses. */
  source: FileSource;
}

export interface UpdateOptions {
  fromDisk: boolean;
  /** Defaults to the file's previous source, or 'workspace' for a new file. */
  source?: FileSource;
}

export interface DependencySettings {
  enabled: boolean;
  registries: string[];
  maxFiles: number;
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
  dependencySettings: DependencySettings = { enabled: true, registries: [], maxFiles: 4000 };
  /** Systems resolved by the last dependency scan, by primary name. */
  readonly dependencySystems = new Map<string, SystemRecord>();
  /** Wanted systems no registry provided. */
  missingSystems: string[] = [];
  private scanning: Promise<number> | null = null;
  private exportsCache: Set<string> | null = null;
  /** Bumped on every change; caches derived from the index check it. */
  version = 0;
  private modelVersion = -1;
  private model: PackageModel | null = null;

  get(uri: string): IndexedFile | undefined {
    return this.files.get(uri);
  }

  update(uri: string, text: string, options: UpdateOptions): IndexedFile {
    const result = parse(text);
    const source = options.source ?? this.files.get(uri)?.source ?? 'workspace';
    const file: IndexedFile = { uri, parse: result, analysis: analyze(result), fromDisk: options.fromDisk, source };
    this.files.set(uri, file);
    if (source === 'dependency') this.exportsCache = null;
    this.version++;
    return file;
  }

  remove(uri: string): void {
    if (this.files.get(uri)?.source === 'dependency') this.exportsCache = null;
    this.files.delete(uri);
    this.version++;
  }

  /** The package model for the current state of the index. */
  packageModel(): PackageModel {
    if (!this.model || this.modelVersion !== this.version) {
      this.model = new PackageModel([...this.allDefinitions()].map((f) => f.def));
      this.modelVersion = this.version;
    }
    return this.model;
  }

  /** Home package of an occurrence, from its file's in-package and the package model. */
  resolveOccurrence(file: IndexedFile, occurrence: Occurrence): ResolvedSymbol {
    return this.packageModel().resolve({
      name: occurrence.name,
      pkg: occurrence.pkg,
      keyword: occurrence.node.kind === 'keyword',
      uninterned: !!occurrence.node.uninterned,
      role: occurrence.role,
      source: occurrence.source,
      context: packageAtOffset(file.analysis, occurrence.start),
    });
  }

  /** Home package of the symbol node under the cursor (which must come from `file.parse`). */
  resolveSymbol(file: IndexedFile, symbol: AtomNode): ResolvedSymbol {
    const occurrence = file.analysis.occurrences.get(symbol.name)?.find((o) => o.node === symbol);
    if (occurrence) return this.resolveOccurrence(file, occurrence);
    return this.packageModel().resolve({
      name: symbol.name,
      pkg: symbol.pkg,
      keyword: symbol.kind === 'keyword',
      uninterned: !!symbol.uninterned,
      context: packageAtOffset(file.analysis, symbol.start),
    });
  }

  /** Occurrences of the same symbol as `target` across the index (package-aware). */
  occurrencesOf(target: ResolvedSymbol): FoundOccurrence[] {
    if (target.excluded) return [];
    const out: FoundOccurrence[] = [];
    for (const file of this.files.values()) {
      const list = file.analysis.occurrences.get(target.name);
      if (!list) continue;
      for (const occurrence of list) {
        if (sameSymbol(target, this.resolveOccurrence(file, occurrence))) out.push({ file, occurrence });
      }
    }
    return out;
  }

  /** Home package of a definition: its symbol as seen from the package the definition was written in. */
  definitionHome(def: Definition): string {
    return this.packageModel().homeOf(def.name, def.pkg ?? 'COMMON-LISP-USER');
  }

  /**
   * Definitions of the symbol `target`: those in its home package when there
   * are any (or when the target is lenient, every package's), else all of
   * them so that go to definition still has somewhere to go.
   */
  definitionsFor(target: ResolvedSymbol): FoundDefinition[] {
    const all: FoundDefinition[] = [];
    for (const file of this.files.values()) {
      for (const def of file.analysis.flat) {
        if (def.name === target.name) all.push({ file, def });
      }
    }
    if (target.keyword) return all.filter((f) => f.def.kind === 'package' || f.def.kind === 'system');
    if (!target.strict) return all;
    const exact = all.filter((f) => this.definitionHome(f.def) === target.home);
    return exact.length ? exact : all;
  }

  isDependency(uri: string): boolean {
    return this.files.get(uri)?.source === 'dependency';
  }

  /** Symbol names exported by packages defined in dependency files: what dependencies offer to completion. */
  dependencyExports(): Set<string> {
    if (this.exportsCache) return this.exportsCache;
    const out = new Set<string>();
    for (const file of this.files.values()) {
      if (file.source !== 'dependency') continue;
      for (const def of file.analysis.flat) {
        if (def.kind === 'package') for (const name of def.exports ?? []) out.add(name);
      }
    }
    this.exportsCache = out;
    return out;
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
      this.update(uri, text, { fromDisk: true });
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
          this.update(uri, text, { fromDisk: true, source: 'workspace' });
          count++;
        } catch (error) {
          log(`Could not index ${filePath}: ${String(error)}`);
        }
      }
    }
    log(`Indexed ${count} Lisp files in ${Date.now() - started} ms`);
    return count;
  }

  /**
   * Indexes the ASDF systems the workspace depends on: :depends-on of the
   * workspace's own systems plus ql:quickload / asdf:load-system calls,
   * resolved transitively through the registries. Returns the number of files read.
   */
  async scanDependencies(folders: string[], log: (message: string) => void): Promise<number> {
    if (!this.dependencySettings.enabled) return 0;
    const started = Date.now();
    const wanted = new Set<string>();
    const provided = new Set<string>();
    for (const file of this.files.values()) {
      if (file.source !== 'workspace') continue;
      for (const name of file.analysis.requestedSystems) wanted.add(primarySystemName(name));
      for (const def of file.analysis.flat) {
        if (def.kind !== 'system') continue;
        provided.add(primarySystemName(def.name));
        for (const dep of def.dependsOn ?? []) wanted.add(primarySystemName(dep));
      }
    }
    for (const name of provided) wanted.delete(name);
    if (!wanted.size) {
      this.dependencySystems.clear();
      this.missingSystems = [];
      return 0;
    }
    const registry = new Map<string, string>();
    for (const folder of folders) {
      for (const [name, asd] of ociclSystems(folder)) if (!registry.has(name)) registry.set(name, asd);
    }
    const roots = defaultRegistryRoots(folders, { extra: this.dependencySettings.registries });
    for (const [name, asd] of await discoverSystems(roots)) if (!registry.has(name)) registry.set(name, asd);
    const resolved = await resolveDependencies(wanted, provided, registry);
    this.dependencySystems.clear();
    for (const system of resolved.systems) this.dependencySystems.set(system.name, system);
    this.missingSystems = resolved.missing;

    const files = await collectSystemFiles(resolved.systems, this.dependencySettings.maxFiles);
    let count = 0;
    for (const filePath of files) {
      const uri = pathToFileURL(filePath).toString();
      const existing = this.files.get(uri);
      if (existing && (existing.source === 'workspace' || !existing.fromDisk)) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        this.update(uri, await fs.promises.readFile(filePath, 'utf8'), { fromDisk: true, source: 'dependency' });
        count++;
      } catch (error) {
        log(`Could not index ${filePath}: ${String(error)}`);
      }
    }
    log(
      `Indexed ${count} files from ${resolved.systems.length} dependency systems in ${Date.now() - started} ms` +
        (resolved.missing.length ? `; not found: ${resolved.missing.join(', ')}` : ''),
    );
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

  /** Names known to belong to package `pkg` (a name or nickname): definitions made in it plus its exports, re-exports included. */
  symbolsInPackage(pkg: string, context: string | null = null): Map<string, FoundDefinition | null> {
    const model = this.packageModel();
    const canonical = model.canonical(pkg, context);
    const names = new Map<string, FoundDefinition | null>();
    for (const found of this.allDefinitions()) {
      if (found.def.pkg && model.canonical(found.def.pkg, null) === canonical && !names.has(found.def.name)) names.set(found.def.name, found);
    }
    for (const exported of model.exportsOf(canonical)) {
      if (!names.has(exported)) names.set(exported, null);
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
