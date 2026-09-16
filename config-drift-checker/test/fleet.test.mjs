import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFleetConfig, collectFleet, skew, renderFleetMd, renderFleetHtml } from '../tools/fleet.mjs';

const TOOL = new URL('../tools/fleet.mjs', import.meta.url).pathname;
const month = new Date().toISOString().slice(0, 7);

async function fixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-'));
  const put = async (repo, file, obj) => {
    await fs.mkdir(path.join(root, repo.replace('/', '__')), { recursive: true });
    await fs.writeFile(path.join(root, repo.replace('/', '__'), file), JSON.stringify(obj));
  };
  await put('org/green', 'latest.json', { track: 'pinned', generatedAt: '2026-09-16T10:00:00Z', aggregates: { overallScore: 1, erroredRuns: 0 } });
  await put('org/green', 'baseline.json', { config: { model: 'claude-sonnet-5', modelIsPinned: true, harness: '2.1.258' } });
  await put('org/green', 'spend.json', { months: { [month]: { usd: 2.5, runs: 4 } } });
  await put('org/green', 'coverage.json', { pct: 100 });
  await put('org/skewed', 'latest.json', { track: 'canary', generatedAt: '2026-09-15T10:00:00Z', aggregates: { overallScore: 0.9, erroredRuns: 0 } });
  await put('org/skewed', 'baseline.json', { config: { model: 'claude-opus-5', modelIsPinned: true, harness: '2.1.100' } });
  // org/dark has published nothing
  return root;
}

test('parseFleetConfig: repos list and policy', () => {
  const c = parseFleetConfig('policy:\n  model: claude-sonnet-5\n  harness: "2.1.258"\nrepos:\n  - org/a\n  - org/b-two\n');
  assert.deepEqual(c.repos, ['org/a', 'org/b-two']);
  assert.equal(c.policy.model, 'claude-sonnet-5');
  assert.equal(c.policy.harness, '2.1.258');
});

test('collectFleet + skew: green, skewed and missing repos each classified', async () => {
  const root = await fixtures();
  const load = async (repo, file) => { try { return JSON.parse(await fs.readFile(path.join(root, repo.replace('/', '__'), file), 'utf8')); } catch { return null; } };
  const rows = await collectFleet(['org/green', 'org/skewed', 'org/dark'], load);
  const policy = { model: 'claude-sonnet-5', harness: '2.1.258' };
  assert.equal(rows[0].status, 'green'); assert.deepEqual(skew(rows[0], policy), []);
  assert.equal(rows[0].spentMonth, 2.5); assert.equal(rows[0].coveragePct, 100);
  assert.equal(rows[1].status, 'below 1.00');
  assert.deepEqual(skew(rows[1], policy), ['model claude-opus-5', 'Claude Code 2.1.100']);
  assert.equal(rows[2].status, 'no data');
  const md = renderFleetMd(rows, policy);
  assert.match(md, /3 repos · 1 green · 1 off the pin policy/);
  assert.match(md, /⚠ model claude-opus-5, Claude Code 2\.1\.100/);
  const html = renderFleetHtml(rows, policy);
  assert.match(html, /1 errored \/ no data/); assert.match(html, /org\/skewed/);
});

test('CLI: --from-dir renders, exits 1 when a repo has no data', async () => {
  const root = await fixtures();
  const out = path.join(root, 'fleet.html');
  const r = spawnSync('node', [TOOL, '--repos', 'org/green,org/dark', '--from-dir', root, '--out', out, '--policy-model', 'claude-sonnet-5'], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'no-data repo turns the exit red');
  assert.match(r.stdout, /org\/dark \| no data/);
  assert.match(await fs.readFile(out, 'utf8'), /agent-config fleet/);
  const r2 = spawnSync('node', [TOOL, '--repos', 'org/green', '--from-dir', root], { encoding: 'utf8' });
  assert.equal(r2.status, 0);
});
