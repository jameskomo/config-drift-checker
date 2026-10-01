import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/result-health.mjs', import.meta.url).pathname;
const kv = (s) => Object.fromEntries(s.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
async function write(obj) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'health-'));
  const f = path.join(d, 'r.json');
  await fs.writeFile(f, JSON.stringify(obj));
  return f;
}
const native = (cases) => ({ schemaVersion: 1, suite: { root: '/x' }, claudeVersion: '2.1.287', aggregates: { casesTotal: cases.length }, cases });
const run = (over = {}) => ({ score: 1, turns: 3, error: null, graders: [], ...over });

test('official runner that refused every run (no sandbox) is unusable, with the reason', async () => {
  const refused = run({ score: 0, turns: 0, error: 'exit 1: A shell tool (Bash or PowerShell) was granted but this machine cannot confine it' });
  const f = await write(native([{ dir: 'evals/a', arms: { with: [refused, refused] } }]));
  const r = kv(spawnSync('node', [TOOL, f], { encoding: 'utf8' }).stdout);
  assert.equal(r.usable, 'false');
  assert.match(r.reason, /every run errored: 2 of 2 agent runs errored: exit 1: A shell tool/);
  assert.equal(r.errored, '2'); assert.equal(r.total, '2');
});

test('official runner that rejected some cases (stricter schema) is unusable against the suite size', async () => {
  const f = await write(native([{ dir: 'evals/a', arms: { with: [run()] } }]));
  const r = kv(spawnSync('node', [TOOL, f, '--expect-cases', '6'], { encoding: 'utf8' }).stdout);
  assert.equal(r.usable, 'false');
  assert.match(r.reason, /only 1 of 6 cases loaded/);
});

test('a healthy result, and a missing file, are reported plainly', async () => {
  const ok = kv(spawnSync('node', [TOOL, await write(native([{ dir: 'evals/a', arms: { with: [run()] } }])), '--expect-cases', '1'], { encoding: 'utf8' }).stdout);
  assert.equal(ok.usable, 'true'); assert.equal(ok.reason, '');
  const none = kv(spawnSync('node', [TOOL, '/nope/r.json'], { encoding: 'utf8' }).stdout);
  assert.equal(none.usable, 'false'); assert.equal(none.reason, 'no result file');
});

test('normalizeResult gives native results an errored count and a partialReason (no more "undefined" headline)', async () => {
  const { normalizeResult } = await import('../tools/eval-classify.mjs');
  const n = normalizeResult(native([{ dir: 'evals/a', arms: { with: [run({ error: 'boom' }), run()] } }]));
  assert.equal(n.aggregates.erroredRuns, 1);
  assert.match(n.aggregates.partialReason, /1 of 2 agent runs errored: boom/);
});
