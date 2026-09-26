import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionsBetween, bisect } from '../tools/drift-bisect.mjs';

test('versionsBetween: strictly after good, up to and including bad, stable only, numeric order', () => {
  const all = ['2.1.9', '2.1.10', '2.1.11', '2.1.12-beta.1', '2.1.13', '2.2.0', '2.1.8'];
  assert.deepEqual(versionsBetween(all, '2.1.9', '2.2.0'), ['2.1.10', '2.1.11', '2.1.13', '2.2.0']);
  assert.deepEqual(versionsBetween(all, '2.1.13', '2.1.13'), []);
  assert.deepEqual(versionsBetween(['2.1.10'], '2.1.9', '2.1.10'), ['2.1.10']);
});

test('bisect: finds the first bad version in log2 steps, never re-tests the known bad end', async () => {
  const candidates = ['1', '2', '3', '4', '5', '6', '7', '8']; // first bad: 6
  const tested = [];
  const { firstBad, steps } = await bisect(candidates, async (v) => { tested.push(v); return Number(v) < 6; });
  assert.equal(firstBad, '6');
  assert.ok(steps.length <= 3, `log2(8)=3, took ${steps.length}`);
  assert.ok(!tested.includes('8'), 'the known-bad endpoint is never spent on');
});

test('bisect: single candidate needs zero test runs; all-good-but-last converges on the last', async () => {
  const r1 = await bisect(['9'], async () => { throw new Error('must not be called'); });
  assert.equal(r1.firstBad, '9'); assert.equal(r1.steps.length, 0);
  const r2 = await bisect(['1', '2', '3'], async () => true);
  assert.equal(r2.firstBad, '3');
});
