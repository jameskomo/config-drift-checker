import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCase, noiseFor, baselineWarnings, loadHistory, resolveThresholds, caseMap } from '../tools/eval-classify.mjs';

// A case whose with-arm runs have the given scores; summary.score is the mean.
const kase = (dir, scores) => ({
  dir, name: dir,
  arms: { with: scores.map((score, i) => ({ runIndex: i, score, numTurns: 4, costUsd: 0.1, durationMs: 5000, isError: false, toolUses: [{ tool: 'Bash', input: '{}' }] })) },
  summary: { score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null },
});
const hist = (...runs) => runs.map((scores) => caseMap({ cases: [kase('a', scores)] }));
const TH = 0.15;

test('classifyCase: in-band drop with flake-shaped evidence is noisy; past the band is regressed', () => {
  const b = kase('a', [1, 1, 1]);
  const h = hist([1, 1], [0.5, 1]); // band: 1 − 0.5 = 0.5
  const noisy = classifyCase('a', b, kase('a', [1, 0.4, 0.4]), h, TH); // Δ −0.40, one run still reaches 1.00
  assert.equal(noisy.status, 'noisy');
  assert.equal(noisy.noise, 0.5);
  assert.equal(noisy.effThreshold, 0.5);
  const past = classifyCase('a', b, kase('a', [0.4, 0.4, 0.4]), h, TH); // Δ −0.60 > band
  assert.equal(past.status, 'regressed');
  assert.equal(past.escalated, null);
});

test('classifyCase: escalations — a consistent shift or a persisted drop is red despite the band', () => {
  const b = kase('a', [1, 1, 1]);
  const h = hist([1, 1], [0.5, 1]);
  const shift = classifyCase('a', b, kase('a', [0.8, 0.8, 0.8]), h, TH); // in band, but no run reaches 1.00
  assert.equal(shift.status, 'regressed');
  assert.match(shift.escalated, /consistent shift/);
  const persisted = classifyCase('a', b, kase('a', [1, 0.4, 0.4]), hist([0.7, 0.8], [0.5, 1]), TH); // last two runs were already down
  assert.equal(persisted.status, 'regressed');
  assert.match(persisted.escalated, /persisted/);
});

test('classifyCase: stable / improved / unknown; no history → flat threshold', () => {
  const b = kase('a', [1, 1, 1]);
  assert.equal(classifyCase('a', b, kase('a', [1, 1, 0.9]), null, TH).status, 'stable');
  assert.equal(classifyCase('a', kase('a', [0.7, 0.7, 0.7]), kase('a', [1, 1, 1]), null, TH).status, 'improved');
  assert.equal(classifyCase('a', b, kase('a', []), null, TH).status, 'unknown');
  const flat = classifyCase('a', b, kase('a', [1, 0.4, 0.4]), null, TH);
  assert.equal(flat.status, 'regressed', 'no history → the flat threshold decides');
  assert.equal(flat.noise, null);
  assert.equal(flat.effThreshold, TH);
});

test('noiseFor / baselineWarnings: band needs 2 samples; thin and unstable baselines', () => {
  assert.deepEqual(noiseFor('a', kase('a', [1, 1, 1]), null, TH), { noise: null, effTh: TH });
  assert.deepEqual(noiseFor('a', kase('a', [1, 1, 1]), [], TH).noise, 0, 'identical scores → zero band');
  assert.deepEqual(baselineWarnings(kase('a', [1, 0.4]), 3, TH), ['thin baseline (n=2)', 'unstable baseline (±0.60)']);
  assert.deepEqual(baselineWarnings(kase('a', [1, 1, 1]), 3, TH), []);
});

test('loadHistory: newest first, track filter, exclude, before, limit, unreadable skipped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cls-hist-'));
  const w = async (name, obj) => fs.writeFile(path.join(dir, name), JSON.stringify(obj));
  const res = (track, at, tag) => ({ track, generatedAt: at, suite: { name: tag }, cases: [] });
  await w('20260901T000000Z-pinned.json', res('pinned', '2026-09-01T00:00:00Z', 'old'));
  await w('20260902T000000Z-pinned.json', res('pinned', '2026-09-02T00:00:00Z', 'mid'));
  await w('20260903T000000Z-canary.json', res('canary', '2026-09-03T00:00:00Z', 'canary'));
  await w('20260903T120000Z-pinned.json', res('pinned', '2026-09-03T12:00:00Z', 'new'));
  await fs.writeFile(path.join(dir, '20260903T130000Z-broken.json'), 'not json{');

  const all = await loadHistory(dir, { track: 'pinned' });
  assert.deepEqual(all.map((j) => j.suite.name), ['new', 'mid', 'old'], 'newest first, canary + broken skipped');
  const excl = await loadHistory(dir, { exclude: path.join(dir, '20260903T120000Z-pinned.json'), track: 'pinned' });
  assert.deepEqual(excl.map((j) => j.suite.name), ['mid', 'old']);
  const before = await loadHistory(dir, { track: 'pinned', before: '2026-09-03T00:00:00Z' });
  assert.deepEqual(before.map((j) => j.suite.name), ['mid', 'old'], 'only runs older than the current one');
  assert.equal((await loadHistory(dir, { track: 'pinned', limit: 1 })).length, 1);
});

test('resolveThresholds: flag > .cdc.yml > default', async () => {
  const d = resolveThresholds(null, 'pinned', {});
  assert.equal(d.th.score, 0.15); assert.equal(d.minBaselineRuns, 3); assert.equal(d.historyRuns, 10);
  assert.deepEqual([...d.failOn], ['score']);
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'cls-cfg-'));
  await fs.writeFile(path.join(plugin, '.cdc.yml'), 'thresholds:\n  score: 0.5\nnoise:\n  history_runs: 4\nbaseline:\n  min_runs: 2\n');
  const c = resolveThresholds(plugin, 'pinned', {});
  assert.equal(c.th.score, 0.5); assert.equal(c.historyRuns, 4); assert.equal(c.minBaselineRuns, 2);
  assert.equal(resolveThresholds(plugin, 'pinned', { threshold: 0.2 }).th.score, 0.2, 'flag wins');
});

test('normalizeResult: native claude plugin eval JSON maps to the 1.1 shape; 1.1 passes through', async () => {
  const { normalizeResult } = await import('../tools/eval-classify.mjs');
  const native = {
    schemaVersion: 1, claudeVersion: '2.1.269', startedAt: '2026-09-12T04:34:42.171Z', costUsd: 0.14,
    suite: { root: '/x/komo-stack', ablation: 'none' },
    aggregates: { casesTotal: 1, casesPassed: 1, overallScore: 1, overallPassRate: 1 },
    cases: [{
      name: 'Spring work triggers the conventions skill', dir: 'evals/spring-work-triggers-skill',
      aggregates: { score: 1, passRate: 1 }, runsPerCase: 1, maxTurns: 6,
      graders: [{ name: 'skill-fired', type: 'tool_used' }],
      arms: { with: [{ score: 1, passed: true, turns: 3, costUsd: 0.14, durationSeconds: 16, startedAt: '2026-09-12T04:34:42.171Z', error: null, tracePath: '/tmp/gone/trace.jsonl', graders: [{ name: 'skill-fired', passed: true, scored: true }] }] },
    }],
  };
  const n = normalizeResult(native);
  assert.equal(n.schemaVersion, '1.1');
  assert.equal(n.source, 'claude-plugin-eval');
  assert.equal(n.harness.version, '2.1.269');
  const c = n.cases[0];
  assert.equal(c.dir, 'spring-work-triggers-skill', 'evals/ prefix stripped so keys match shim results');
  assert.equal(c.summary.score, 1);
  const r = c.arms.with[0];
  assert.equal(r.numTurns, 3); assert.equal(r.durationMs, 16000); assert.equal(r.isError, false);
  assert.equal(r.toolUses, null, 'unknown, not zero — the trace is gone');
  assert.equal(r.response, null);
  assert.equal(n.aggregates.totalRuns, 1); assert.equal(n.aggregates.erroredRuns, 0);
  const ours = { schemaVersion: '1.1', track: 'pinned', cases: [] };
  assert.equal(normalizeResult(ours), ours, '1.1 results pass through untouched');
});
