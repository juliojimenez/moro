import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allStandard, hyperspecUrl, isCallable, isOperator, lookupStandard, primaryDoc } from '../src/server/symbols';

test('the database covers the whole COMMON-LISP package', () => {
  assert.equal(allStandard().length, 978);
  assert.ok(allStandard().every((s) => s.clhs), 'every symbol has a HyperSpec page');
  assert.ok(allStandard().every((s) => s.doc && Object.keys(s.doc).length > 0), 'every symbol has documentation');
});

test('lookups are case-insensitive and carry arglists', () => {
  const mapcar = lookupStandard('MAPCAR')!;
  assert.equal(mapcar.name, 'mapcar');
  assert.equal(mapcar.arglist, '(function list &rest more-lists)');
  assert.ok(isCallable(mapcar));
  assert.ok(!isOperator(mapcar));
  assert.equal(hyperspecUrl(mapcar, 'http://www.lispworks.com/documentation/HyperSpec/Body/'), 'http://www.lispworks.com/documentation/HyperSpec/Body/f_mapc_.htm');
  assert.equal(hyperspecUrl(mapcar, 'http://host/Body'), 'http://host/Body/f_mapc_.htm');
});

test('kinds distinguish operators, variables, constants and types', () => {
  assert.deepEqual(lookupStandard('if')!.kinds, ['special-operator']);
  assert.ok(isOperator(lookupStandard('defun')!));
  assert.deepEqual(lookupStandard('*print-base*')!.kinds, ['variable']);
  assert.deepEqual(lookupStandard('pi')!.kinds, ['constant']);
  assert.ok(lookupStandard('list')!.kinds.includes('class'));
  assert.ok(lookupStandard('&optional')!.kinds.includes('lambda-list-keyword'));
  assert.ok(lookupStandard('optimize')!.kinds.includes('declaration'));
  assert.equal(lookupStandard('no-such-symbol'), undefined);
});

test('primaryDoc prefers the function documentation', () => {
  assert.match(primaryDoc(lookupStandard('car')!)!, /1st object/);
  assert.match(primaryDoc(lookupStandard('cond')!)!, /TEST-FORM/);
});
