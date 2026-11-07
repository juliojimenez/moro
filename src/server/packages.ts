/**
 * Which package a symbol belongs to. Built from the defpackage /
 * define-package forms in the index: a symbol written in package P names
 * P's own symbol unless P imports it from, or inherits it (through :use) from,
 * a package that exports it. Occurrences and definitions are matched by that
 * home package, so `app::run` and `other::run` are different symbols, while
 * files whose package has no definition in the index (scratch files in
 * CL-USER) stay lenient and match by name alone.
 */
import type { Definition, Occurrence } from './analysis';
import { lookupStandard } from './symbols';

export interface PackageInfo {
  name: string;
  nicknames: string[];
  uses: string[];
  exports: Set<string>;
  shadows: Set<string>;
  imports: Map<string, string>;
  localNicknames: Map<string, string>;
  reexports: string[];
}

/** A symbol occurrence with the context needed to find its home. */
export interface SymbolRef {
  name: string;
  /** Explicit package prefix (normalized), 'KEYWORD' for keywords, null when bare. */
  pkg: string | null;
  keyword: boolean;
  uninterned: boolean;
  role?: Occurrence['role'];
  source?: string;
  /** The current package at the occurrence (closest preceding in-package), or null. */
  context: string | null;
}

export interface ResolvedSymbol {
  name: string;
  keyword: boolean;
  /** Home package name, 'KEYWORD' for keywords. */
  home: string;
  /** False when the home is a guess (unknown package, uninterned name): then matching falls back to the name. */
  strict: boolean;
  /** Package designators are not symbol references at all. */
  excluded: boolean;
}

const CL_NAMES = new Set(['CL', 'COMMON-LISP']);
const CL_USER_NAMES = new Set(['CL-USER', 'COMMON-LISP-USER']);

export class PackageModel {
  private readonly packages = new Map<string, PackageInfo>();
  private readonly nicknames = new Map<string, string>();
  private readonly exportCache = new Map<string, Set<string>>();

  constructor(definitions: Iterable<Definition>) {
    for (const def of definitions) {
      if (def.kind !== 'package' || this.packages.has(def.name)) continue;
      const options = def.packageOptions;
      const info: PackageInfo = {
        name: def.name,
        nicknames: options?.nicknames ?? [],
        uses: options?.uses ?? [],
        exports: new Set(def.exports ?? []),
        shadows: new Set(options?.shadows ?? []),
        imports: new Map(options?.imports ?? []),
        localNicknames: new Map(options?.localNicknames ?? []),
        reexports: options?.reexports ?? [],
      };
      this.packages.set(def.name, info);
    }
    for (const info of this.packages.values()) {
      for (const nickname of info.nicknames) {
        if (!this.packages.has(nickname) && !this.nicknames.has(nickname)) this.nicknames.set(nickname, info.name);
      }
    }
  }

  /** True when the index has a definition for the package (after nickname resolution). */
  has(name: string | null): boolean {
    return name !== null && this.packages.has(this.canonical(name, null));
  }

  get(name: string): PackageInfo | undefined {
    return this.packages.get(this.canonical(name, null));
  }

  /** The package a designator means from inside `context`: local nicknames, then nicknames, then the name itself. */
  canonical(name: string, context: string | null): string {
    if (CL_NAMES.has(name)) return 'COMMON-LISP';
    if (CL_USER_NAMES.has(name)) return 'COMMON-LISP-USER';
    if (context) {
      const local = this.packages.get(this.canonicalGlobal(context))?.localNicknames.get(name);
      if (local) return this.canonicalGlobal(local);
    }
    return this.canonicalGlobal(name);
  }

  private canonicalGlobal(name: string): string {
    if (CL_NAMES.has(name)) return 'COMMON-LISP';
    if (CL_USER_NAMES.has(name)) return 'COMMON-LISP-USER';
    return this.packages.has(name) ? name : (this.nicknames.get(name) ?? name);
  }

  /** The external symbols of a package, including what it re-exports. */
  exportsOf(name: string, seen = new Set<string>()): Set<string> {
    const canonical = this.canonicalGlobal(name);
    const cached = this.exportCache.get(canonical);
    if (cached) return cached;
    const info = this.packages.get(canonical);
    const out = new Set<string>(info?.exports ?? []);
    if (info && !seen.has(canonical)) {
      seen.add(canonical);
      for (const reexported of info.reexports) {
        for (const exported of this.exportsOf(reexported, seen)) out.add(exported);
      }
    }
    this.exportCache.set(canonical, out);
    return out;
  }

  /** The home package of the symbol `name` as seen from package `pkg`. */
  homeOf(name: string, pkg: string, seen = new Set<string>()): string {
    const canonical = this.canonicalGlobal(pkg);
    if (canonical === 'COMMON-LISP') return 'COMMON-LISP';
    if (canonical === 'KEYWORD') return 'KEYWORD';
    const info = this.packages.get(canonical);
    const standard = lookupStandard(name) !== undefined;
    if (!info) return standard ? 'COMMON-LISP' : canonical; // unknown packages are assumed to use CL
    if (seen.has(canonical)) return canonical;
    seen.add(canonical);
    if (info.shadows.has(name)) return canonical;
    const imported = info.imports.get(name);
    if (imported) return this.homeOf(name, this.canonical(imported, canonical), seen);
    for (const used of info.uses) {
      const usedName = this.canonical(used, canonical);
      if (usedName === 'COMMON-LISP') {
        if (standard) return 'COMMON-LISP';
        continue;
      }
      if (this.exportsOf(usedName).has(name)) return this.homeOf(name, usedName, seen);
    }
    return canonical;
  }

  /** Resolves one occurrence to its home package. */
  resolve(ref: SymbolRef): ResolvedSymbol {
    const base = { name: ref.name, keyword: ref.keyword, excluded: false };
    if (ref.keyword) return { ...base, home: 'KEYWORD', strict: true };
    if (ref.role === 'package') return { ...base, home: ref.name, strict: true, excluded: true };
    if ((ref.role === 'export' || ref.role === 'import') && ref.source) {
      return { ...base, home: this.homeOf(ref.name, this.canonical(ref.source, ref.context)), strict: true };
    }
    if (ref.pkg) {
      return { ...base, home: this.homeOf(ref.name, this.canonical(ref.pkg, ref.context)), strict: true };
    }
    if (ref.uninterned) return { ...base, home: ref.name, strict: false };
    const context = ref.context ?? 'COMMON-LISP-USER';
    const home = this.homeOf(ref.name, context);
    return { ...base, home, strict: this.has(context) || home === 'COMMON-LISP' };
  }
}

/** True when two resolved occurrences denote the same symbol. */
export function sameSymbol(a: ResolvedSymbol, b: ResolvedSymbol): boolean {
  if (a.excluded || b.excluded || a.keyword !== b.keyword || a.name !== b.name) return false;
  if (a.strict && b.strict) return a.home === b.home;
  return true; // one side does not know its package: match by name
}
