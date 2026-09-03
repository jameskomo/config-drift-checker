import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/baseline-check.mjs', import.meta.url).pathname;

// Builds an aggregate result with the given per-case scored with-arm run counts.
function result({ cases, erroredRuns = 0 }) {
  return {
    track: 'pinned',
    cases: Object.entries(cases).map(([dir, n]) => ({ dir, name: dir, arms: { with: Array.from({ length: n }, (_, i) => ({ runIndex: i, score: 1, isError: false })) } })),
    aggregates: { erroredRuns, totalRuns: Object.values(cases).reduce((a, b) => a + b, 0) },
  };
}
async function run(resultObj, args = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blcheck-'));
  const f = path.join(dir, 'aggregate-result.json');
  await fs.writeFile(f, JSON.stringify(resultObj));
  return spawnSync('node', [TOOL, f, ...args], { encoding: 'utf8' });
}

test('passes when every case has ≥ min_runs scored runs and nothing errored', async () => {
  const r = await run(result({ cases: { a: 3, b: 4 } }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /baseline-check: ok/);
});

test('exit 1 with a per-case message when a case is under min_runs', async () => {
  const r = await run(result({ cases: { a: 3, b: 2 } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not baseline material/);
  assert.match(r.stderr, /b: 2 scored with-arm run\(s\), baseline\.min_runs is 3/);
  assert.doesNotMatch(r.stderr, /a: /);
});

test('exit 1 when any run errored, even with enough runs', async () => {
  const r = await run(result({ cases: { a: 3 }, erroredRuns: 1 }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 of 3 agent runs errored/);
});

test('--min-runs overrides .cdc.yml, which overrides the default', async () => {
  const twoRuns = result({ cases: { a: 2 } });
  assert.equal((await run(twoRuns)).status, 1, 'default min_runs is 3');
  assert.equal((await run(twoRuns, ['--min-runs', '2'])).status, 0, 'flag wins');
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'blcheck-cfg-'));
  await fs.writeFile(path.join(plugin, '.cdc.yml'), 'baseline:\n  min_runs: 1\n');
  assert.equal((await run(twoRuns, ['--config', plugin])).status, 0, 'config value applies');
  assert.equal((await run(twoRuns, ['--config', plugin, '--min-runs', '3'])).status, 1, 'flag beats config');
});
