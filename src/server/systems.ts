/**
 * ASDF systems outside the workspace: where they live, what they depend on,
 * and which source files to index for them.
 *
 * Registries, in priority order: the project's own `ocicl.csv` and `ocicl/`
 * directory, `.qlot/` and `quicklisp/` inside the workspace, extra roots from
 * settings, `CL_SOURCE_REGISTRY`, the ASDF source-registry configuration
 * files, `~/common-lisp`, the XDG source directory, Quicklisp and Roswell.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse, isList, isSymbol, designatorName, headName, stringContent, Node } from '../common/reader';

export const LISP_EXTENSIONS = new Set(['.lisp', '.lsp', '.cl', '.asd', '.asdf', '.ros']);

export interface RegistryEntry {
  /** 'directory' holds .asd files itself; 'tree' is searched recursively (depth-limited). */
  kind: 'directory' | 'tree';
  path: string;
}

export interface SystemRecord {
  /** Lower-case primary system name. */
  name: string;
  asdPath: string;
  directory: string;
  dependsOn: string[];
}

export interface ResolvedDependencies {
  systems: SystemRecord[];
  /** Wanted systems that no registry provides (implementation modules excluded). */
  missing: string[];
}

export interface RegistryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  extra?: string[];
}

const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', '_darcs', 'target', 'dist', 'out']);
/** Systems the implementation provides; never looked up in a registry. */
const IMPLEMENTATION_SYSTEMS = new Set(['asdf', 'uiop']);

export function primarySystemName(name: string): string {
  const lower = name.toLowerCase();
  const slash = lower.indexOf('/');
  return slash > 0 ? lower.slice(0, slash) : lower;
}

export function isImplementationSystem(name: string): boolean {
  const primary = primarySystemName(name);
  return IMPLEMENTATION_SYSTEMS.has(primary) || primary.startsWith('sb-');
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(p, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** A registry path from a configuration form: "dir", "dir/", or (:home "rel"). */
function registryPath(node: Node | undefined, home: string): string | null {
  if (!node) return null;
  if (node.kind === 'string') return stringContent(node.text);
  if (isList(node) && headName(node) === 'HOME') {
    const rel = node.children[1];
    return path.join(home, rel && rel.kind === 'string' ? stringContent(rel.text) : '');
  }
  return null;
}

/**
 * Parses ASDF source-registry configuration text:
 *   (:source-registry (:tree "~/src/") (:directory (:home "lisp")) :inherit-configuration)
 */
export function parseSourceRegistry(text: string, home: string): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  const result = parse(text);
  const visit = (forms: Node[]) => {
    for (const form of forms) {
      if (!isList(form)) continue;
      const head = headName(form);
      if (head === 'SOURCE-REGISTRY') {
        visit(form.children.slice(1));
      } else if (head === 'TREE' || head === 'DIRECTORY') {
        const p = registryPath(form.children[1], home);
        if (p) out.push({ kind: head === 'TREE' ? 'tree' : 'directory', path: expandHome(p, home) });
      }
    }
  };
  visit(result.forms);
  return out;
}

/** Parses the CL_SOURCE_REGISTRY environment variable (paths, `//` suffix for trees, or a configuration form). */
export function parseSourceRegistryVariable(value: string, home: string): RegistryEntry[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('(')) return parseSourceRegistry(trimmed, home);
  const out: RegistryEntry[] = [];
  for (const piece of trimmed.split(path.delimiter)) {
    if (!piece) continue;
    if (piece.endsWith('//')) out.push({ kind: 'tree', path: expandHome(piece.slice(0, -2), home) });
    else out.push({ kind: 'directory', path: expandHome(piece.replace(/\/+$/, ''), home) });
  }
  return out;
}

function expandHome(p: string, home: string): string {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

function configurationEntries(configHome: string, home: string): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  const dir = path.join(configHome, 'common-lisp');
  const single = path.join(dir, 'source-registry.conf');
  const files: string[] = [];
  try {
    if (fs.statSync(single).isFile()) files.push(single);
  } catch {
    /* no single file */
  }
  const confd = path.join(dir, 'source-registry.conf.d');
  try {
    for (const name of fs.readdirSync(confd).sort()) {
      if (name.endsWith('.conf')) files.push(path.join(confd, name));
    }
  } catch {
    /* no conf.d */
  }
  for (const file of files) {
    try {
      out.push(...parseSourceRegistry(fs.readFileSync(file, 'utf8'), home));
    } catch {
      /* unreadable */
    }
  }
  return out;
}

function quicklispEntries(root: string): RegistryEntry[] {
  const out: RegistryEntry[] = [{ kind: 'tree', path: path.join(root, 'local-projects') }];
  for (const dist of listDirectories(path.join(root, 'dists'))) {
    out.push({ kind: 'tree', path: path.join(dist, 'software') });
  }
  return out;
}

/** Registry roots in priority order; only existing directories are returned. */
export function defaultRegistryRoots(workspaceFolders: string[], options: RegistryOptions = {}): RegistryEntry[] {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const entries: RegistryEntry[] = [];
  for (const folder of workspaceFolders) {
    entries.push({ kind: 'tree', path: path.join(folder, 'ocicl') });
    entries.push(...quicklispEntries(path.join(folder, '.qlot')));
    entries.push(...quicklispEntries(path.join(folder, 'quicklisp')));
  }
  for (const extra of options.extra ?? []) entries.push({ kind: 'tree', path: expandHome(extra, home) });
  if (env.CL_SOURCE_REGISTRY) entries.push(...parseSourceRegistryVariable(env.CL_SOURCE_REGISTRY, home));
  entries.push(...configurationEntries(env.XDG_CONFIG_HOME || path.join(home, '.config'), home));
  entries.push({ kind: 'tree', path: path.join(home, 'common-lisp') });
  entries.push({ kind: 'tree', path: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'common-lisp', 'source') });
  entries.push(...quicklispEntries(path.join(home, 'quicklisp')));
  entries.push({ kind: 'tree', path: path.join(home, '.roswell', 'local-projects') });
  entries.push(...quicklispEntries(path.join(home, '.roswell', 'lisp', 'quicklisp')));
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}:${entry.path}`;
    if (seen.has(key) || !isDirectory(entry.path)) return false;
    seen.add(key);
    return true;
  });
}

/** System definitions listed in a project's ocicl.csv: `name, image, relative/path/to.asd`. */
export function ociclSystems(workspaceFolder: string): Map<string, string> {
  const out = new Map<string, string>();
  const csv = path.join(workspaceFolder, 'ocicl.csv');
  let text: string;
  try {
    text = fs.readFileSync(csv, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const columns = line.split(',').map((c) => c.trim());
    if (columns.length < 3 || !columns[0] || !columns[2]) continue;
    const asd = path.join(workspaceFolder, 'ocicl', columns[2]);
    if (!out.has(columns[0].toLowerCase())) out.set(columns[0].toLowerCase(), asd);
  }
  return out;
}

/** Maps lower-case primary system names to .asd paths; the first registry to provide a name wins. */
export async function discoverSystems(entries: RegistryEntry[], maxDirectories = 20000): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let budget = maxDirectories;
  const record = (dir: string, names: string[]) => {
    for (const name of names) {
      if (name.toLowerCase().endsWith('.asd')) {
        const system = name.slice(0, -4).toLowerCase();
        if (!found.has(system)) found.set(system, path.join(dir, name));
      }
    }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget-- <= 0) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    record(dir, dirents.filter((d) => d.isFile()).map((d) => d.name));
    if (depth === 0) return;
    for (const d of dirents) {
      if (!d.isDirectory() || SKIPPED_DIRECTORIES.has(d.name) || d.name.startsWith('.')) continue;
      await walk(path.join(dir, d.name), depth - 1);
    }
  };
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      try {
        record(entry.path, (await fs.promises.readdir(entry.path, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name));
      } catch {
        /* unreadable */
      }
    } else {
      await walk(entry.path, 3);
    }
  }
  return found;
}

/** Names in a :depends-on list: strings, symbols, (:version name "1.0"), (:feature expr name); (:require module) is skipped. */
export function dependencyNames(node: Node | undefined): string[] {
  if (!isList(node)) return [];
  const out: string[] = [];
  for (const item of node.children) {
    if (isList(item)) {
      const head = headName(item);
      if (head === 'VERSION') {
        const name = designatorName(item.children[1]);
        if (name) out.push(name.toLowerCase());
      } else if (head === 'FEATURE') {
        const name = designatorName(item.children[2]);
        if (name) out.push(name.toLowerCase());
      }
      continue;
    }
    const name = designatorName(item);
    if (name) out.push(name.toLowerCase());
  }
  return out;
}

/** The systems defined in .asd text with their dependencies (including :defsystem-depends-on). */
export function systemsInFile(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const form of parse(text).forms) {
    if (!isList(form) || headName(form) !== 'DEFSYSTEM') continue;
    const name = designatorName(form.children[1]);
    if (!name) continue;
    const deps: string[] = [];
    const children = form.children;
    for (let i = 2; i + 1 < children.length; i++) {
      const key = children[i];
      if (!isSymbol(key) || key.kind !== 'keyword') continue;
      if (key.name === 'DEPENDS-ON' || key.name === 'DEFSYSTEM-DEPENDS-ON') deps.push(...dependencyNames(children[i + 1]));
    }
    out.set(name.toLowerCase(), deps);
  }
  return out;
}

/**
 * Follows dependencies from `wanted` through the registry. Systems in
 * `provided` (defined in the workspace) and implementation modules are not
 * resolved; a name no registry knows is reported as missing.
 */
export async function resolveDependencies(
  wanted: Iterable<string>,
  provided: Set<string>,
  registry: Map<string, string>,
): Promise<ResolvedDependencies> {
  const systems = new Map<string, SystemRecord>();
  const missing: string[] = [];
  const visited = new Set<string>();
  const queue = [...wanted].map(primarySystemName);
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (provided.has(name) || isImplementationSystem(name)) continue;
    const asdPath = registry.get(name);
    if (!asdPath) {
      missing.push(name);
      continue;
    }
    let text = '';
    try {
      text = await fs.promises.readFile(asdPath, 'utf8');
    } catch {
      missing.push(name);
      continue;
    }
    const defined = systemsInFile(text);
    const dependsOn = [...new Set([...defined.values()].flat().map(primarySystemName))];
    systems.set(name, { name, asdPath, directory: path.dirname(asdPath), dependsOn });
    queue.push(...dependsOn);
  }
  return { systems: [...systems.values()], missing: missing.sort() };
}

/** Lisp source files under the systems' directories (deduplicated), up to `maxFiles`. */
export async function collectSystemFiles(systems: SystemRecord[], maxFiles: number): Promise<string[]> {
  const directories = [...new Set(systems.map((s) => s.directory))].sort();
  // A directory that contains another (rare) would be walked twice; drop nested ones.
  const roots = directories.filter((dir) => !directories.some((other) => other !== dir && dir.startsWith(other + path.sep)));
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= maxFiles) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(d.name) && !d.name.startsWith('.')) await walk(full);
      } else if (d.isFile() && LISP_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

/** The `.asd` files directly inside `dir`, sorted. */
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

/** A `moro.systems` entry as an existing path: absolute, `~`-prefixed, or relative to a workspace folder. */
export function resolveConfiguredPath(entry: string, folders: string[], home: string): string | null {
  const expanded = expandHome(entry.trim(), home);
  if (!expanded) return null;
  if (path.isAbsolute(expanded)) return fs.existsSync(expanded) ? expanded : null;
  for (const folder of folders) {
    const candidate = path.resolve(folder, expanded);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The systems named by the `moro.systems` setting: each entry is an `.asd`
 * file or a directory holding `.asd` files. Returns primary system name to
 * `.asd` path, first entry winning.
 */
export async function configuredSystems(entries: string[], folders: string[], home = os.homedir()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = resolveConfiguredPath(entry, folders, home);
    if (!resolved) continue;
    const files = isDirectory(resolved) ? asdFilesIn(resolved) : resolved.toLowerCase().endsWith('.asd') ? [resolved] : [];
    for (const asd of files) {
      let text: string;
      try {
        text = await fs.promises.readFile(asd, 'utf8');
      } catch {
        continue;
      }
      for (const name of systemsInFile(text).keys()) {
        const primary = primarySystemName(name);
        if (!out.has(primary)) out.set(primary, asd);
      }
    }
  }
  return out;
}
