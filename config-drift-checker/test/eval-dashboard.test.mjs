import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/eval-dashboard.mjs', import.meta.url).pathname;

const kase = (dir, scores) => ({
  dir, name: dir,
  arms: { with: scores.map((score, i) => ({ runIndex: i, score, numTurns: 4, costUsd: 0.1, durationMs: 5000, model: 'm1', isError: false, toolUses: [{ tool: 'Bash', input: '{}' }], graders: [] })) },
  summary: { score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null },
});
const result = (cases, { at, cc, track = 'pinned' }) => ({
  schemaVersion: '1.1', track, shim: true, generatedAt: at, suite: { name: 'fixture' },
  harness: { name: 'claude-code', version: cc },
  cases: Object.entries(cases).map(([dir, scores]) => kase(dir, scores)),
  aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: 9, costUsd: 0.9, resolvedModels: ['m1'] },
});

const LONG = 'spring-controller-follows-conventions-and-more';

// 20 pinned runs over distinct Claude Code versions. Case LONG sits at 1.00 throughout; case b has a
// flaky baseline (runs [1,1,0.7] → band 0.3) and drops to 0.73 in the last run → noisy, not regressed.
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (let i = 0; i < 20; i++) {
    const cc = `2.1.${240 + i}`;
    const last = i === 19;
    const r = result({ [LONG]: [1, 1, 1], b: last ? [1, 0.6, 0.6] : [1, 1, 1] }, { at: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`, cc });
    await fs.writeFile(path.join(hist, `202608${String(i + 1).padStart(2, '0')}T100000Z-cc${cc}-shim-pinned.json`), JSON.stringify(r));
  }
  const base = path.join(dir, 'baseline.json');
  await fs.writeFile(base, JSON.stringify(result({ [LONG]: [1, 1, 1], b: [1, 1, 0.7] }, { at: '2026-07-01T10:00:00Z', cc: '2.1.230' })));
  const out = path.join(dir, 'index.html');
  const r = spawnSync('node', [TOOL, hist, '--baseline', base, '--out', out, '--title', 'fixture'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFile(out, 'utf8');
}

test('dashboard: a drop inside the noise band is amber noisy, never red', async () => {
  const html = await fixture();
  assert.match(html, /noisy — within the historical band/);
  assert.match(html, /class="cell noisy /, 'ribbon cell is amber');
  assert.doesNotMatch(html, /class="cell regressed /);
  assert.match(html, /<tr class="st-noisy">/, 'runs table row is noisy');
  assert.doesNotMatch(html, /<tr class="st-regressed">/);
  assert.match(html, /<td class="num case noisy">0\.73<\/td>/);
});

test('dashboard: x-axis labels are thinned, never overlapping; the last version stays', async () => {
  const html = await fixture();
  const shown = [...html.matchAll(/<text x="([\d.]+)" y="[^"]*" class="tick" text-anchor="(?:middle|end)">(2\.1\.\d+)<\/text>/g)];
  assert.equal(shown.length, 10, 'greedy 56px thinning keeps 9 even labels + the swapped-in last');
  const xs = shown.map((m) => Number(m[1]));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 56, `labels ${i - 1} and ${i} are ${xs[i] - xs[i - 1]}px apart`);
  assert.equal(shown.at(-1)[2], '2.1.259', 'the newest version is always labelled');
  assert.ok(!shown.some((m) => m[2] === '2.1.258'), 'its colliding predecessor is dropped');
  assert.match(html, /text-anchor="end">2\.1\.259</, 'the last label is end-anchored so it cannot clip the chart edge');
});

test('dashboard: legend wraps below the chart with full case names', async () => {
  const html = await fixture();
  const legend = html.match(/<div class="legend">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(legend.includes(LONG), 'full name, not truncated');
  assert.doesNotMatch(legend, /…/);
  assert.doesNotMatch(html, /class="lbl"/, 'no clipped right-edge labels any more');
});
