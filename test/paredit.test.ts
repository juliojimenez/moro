import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, barfForward, raiseForm, slurpForward, spliceForm, wrapParens, topLevelRange, EditResult } from '../src/client/paredit';

/** Runs an operation on text containing a `|` cursor marker and returns the new text with the cursor marker re-inserted. */
function run(src: string, op: (text: string, offset: number) => EditResult | null): string | null {
  const offset = src.indexOf('|');
  const text = src.replace('|', '');
  const result = op(text, offset);
  if (!result) return null;
  const out = applyEdits(text, result.edits);
  return out.slice(0, result.cursor) + '|' + out.slice(result.cursor);
}

test('slurp forward', () => {
  assert.equal(run('(a b|) c d', slurpForward), '(a b| c) d');
  assert.equal(run('(foo (bar |baz) quux)', slurpForward), '(foo (bar |baz quux))');
  assert.equal(run('(a |b)', slurpForward), null, 'nothing to slurp');
  assert.equal(run('(a (|b) "str")', slurpForward), '(a (|b "str"))');
});

test('barf forward', () => {
  assert.equal(run('(a |b c)', barfForward), '(a |b) c');
  assert.equal(run('(a b |c)', barfForward), '(a b|) c');
  assert.equal(run('(|a)', barfForward), '(|) a');
  assert.equal(run('(|)', barfForward), null);
});

test('splice', () => {
  assert.equal(run('(a (b |c) d)', spliceForm), '(a b |c d)');
  assert.equal(run("'(a |b)", spliceForm), 'a |b');
  assert.equal(run('(a |b', spliceForm), 'a |b', 'unclosed lists can still be spliced');
  assert.equal(run('a |b', spliceForm), null);
});

test('raise', () => {
  assert.equal(run('(foo (bar |x) baz)', raiseForm), '(foo |x baz)');
  assert.equal(run('(foo (b|ar x) baz)', raiseForm), '(foo b|ar baz)');
  assert.equal(run('(foo (bar | x) baz)', raiseForm), '(foo |x baz)', 'whitespace picks the next form');
  assert.equal(run('(f (g |(h 1)))', raiseForm), '(f |(h 1))');
  assert.equal(run('|top', raiseForm), null);
});

test('wrap', () => {
  const wrapAtCursor = (text: string, offset: number) => wrapParens(text, offset, offset);
  assert.equal(run('(a |b c)', wrapAtCursor), '(a (|b) c)');
  assert.equal(run('(a |(b) c)', wrapAtCursor), '(a (|(b)) c)');
  assert.equal(run('(a | )', wrapAtCursor), '(a (|) )');
  const text = '(a b c)';
  const result = wrapParens(text, 3, 6);
  assert.equal(applyEdits(text, result.edits), '(a (b c))');
  assert.equal(result.cursor, 4);
});

test('top-level range', () => {
  const text = '(a)\n(b (c))\n';
  assert.deepEqual(topLevelRange(text, 6), [4, 11]);
  assert.deepEqual(topLevelRange(text, 3), [0, 3]);
});
