import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceIndex } from '../src/server/workspace';
import { PackageModel } from '../src/server/packages';
import { symbolAt } from '../src/common/reader';

/** An index over named files; `at(file, needle, extra)` resolves the symbol at that text. */
function build(files: Record<string, string>) {
  const index = new WorkspaceIndex();
  for (const [name, text] of Object.entries(files)) index.update(`file:///${name}`, text, { fromDisk: true, source: 'workspace' });
  const at = (name: string, needle: string, extra = 0) => {
    const file = index.get(`file:///${name}`)!;
    const offset = file.parse.text.indexOf(needle) + extra;
    assert.ok(offset >= extra, `${needle} in ${name}`);
    const symbol = symbolAt(file.parse, offset);
    assert.ok(symbol, `symbol at ${needle}`);
    return { file, symbol, resolved: index.resolveSymbol(file, symbol) };
  };
  const refs = (name: string, needle: string, extra = 0) =>
    index.occurrencesOf(at(name, needle, extra).resolved).map((f) => `${f.file.uri.slice(8)}:${f.occurrence.start}`);
  const defs = (name: string, needle: string, extra = 0) => index.definitionsFor(at(name, needle, extra).resolved).map((f) => `${f.file.uri.slice(8)}:${f.def.pkg}`);
  return { index, at, refs, defs };
}

test('the same name in two packages is two symbols', () => {
  const { at, refs, defs } = build({
    'app.lisp': '(defpackage #:app (:use #:cl) (:export #:run))\n(in-package #:app)\n(defun run () (helper))\n(defun helper () (run))\n',
    'other.lisp': '(defpackage #:other (:use #:cl))\n(in-package #:other)\n(defun run () :mine)\n(run)\n(app:run)\n(app::helper)\n',
  });
  assert.equal(at('app.lisp', '(defun run', 7).resolved.home, 'APP');
  assert.equal(at('other.lisp', '(defun run', 7).resolved.home, 'OTHER');
  assert.equal(refs('app.lisp', '(defun run', 7).length, 4, 'export, defun, call in helper, app:run from other');
  assert.equal(refs('other.lisp', '(defun run', 7).length, 2, 'defun and the bare call in other');
  assert.deepEqual(defs('other.lisp', '(app:run)', 5), ['app.lisp:APP']);
  assert.deepEqual(defs('other.lisp', '(run)', 1), ['other.lisp:OTHER']);
  assert.deepEqual(defs('other.lisp', '(app::helper)', 6), ['app.lisp:APP']);
});

test('files without a known package are lenient', () => {
  const { refs, at } = build({
    'app.lisp': '(defpackage #:app (:use #:cl) (:export #:run))\n(in-package #:app)\n(defun run () 1)\n',
    'scratch.lisp': '(run)\n(app:run)\n',
    'other.lisp': '(defpackage #:other (:use #:cl))\n(in-package #:other)\n(run)\n',
  });
  assert.equal(at('scratch.lisp', '(run)', 1).resolved.strict, false);
  const found = refs('app.lisp', '(defun run', 7);
  assert.ok(found.some((r) => r.startsWith('scratch.lisp')), 'the bare call in CL-USER matches by name');
  assert.ok(!found.some((r) => r.startsWith('other.lisp')), 'the call in a known other package does not');
  assert.equal(found.length, 4, 'export, defun, two in scratch');
});

test('nicknames, local nicknames, :use and :import-from resolve to the home package', () => {
  const { refs, defs, index } = build({
    'base.lisp': '(defpackage #:my.base (:use #:cl) (:nicknames #:base) (:export #:helper #:thing))\n(in-package #:my.base)\n(defun helper () 1)\n(defun thing () 2)\n',
    'user.lisp': '(defpackage #:user (:use #:cl #:my.base) (:local-nicknames (#:b #:my.base)))\n(in-package #:user)\n(helper)\n(b:thing)\n(base:thing)\n',
    'importer.lisp': '(defpackage #:importer (:use #:cl) (:import-from #:my.base #:helper) (:shadow #:thing))\n(in-package #:importer)\n(helper)\n(defun thing () :own)\n(thing)\n',
  });
  assert.equal(refs('base.lisp', '(defun helper', 7).length, 5, 'export, defun, inherited call, :import-from entry, imported call');
  assert.equal(refs('base.lisp', '(defun thing', 7).length, 4, 'export, defun, b:thing, base:thing; not the shadowed one');
  assert.deepEqual(defs('user.lisp', '(b:thing)', 3), ['base.lisp:MY.BASE']);
  assert.deepEqual(defs('importer.lisp', '(thing)', 1), ['importer.lisp:IMPORTER'], "a shadowed symbol is the package's own");
  const model = index.packageModel();
  assert.equal(model.canonical('BASE', null), 'MY.BASE');
  assert.equal(model.canonical('B', 'USER'), 'MY.BASE');
  assert.equal(model.canonical('B', null), 'B', 'a local nickname only means something inside its package');
  assert.equal(model.homeOf('MAPCAR', 'USER'), 'COMMON-LISP');
  assert.equal(model.homeOf('NOT-STANDARD', 'UNKNOWN-PKG'), 'UNKNOWN-PKG');
  assert.deepEqual([...index.symbolsInPackage('B', 'USER').keys()].sort(), ['HELPER', 'THING']);
});

test('package designators are not symbol references and cannot be renamed', () => {
  const { at, refs } = build({
    'app.lisp': '(defpackage #:cl-user-ish (:use #:cl) (:export #:cl))\n(in-package #:cl-user-ish)\n(defun cl () 1)\n',
    'b.lisp': '(defpackage #:b (:use #:cl) (:import-from #:cl-user-ish #:cl))\n(in-package #:b)\n',
  });
  assert.equal(at('app.lisp', '(:use #:cl)', 8).resolved.excluded, true);
  assert.equal(at('app.lisp', '(in-package #:cl-user-ish)', 14).resolved.excluded, true);
  const found = refs('app.lisp', '(defun cl', 7);
  assert.equal(found.length, 3, 'export entry, defun, the :import-from name; never the (:use #:cl) designator');
});

test('standard symbols have COMMON-LISP as home everywhere', () => {
  const { at } = build({
    'a.lisp': '(defpackage #:a (:use #:cl))\n(in-package #:a)\n(mapcar #\'print nil)\n',
    'scratch.lisp': '(mapcar #\'print nil)\n',
  });
  assert.equal(at('a.lisp', 'mapcar').resolved.home, 'COMMON-LISP');
  assert.equal(at('scratch.lisp', 'mapcar').resolved.home, 'COMMON-LISP');
  assert.equal(at('scratch.lisp', 'mapcar').resolved.strict, true);
});

test('re-exports are exports too', () => {
  const model = new PackageModel([
    { name: 'INNER', label: 'inner', kind: 'package', range: [0, 0], nameRange: [0, 0], pkg: null, exports: ['X'] },
    { name: 'OUTER', label: 'outer', kind: 'package', range: [0, 0], nameRange: [0, 0], pkg: null, exports: ['Y'], packageOptions: { nicknames: [], uses: ['INNER'], shadows: [], imports: [], localNicknames: [], reexports: ['INNER'] } },
    { name: 'CLIENT', label: 'client', kind: 'package', range: [0, 0], nameRange: [0, 0], pkg: null, exports: [], packageOptions: { nicknames: [], uses: ['OUTER'], shadows: [], imports: [], localNicknames: [], reexports: [] } },
  ]);
  assert.deepEqual([...model.exportsOf('OUTER')].sort(), ['X', 'Y']);
  assert.equal(model.homeOf('X', 'CLIENT'), 'INNER');
  assert.equal(model.homeOf('Y', 'CLIENT'), 'OUTER');
  assert.equal(model.homeOf('Z', 'CLIENT'), 'CLIENT');
});
