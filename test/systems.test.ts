import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectSystemFiles,
  configuredSystems,
  defaultRegistryRoots,
  dependencyNames,
  discoverSystems,
  isImplementationSystem,
  ociclSystems,
  parseSourceRegistry,
  parseSourceRegistryVariable,
  primarySystemName,
  resolveDependencies,
  systemsInFile,
} from '../src/server/systems';
import { WorkspaceIndex } from '../src/server/workspace';
import { parse } from '../src/common/reader';
import { analyze } from '../src/server/analysis';

let root: string;
let workspace: string;
let home: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-systems-'));
  workspace = path.join(root, 'app');
  home = path.join(root, 'home');
  // The project: one system depending on libone (ocicl, project-local) and libtwo (Quicklisp in $HOME).
  write(path.join(workspace, 'app.asd'), '(defsystem "app" :depends-on ("libone" (:version "libtwo" "1.0") "uiop" "nowhere") :components ((:file "main")))\n(defsystem "app/tests" :depends-on ("app" "libthree"))\n');
  write(path.join(workspace, 'main.lisp'), '(in-package #:app)\n(ql:quickload :libfour)\n(defun app-main () (libone:lib-fn 1))\n');
  write(path.join(workspace, 'ocicl.csv'), 'libone, ghcr.io/ocicl/libone@sha256:abc, libone-20260101-abcdef/libone.asd\n');
  write(path.join(workspace, 'ocicl', 'libone-20260101-abcdef', 'libone.asd'), '(defsystem "libone" :depends-on ("libthree") :components ((:file "libone")))\n');
  write(path.join(workspace, 'ocicl', 'libone-20260101-abcdef', 'libone.lisp'), '(defpackage #:libone (:use #:cl) (:export #:lib-fn))\n(in-package #:libone)\n(defun lib-fn (x)\n  "Library function."\n  (internal x))\n(defun internal (x) x)\n');
  write(path.join(workspace, 'ocicl', 'libthree-20260101-abcdef', 'libthree.asd'), '(defsystem "libthree")\n');
  write(path.join(workspace, 'ocicl', 'libthree-20260101-abcdef', 'three.lisp'), '(defpackage #:libthree (:export #:three))\n(in-package #:libthree)\n(defun three () 3)\n');
  // Quicklisp-style registry under $HOME.
  write(path.join(home, 'quicklisp', 'dists', 'quicklisp', 'software', 'libtwo-20260101-git', 'libtwo.asd'), '(defsystem "libtwo" :depends-on (#:libfour))\n');
  write(path.join(home, 'quicklisp', 'dists', 'quicklisp', 'software', 'libtwo-20260101-git', 'src', 'two.lisp'), '(defpackage #:libtwo (:export #:two))\n(in-package #:libtwo)\n(defun two () 2)\n');
  write(path.join(home, 'quicklisp', 'local-projects', 'libfour', 'libfour.asd'), '(defsystem "libfour")\n');
  write(path.join(home, 'quicklisp', 'local-projects', 'libfour', 'four.lisp'), '(defpackage #:libfour (:export #:four))\n(in-package #:libfour)\n(defun four () 4)\n');
  write(path.join(home, '.config', 'common-lisp', 'source-registry.conf.d', '10-mine.conf'), '(:tree (:home "src/lisp/"))\n(:directory "/nonexistent/dir")\n');
  fs.mkdirSync(path.join(home, 'src', 'lisp'), { recursive: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('system names and dependency lists', () => {
  assert.equal(primarySystemName('App/Tests'), 'app');
  assert.ok(isImplementationSystem('sb-posix'));
  assert.ok(isImplementationSystem('uiop'));
  assert.ok(!isImplementationSystem('alexandria'));
  const list = parse('("a" :b c (:version "d" "1.0") (:feature :sbcl "e") (:require :sb-x))').forms[0];
  assert.deepEqual(dependencyNames(list), ['a', 'b', 'c', 'd', 'e']);
  const systems = systemsInFile('(defsystem "x" :depends-on ("y") :defsystem-depends-on ("z"))\n(asdf:defsystem #:x/tests :depends-on (:x))');
  assert.deepEqual([...systems.entries()], [['x', ['y', 'z']], ['x/tests', ['x']]]);
});

test('analysis records system dependencies and quickload requests', () => {
  const analysis = analyze(parse('(defsystem "app" :depends-on ("a" (:version "b" "1")))\n(ql:quickload \'(:c "d"))\n(asdf:load-system :e)\n(load-system "f")\n(asdf:oos \'asdf:load-op :g)\n(something:quickload :no)'));
  assert.deepEqual(analysis.definitions[0].dependsOn, ['a', 'b']);
  assert.deepEqual(analysis.requestedSystems, ['c', 'd', 'e', 'f', 'g']);
});

test('source-registry configuration and environment variable', () => {
  const entries = parseSourceRegistry('(:source-registry (:tree "~/lisp/") (:directory (:home "cl")) :inherit-configuration)', '/h');
  assert.deepEqual(entries, [
    { kind: 'tree', path: path.join('/h', 'lisp/') },
    { kind: 'directory', path: path.join('/h', 'cl') },
  ]);
  assert.deepEqual(parseSourceRegistryVariable(`/a//${path.delimiter}/b/`, '/h'), [
    { kind: 'tree', path: '/a' },
    { kind: 'directory', path: '/b' },
  ]);
  assert.deepEqual(parseSourceRegistryVariable('(:source-registry (:tree "/t"))', '/h'), [{ kind: 'tree', path: '/t' }]);
});

test('registry roots come from the workspace, settings, configuration and home', () => {
  const roots = defaultRegistryRoots([workspace], { home, env: {}, extra: [path.join(root, 'nope'), path.join(home, 'quicklisp', 'local-projects')] });
  const paths = roots.map((r) => path.relative(root, r.path).split(path.sep).join('/'));
  assert.deepEqual(paths, [
    'app/ocicl',
    'home/quicklisp/local-projects', // from `extra`, before the standard registries
    'home/src/lisp',
    'home/quicklisp/dists/quicklisp/software',
  ]);
});

test('ocicl.csv and registry discovery', async () => {
  const ocicl = ociclSystems(workspace);
  assert.equal(ocicl.get('libone'), path.join(workspace, 'ocicl', 'libone-20260101-abcdef', 'libone.asd'));
  const found = await discoverSystems(defaultRegistryRoots([workspace], { home, env: {} }));
  assert.equal(path.basename(found.get('libthree')!), 'libthree.asd');
  assert.equal(path.basename(found.get('libtwo')!), 'libtwo.asd');
  assert.equal(path.basename(found.get('libfour')!), 'libfour.asd');
  assert.equal(found.get('nowhere'), undefined);
});

test('transitive resolution, missing systems and file collection', async () => {
  const registry = new Map(ociclSystems(workspace));
  for (const [name, asd] of await discoverSystems(defaultRegistryRoots([workspace], { home, env: {} }))) {
    if (!registry.has(name)) registry.set(name, asd);
  }
  const resolved = await resolveDependencies(['libone', 'libtwo', 'uiop', 'nowhere', 'sb-posix'], new Set(['app']), registry);
  assert.deepEqual(resolved.systems.map((s) => s.name).sort(), ['libfour', 'libone', 'libthree', 'libtwo']);
  assert.deepEqual(resolved.missing, ['nowhere']);
  const files = await collectSystemFiles(resolved.systems, 100);
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), ['four.lisp', 'libfour.asd', 'libone.asd', 'libone.lisp', 'libthree.asd', 'libtwo.asd', 'three.lisp', 'two.lisp']);
  assert.equal((await collectSystemFiles(resolved.systems, 3)).length, 3);
});

test('WorkspaceIndex.scanDependencies indexes only what the workspace uses, as dependencies', async () => {
  const index = new WorkspaceIndex();
  index.dependencySettings = { enabled: true, registries: [], maxFiles: 4000 };
  index.settings = { exclude: ['**/ocicl/**'], maxFiles: 100 };
  await index.scanFolders([workspace], () => {});
  assert.ok(index.files.has(pathToFileURL(path.join(workspace, 'main.lisp')).toString()));
  assert.ok(!index.files.has(pathToFileURL(path.join(workspace, 'ocicl', 'libone-20260101-abcdef', 'libone.lisp')).toString()), 'ocicl is left to the dependency scan');

  // Point $HOME at the fixture by resolving registries through the settings path.
  index.dependencySettings = { enabled: true, registries: [path.join(home, 'quicklisp', 'dists', 'quicklisp', 'software'), path.join(home, 'quicklisp', 'local-projects')], maxFiles: 4000 };
  const count = await index.scanDependencies([workspace], () => {});
  assert.equal(count, 8);
  const libone = pathToFileURL(path.join(workspace, 'ocicl', 'libone-20260101-abcdef', 'libone.lisp')).toString();
  assert.equal(index.files.get(libone)?.source, 'dependency');
  assert.ok(index.isDependency(libone));
  assert.deepEqual([...index.dependencySystems.keys()].sort(), ['libfour', 'libone', 'libthree', 'libtwo']);
  assert.deepEqual(index.missingSystems, ['nowhere']);
  assert.deepEqual([...index.dependencyExports()].sort(), ['FOUR', 'LIB-FN', 'THREE', 'TWO']);
  assert.equal(index.findDefinitions('LIB-FN').length, 1);
  assert.equal(index.findDefinitions('INTERNAL').length, 1, 'internal definitions are indexed too (hover, definition)');

  // An editor opening a dependency file keeps it a dependency.
  index.update(libone, '(in-package #:libone)\n(defun lib-fn (x) x)\n', { fromDisk: false });
  assert.equal(index.files.get(libone)?.source, 'dependency');
  index.dependencySettings.enabled = false;
  assert.equal(await index.scanDependencies([workspace], () => {}), 0);
});

test('configuredSystems: .asd files and directories, absolute or relative to a workspace folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-configured-'));
  try {
    const lib = path.join(dir, 'lib');
    const other = path.join(dir, 'other');
    const songs = path.join(dir, 'songs');
    for (const d of [lib, other, songs]) fs.mkdirSync(d);
    write(path.join(lib, 'lib.asd'), '(defsystem "lib" :components ((:file "lib")))\n(defsystem "lib/tests" :depends-on ("lib"))\n');
    write(path.join(other, 'alpha.asd'), '(defsystem "alpha")\n');
    write(path.join(other, 'beta.asd'), '(defsystem "beta")\n');
    write(path.join(other, 'notes.txt'), 'not a system\n');
    const found = await configuredSystems([path.join(lib, 'lib.asd'), '../other', 'missing.asd', '  '], [songs], dir);
    assert.deepEqual(
      [...found.entries()].sort(),
      [
        ['alpha', path.join(other, 'alpha.asd')],
        ['beta', path.join(other, 'beta.asd')],
        ['lib', path.join(lib, 'lib.asd')],
      ],
      'primary names only, the secondary system folds into lib',
    );
    assert.deepEqual([...(await configuredSystems(['~/lib/lib.asd'], [songs], dir)).keys()], ['lib'], '~ expands to the home directory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceIndex.scanDependencies indexes the systems listed in moro.systems even when nothing in the workspace asks for them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-songs-'));
  try {
    const lib = path.join(dir, 'lib');
    const songs = path.join(dir, 'songs');
    fs.mkdirSync(lib);
    fs.mkdirSync(songs);
    write(path.join(lib, 'lib.asd'), '(defsystem "lib" :components ((:file "lib")))\n');
    write(path.join(lib, 'lib.lisp'), '(defpackage #:lib (:use #:cl) (:export #:play))\n(in-package #:lib)\n(defun play (x) "Play X." x)\n');
    write(path.join(songs, 'song.lisp'), '(in-package #:lib)\n(play 1)\n');
    const index = new WorkspaceIndex();
    index.settings = { exclude: [], maxFiles: 100 };
    index.dependencySettings = { enabled: true, registries: [], maxFiles: 4000, systems: ['../lib/lib.asd'] };
    await index.scanFolders([songs], () => {});
    const count = await index.scanDependencies([songs], () => {});
    assert.equal(count, 2, 'the .asd and the source file of the configured system');
    const libLisp = pathToFileURL(path.join(lib, 'lib.lisp')).toString();
    assert.equal(index.files.get(libLisp)?.source, 'dependency');
    assert.ok(index.dependencySystems.has('lib'));
    assert.deepEqual(index.missingSystems, []);
    assert.equal(index.files.get(pathToFileURL(path.join(songs, 'song.lisp')).toString())?.source, 'workspace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
