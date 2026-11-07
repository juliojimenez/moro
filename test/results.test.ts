import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelText, formSummary, inlineText } from '../src/client/results';

test('inline text', () => {
  assert.equal(inlineText({ ok: true, values: ['42'], output: '', backtrace: [] }), '42');
  assert.equal(inlineText({ ok: true, values: ['1', '"two"'], output: '', backtrace: [] }), '1, "two"');
  assert.equal(inlineText({ ok: true, values: [], output: '', backtrace: [] }), '; no values');
  assert.equal(inlineText({ ok: false, values: [], output: '', error: 'boom', backtrace: [] }), 'error: boom');
  const long = inlineText({ ok: true, values: ['x'.repeat(200)], output: '', backtrace: [] });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(inlineText({ ok: true, values: ['(a\n   b)'], output: '', backtrace: [] }), '(a b)');
});

test('channel text', () => {
  assert.equal(channelText('(+ 1 2)', { ok: true, values: ['3'], output: '', backtrace: [] }), ';; (+ 1 2)\n=> 3\n');
  assert.equal(
    channelText('(progn\n  (print 1)\n  (values))', { ok: true, values: [], output: '\n1 \n', backtrace: [] }),
    ';; (progn\n\n1 \n=> ; no values\n',
  );
  assert.equal(
    channelText('(f)', { ok: false, values: [], output: '', error: 'bad', backtrace: ['(F)', '(G)'] }),
    ';; (f)\n;; error: bad\n;;   (F)\n;;   (G)\n',
  );
  assert.equal(formSummary('x'.repeat(100)), `${'x'.repeat(71)}…`);
});
