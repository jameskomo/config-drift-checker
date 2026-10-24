import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wilson, bootstrapMean, spread, runsNeeded, caseStats, runPassed, fmtRange, fmtPass, shortLine } from '../tools/eval-stats.mjs';
import { renderReport } from '../tools/eval-report.mjs';
import { setRuns, runsOf } from '../tools/runs-needed.mjs';

const DIFF = new URL('../tools/eval-diff.mjs', import.meta.url).pathname;
const RUNS = new URL('../tools/runs-needed.mjs', import.meta.url).pathname;
const r2 = (x) => Math.round(x * 100) / 100;

const kase = (dir, scores) => ({
  dir, name: dir,
  arms: { with: scores.map((score, i) => ({ runIndex: i, score, numTurns: 4, costUsd: 0.1, durationMs: 5000, model: 'm1', isError: false, graders: [] })) },
  summary: { score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null },
});
const result = (cases, at) => ({
  schemaVersion: '1.1', track: 'pinned', generatedAt: at, suite: { name: 'fixture' }, harness: { name: 'claude-code', version: '2.1.200' },
  cases: Object.entries(cases).map(([dir, scores]) => kase(dir, scores)),
  aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: 6, costUsd: 0.6 },
});

test('Wilson range: honest at small n and at all-pass', () => {
  const two = wilson(2, 3);
  assert.deepEqual([r2(two.low), r2(two.high)], [0.21, 0.94]);
  const all = wilson(3, 3);
  assert.deepEqual([r2(all.low), r2(all.high)], [0.44, 1], '3 of 3 still leaves real doubt');
  assert.equal(wilson(0, 0), null);
});

test('bootstrap mean range: seeded, so the same runs always print the same range; needs 3 runs', () => {
  assert.deepEqual(bootstrapMean([1, 0.5, 1]), bootstrapMean([1, 0.5, 1]));
  const r = bootstrapMean([1, 0.5, 1]);
  assert.ok(r.low >= 0.5 && r.high <= 1 && r.low < r.high);
  assert.equal(bootstrapMean([1, 0.5]), null);
  assert.equal(fmtRange(0.8333, r), `0.83 (${r.low.toFixed(2)} to ${r.high.toFixed(2)})`);
  assert.equal(fmtRange(1, null), '1.00 (a range needs 3+ runs)');
});

test('spread pools within each result; single-run results fall back to all scores', () => {
  assert.equal(r2(spread([[1, 0.8, 1], [1, 0.85, 1]]).sd), 0.1);
  assert.equal(spread([[1, 0.8, 1], [1, 0.85, 1]]).pooled, true);
  const across = spread([[1], [0.8], [1]]);
  assert.equal(across.pooled, false); assert.equal(r2(across.sd), 0.12);
  assert.equal(spread([[1]]).sd, null);
});

test('runs needed: normal approximation, floored at the baseline minimum, capped at 20', () => {
  assert.equal(runsNeeded(spread([[1, 0.8, 1], [1, 0.85, 1]]).sd, 0.15).needed, 6);
  assert.equal(runsNeeded(0.115, 0.15).needed, 8);
  assert.deepEqual(runsNeeded(0, 0.15), { needed: 3, raw: 0, capped: false });
  assert.deepEqual(runsNeeded(0.577, 0.15), { needed: 20, raw: 183, capped: true }, 'a coin-flip case cannot see a 0.15 drop');
  assert.equal(runsNeeded(null, 0.15), null);
  assert.equal(shortLine('spring-service', { current: 3, needed: 7, raw: 7, capped: false }, 0.15), "spring-service: 3 runs can't tell a 0.15 drop from noise; this case needs 7");
});

test('runPassed: the native passed flag wins, else a perfect score', () => {
  assert.equal(runPassed({ passed: false, score: 1 }), false);
  assert.equal(runPassed({ score: 1 }), true);
  assert.equal(runPassed({ score: 0.9 }), false);
  assert.equal(runPassed({ score: null }), null);
  const s = caseStats(kase('a', [1, 0.5, 1]), [kase('a', [1, 0.5, 1])], { drop: 0.15 });
  assert.equal(fmtPass(s.pass), '2 of 3 (0.21 to 0.94)');
  assert.equal(s.runsNeeded.short, true);
});

async function diff(base, cur, hist) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stats-diff-'));
  const h = path.join(dir, 'history'); await fs.mkdir(h);
  for (const [i, x] of hist.entries()) await fs.writeFile(path.join(h, `2026090${i}T000000Z-shim-pinned.json`), JSON.stringify(x));
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify(base)); await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(cur));
  const r = spawnSync('node', [DIFF, path.join(dir, 'b.json'), path.join(dir, 'c.json'), '--history', h, '--json', path.join(dir, 'o.json')], { encoding: 'utf8' });
  return { status: r.status, md: r.stdout, json: JSON.parse(await fs.readFile(path.join(dir, 'o.json'), 'utf8')) };
}

test('eval-diff: ranges and runs needed are shown, the verdict is unchanged', async () => {
  const hist = [result({ flaky: [1, 0.8, 1], steady: [1, 1, 1] }, '2026-09-01T00:00:00Z'), result({ flaky: [1, 0.85, 1], steady: [1, 1, 1] }, '2026-09-02T00:00:00Z')];
  const base = result({ flaky: [1, 1, 1], steady: [1, 1, 1] }, '2026-09-03T00:00:00Z');
  const cur = result({ flaky: [1, 0.8, 1], steady: [1, 1, 1] }, '2026-09-04T00:00:00Z');
  const { status, md, json } = await diff(base, cur, hist);
  assert.equal(status, 0);
  assert.equal(json.rows.find((r) => r.case === 'flaky').status, 'stable', 'stats never move a verdict');
  assert.match(md, /\*\*How sure are these scores\?\*\*/);
  assert.match(md, /\| flaky \| 0\.93 \(0\.\d\d to 1\.00\) \| 2 of 3 \(0\.21 to 0\.94\) \| \d+ \(has 3\) ⚠ \|/);
  assert.match(md, /\| steady \| 1\.00 \(1\.00 to 1\.00\) \| 3 of 3 \(0\.44 to 1\.00\) \| 3 \|/);
  assert.match(md, /95% range: where the true value most likely sits/);
  assert.match(md, /_`flaky`: 3 runs can't tell a 0\.15 drop from noise; this case needs \d+_/);
  const rn = json.runsNeeded.find((r) => r.case === 'flaky');
  assert.equal(rn.short, true); assert.equal(rn.current, 3); assert.ok(rn.needed > 3 && rn.needed <= 20);
  assert.equal(rn.samples, 12, 'two history results, baseline and current, each counted once');
  assert.equal(json.runsNeeded.find((r) => r.case === 'steady').short, false);
});

test('eval-report: a 95% range column with a plain-words tooltip, passing runs in the case header', () => {
  const base = result({ a: [1, 1, 1] }, '2026-09-03T00:00:00Z');
  const cur = result({ a: [1, 0.5, 1] }, '2026-09-04T00:00:00Z');
  const html = renderReport(cur, base, { history: [] });
  assert.match(html, /<th title="95% range: where the true value most likely sits[^"]*">95% range<\/th>/);
  assert.match(html, /<td class="num ci" title="[^"]*">0\.50 to 1\.00<\/td>/);
  assert.match(html, /· passed 2 of 3 \(0\.21 to 0\.94\)/);
  assert.match(html, /too few runs to trust a green:<\/b> a: 3 runs can&#39;t|too few runs to trust a green:<\/b> a: 3 runs can't/);
  const thin = renderReport(result({ a: [1] }, '2026-09-04T00:00:00Z'), null, {});
  assert.match(thin, /<small>needs 3\+ runs<\/small>/);
});

test('runs-needed: frontmatter edits keep everything else', () => {
  const src = '---\ndescription: "x"\ntags: [a]\nruns: 3\nmax_turns: 6\n---\nDo the thing.\n';
  assert.equal(setRuns(src, 7), src.replace('runs: 3', 'runs: 7'));
  assert.equal(runsOf(setRuns(src, 7)), 7);
  assert.equal(setRuns('---\ntags: [a]\n---\nbody\n', 5), '---\ntags: [a]\nruns: 5\n---\nbody\n');
  assert.equal(setRuns('body\n', 4), '---\nruns: 4\n---\nbody\n');
  assert.equal(runsOf('---\ntags: [a]\n---\nruns: 9\n'), null, 'a runs: line in the body is not frontmatter');
});

test('runs-needed CLI: dry by default, --write raises runs: in prompt.md, a track runs: is called out', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-needed-'));
  const plugin = path.join(root, 'plugin'), hist = path.join(root, 'history');
  await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
  for (const c of ['flaky', 'steady']) { await fs.mkdir(path.join(plugin, 'evals', c), { recursive: true }); await fs.writeFile(path.join(plugin, 'evals', c, 'prompt.md'), '---\ntags: [x]\nruns: 3\n---\nDo it.\n'); }
  await fs.mkdir(hist);
  const hs = [[1, 0.8, 1], [1, 0.85, 1], [1, 0.8, 1]];
  for (const [i, s] of hs.entries()) await fs.writeFile(path.join(hist, `2026090${i}T000000Z.json`), JSON.stringify(result({ flaky: s, steady: [1, 1, 1] }, `2026-09-0${i + 1}T00:00:00Z`)));
  const dry = spawnSync('node', [RUNS, hist, '--config', plugin, '--json', path.join(root, 'o.json')], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /flaky\s+3\s+0\.11\s+9\s+7\s+too few/);
  assert.match(dry.stdout, /steady\s+3\s+0\.00\s+9\s+3\s+enough/);
  assert.match(dry.stdout, /flaky: 3 runs can't tell a 0\.15 drop from noise; this case needs 7/);
  assert.match(dry.stdout, /dry run: nothing written/);
  assert.match(await fs.readFile(path.join(plugin, 'evals/flaky/prompt.md'), 'utf8'), /^runs: 3$/m, 'dry run leaves files alone');
  const j = JSON.parse(await fs.readFile(path.join(root, 'o.json'), 'utf8'));
  assert.equal(j.rows.find((r) => r.case === 'flaky').needed, 7);
  const wet = spawnSync('node', [RUNS, hist, '--config', plugin, '--write'], { encoding: 'utf8' });
  assert.match(wet.stdout, /wrote flaky runs: 3 to 7/);
  assert.equal(await fs.readFile(path.join(plugin, 'evals/flaky/prompt.md'), 'utf8'), '---\ntags: [x]\nruns: 7\n---\nDo it.\n');
  assert.match(await fs.readFile(path.join(plugin, 'evals/steady/prompt.md'), 'utf8'), /^runs: 3$/m, 'never lowers');
  await fs.writeFile(path.join(plugin, '.cdc.yml'), 'canary:\n  runs: 1\n');
  const canary = spawnSync('node', [RUNS, hist, '--config', plugin, '--track', 'canary'], { encoding: 'utf8' });
  assert.match(canary.stdout, /\.cdc\.yml sets runs: 1 on the canary track, which overrides every prompt\.md/);
  const bad = spawnSync('node', [RUNS, hist], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
