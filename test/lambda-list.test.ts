import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeParameter, parseLambdaList } from '../src/server/lambda-list';

test('parses parameters with sections and offsets', () => {
  const parsed = parseLambdaList('(a &optional (b 1) &rest r &key c ((:dee d) 2))');
  assert.deepEqual(
    parsed.parameters.map((p) => `${p.section}:${p.label}${p.keyword ? `=${p.keyword}` : ''}`),
    ['required:a', 'optional:(b 1)', 'rest:r', 'key:c=C', 'key:((:dee d) 2)=DEE'],
  );
  assert.equal(parsed.text.slice(parsed.parameters[1].start, parsed.parameters[1].end), '(b 1)');
});

test('active parameter follows argument position', () => {
  const { parameters } = parseLambdaList('(a b &optional c &rest more)');
  assert.equal(activeParameter(parameters, 0, null), 0);
  assert.equal(activeParameter(parameters, 1, null), 1);
  assert.equal(activeParameter(parameters, 2, null), 2);
  assert.equal(activeParameter(parameters, 3, null), 3);
  assert.equal(activeParameter(parameters, 9, null), 3);
});

test('keyword arguments highlight the matching key', () => {
  const { parameters } = parseLambdaList('(seq &key test (key nil) from-end)');
  assert.equal(activeParameter(parameters, 1, null), null);
  assert.equal(activeParameter(parameters, 2, 'KEY'), 2);
  assert.equal(activeParameter(parameters, 4, 'FROM-END'), 3);
  assert.equal(activeParameter(parameters, 4, 'UNKNOWN'), null);
});

test('no parameters left', () => {
  const { parameters } = parseLambdaList('(a)');
  assert.equal(activeParameter(parameters, 1, null), null);
  assert.equal(parseLambdaList('garbage').parameters.length, 0);
});
