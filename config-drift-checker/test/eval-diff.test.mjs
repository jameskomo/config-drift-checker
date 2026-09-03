import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIFF = new URL('../tools/eval-diff.mjs', import.meta.url).pathname;

// Builds a report with the given per-case with-arm runs: [{score, numTurns, costUsd, durationMs, model}]
function report({ cases, harness = '2.1.200', track = 'pinned', extra = {} }) {
  return {
    schemaVersion: '1.1', track, harness: { name: 'claude-code', version: harness }, generatedAt: '2026-09-02T00:00:00Z', suite: { name: 'fixture' },
    cases: Object.entries(cases).map(([dir, runs]) => ({
      dir, name: dir,
      arms: { with: runs.map((r, i) => ({ runIndex: i, score: r.score ?? 1, numTurns: r.numTurns ?? 4, costUsd: r.costUsd ?? 0.1, durationMs: r.durationMs ?? 5000, model: r.model ?? 'claude-sonnet-5', isError: !!r.isError, toolUses: r.toolUses, response: r.response, graders: r.graders ?? [] })) },
      summary: { score: (() => { const s = runs.filter((r) => !r.isError).map((r) => r.score ?? 1); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; })(), delta: runs[0]?.delta },
    })),
    aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: Object.values(cases).flat().length, costUsd: 0.3, ...extra },
  };
}
async function run(baseObj, curObj, args = [], histObjs = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-'));
  const b = path.join(dir, 'base.json'), c = path.join(dir, 'cur.json'), j = path.join(dir, 'out.json');
  await fs.writeFile(b, JSON.stringify(baseObj)); await fs.writeFile(c, JSON.stringify(curObj));
  if (histObjs.length) {
    const h = path.join(dir, 'history');
    await fs.mkdir(h);
    for (let i = 0; i < histObjs.length; i++) await fs.writeFile(path.join(h, `2026090${i}T000000Z-shim-pinned.json`), JSON.stringify(histObjs[i]));
    args = [...args, '--history', h];
  }
  const r = spawnSync('node', [DIFF, b, c, '--json', j, ...args], { encoding: 'utf8' });
  return { status: r.status, md: r.stdout, json: JSON.parse(await fs.readFile(j, 'utf8')), dir };
}
const three = (o = {}) => [o, o, o];

test('stable suite: exit 0, no drift, provenance in the header', async () => {
  const { status, md, json } = await run(report({ cases: { a: three(), b: three() } }), report({ cases: { a: three(), b: three() } }));
  assert.equal(status, 0);
  assert.match(md, /^## Agent-config eval: no regressions$/m);
  assert.match(md, /track \*\*pinned\*\* · model claude-sonnet-5 \(baseline claude-sonnet-5\) · Claude Code 2\.1\.200 · threshold 0\.15/);
  assert.equal(json.red, 0); assert.equal(json.flagged, 0); assert.deepEqual(json.moved, []);
});

test('score regression: exit 1, row marked, failing graders listed', async () => {
  const cur = report({ cases: { a: three({ score: 0, graders: [{ name: 'done', verdict: 'fail', scored: true }] }), b: three() } });
  const { status, md, json } = await run(report({ cases: { a: three(), b: three() } }), cur);
  assert.equal(status, 1);
  assert.match(md, /\*\*1 red \(1 regression\)\*\*/);
  assert.match(md, /\| 🔴 \| a \| 1\.00 \| 0\.00 \| -1\.00 \|.*\| done×3 \|/);
  assert.equal(json.rows.find((r) => r.case === 'a').status, 'regressed');
});

test('efficiency drift: turns doubled → warning only by default, red with --fail-on turns', async () => {
  const base = report({ cases: { a: three({ numTurns: 4 }) } });
  const cur = report({ cases: { a: three({ numTurns: 9 }) } });
  const warn = await run(base, cur);
  assert.equal(warn.status, 0);
  assert.match(warn.md, /no regressions · ⚠ 1 efficiency drift \(warning\)/);
  assert.match(warn.md, /\| ⚪ ⚠ \| a <sub>slower<\/sub> \| 1\.00 \| 1\.00 \| \+0\.00 \| — \| 4 → 9 \(\+125%\) \| \$0\.10 \|/);
  assert.deepEqual(warn.json.rows[0].flags, ['slower']);
  const red = await run(base, cur, ['--fail-on', 'score,turns']);
  assert.equal(red.status, 1);
  assert.match(red.md, /\*\*1 red \(0 regressions, 1 efficiency drift\)\*\*/);
  const loose = await run(base, cur, ['--turns-threshold', '2']);
  assert.equal(loose.json.flagged, 0, 'a looser threshold clears it');
});

test('cost drift uses the median of non-errored runs and shows dollars', async () => {
  const base = report({ cases: { a: three({ costUsd: 0.1 }) } });
  const cur = report({ cases: { a: [{ costUsd: 0.1 }, { costUsd: 0.5 }, { costUsd: 0.5 }, { costUsd: 9, isError: true }] } });
  const { md, json } = await run(base, cur);
  assert.deepEqual(json.rows[0].flags, ['pricier']);
  assert.match(md, /\$0\.10 → \$0\.50 \(\+400%\)/);
});

test('.cdc.yml via --config supplies thresholds and fail_on', async () => {
  const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-cfg-'));
  await fs.writeFile(path.join(plugin, '.cdc.yml'), 'thresholds:\n  score: 0.5\n  turns: 0.1\nfail_on: [score, turns]\n');
  const base = report({ cases: { a: three({ numTurns: 4, score: 1 }) } });
  const cur = report({ cases: { a: three({ numTurns: 5, score: 0.6 }) } });
  const { status, json } = await run(base, cur, ['--config', plugin]);
  assert.equal(json.thresholds.score, 0.5); assert.equal(json.thresholds.turns, 0.1);
  assert.equal(json.rows[0].status, 'stable', 'a 0.4 drop is inside the 0.5 threshold');
  assert.deepEqual(json.rows[0].flags, ['slower']);
  assert.equal(status, 1, 'turns is in fail_on');
});

test('model and harness moved are called out; ablation worth is surfaced', async () => {
  const base = report({ cases: { a: three({ model: 'claude-sonnet-5' }) }, harness: '2.1.100' });
  const cur = report({ cases: { a: three({ model: 'claude-sonnet-5-1', delta: 0.6 }) }, harness: '2.1.258' });
  const { md, json } = await run(base, cur);
  assert.match(md, /⚙ model moved: claude-sonnet-5 → claude-sonnet-5-1 · ⚙ Claude Code moved: 2\.1\.100 → 2\.1\.258/);
  assert.match(md, /Claude Code 2\.1\.258 \(baseline 2\.1\.100\)/);
  assert.match(md, /Setup worth \*\*\+0\.60\*\* on this suite/);
  assert.equal(json.worth, 0.6);
});

test('missing case is a regression; new case is not; budget-skipped case is unknown, not red', async () => {
  const base = report({ cases: { a: three(), gone: three() } });
  const cur = report({ cases: { a: three(), fresh: three(), skipped: [] }, extra: { budget: { capUsd: 2, spentUsd: 2.4, exceeded: true, skippedRuns: 3 } } });
  const { status, md, json } = await run(base, cur);
  assert.equal(status, 1);
  assert.equal(json.rows.find((r) => r.case === 'gone').status, 'missing');
  assert.equal(json.rows.find((r) => r.case === 'fresh').status, 'new');
  assert.equal(json.rows.find((r) => r.case === 'skipped').status, 'new', 'not in the baseline → new, never red');
  assert.match(md, /■ Budget cap \$2 reached after \$2\.40 — 3 planned run\(s\) not started/);
  const skippedKnown = await run(report({ cases: { a: three(), s: three() } }), report({ cases: { a: three(), s: [] } }));
  assert.equal(skippedKnown.status, 0);
  assert.equal(skippedKnown.json.rows.find((r) => r.case === 's').status, 'unknown');
});

test('all runs errored → exit 2 with the partial reason as the headline', async () => {
  const cur = report({ cases: { a: [{ isError: true }] }, extra: { erroredRuns: 1, totalRuns: 1, partialReason: '1 of 1 agent runs errored: Credit balance is too low' } });
  const { status, md } = await run(report({ cases: { a: three() } }), cur);
  assert.equal(status, 2);
  assert.match(md, /\*\*⚠ 1 of 1 agent runs errored: Credit balance is too low\*\*/);
});

test('noise: a flake-shaped drop inside the historical noise band is a ⚠ warning, never red', async () => {
  const base = report({ cases: { a: three() } });
  // Δ = −0.20 past the flat 0.15, but flake-shaped: two runs still reach the baseline score
  const cur = report({ cases: { a: [{ score: 1 }, { score: 0.4 }, { score: 1 }] } });
  const hist = [
    report({ cases: { a: [{ score: 0.5 }, { score: 1 }] } }),
    report({ cases: { a: three() } }),
    report({ cases: { a: [{ score: 0 }] }, track: 'canary' }), // other track: must not count
  ];
  const { status, md, json } = await run(base, cur, [], hist);
  assert.equal(status, 0);
  const row = json.rows.find((r) => r.case === 'a');
  assert.equal(row.status, 'noisy');
  assert.equal(row.noise, 0.5);            // 1 − 0.5 across baseline + pinned history runs
  assert.equal(row.effThreshold, 0.5);     // max(threshold, noise)
  assert.equal(row.historyRuns, 2, 'the canary file is filtered out');
  assert.equal(json.red, 0); assert.equal(json.regressed, 0);
  assert.match(md, /no regressions · ⚠ 1 noisy \(warning\)/);
  assert.match(md, /\| ⚠ \| a \| 1\.00 \| 0\.80 \| -0\.20 \| ±0\.50 \|/);
  assert.match(md, /_1 case dropped past 0\.15 but within historical noise \(±0\.50 over the last 2 runs\) — warning, not a regression_/);
});

test('noise: a quiet history keeps the same delta red', async () => {
  const base = report({ cases: { a: three() } });
  const cur = report({ cases: { a: three({ score: 0.8 }) } });
  const hist = [report({ cases: { a: three() } }), report({ cases: { a: three() } })];
  const { status, json } = await run(base, cur, [], hist);
  assert.equal(status, 1);
  const row = json.rows.find((r) => r.case === 'a');
  assert.equal(row.status, 'regressed');
  assert.equal(row.noise, 0); assert.equal(row.effThreshold, 0.15);
});

test('noise: without --history the flat threshold decides, as before', async () => {
  const base = report({ cases: { a: three() } });
  const cur = report({ cases: { a: three({ score: 0.8 }) } });
  const { status, md, json } = await run(base, cur);
  assert.equal(status, 1);
  const row = json.rows.find((r) => r.case === 'a');
  assert.equal(row.status, 'regressed');
  assert.equal(row.noise, null); assert.equal(row.effThreshold, 0.15); assert.equal(row.historyRuns, 0);
  assert.match(md, /\| 🔴 \| a \| 1\.00 \| 0\.80 \| -0\.20 \| — \|/);
});

test('baseline quality: thin and unstable baselines warn, never red', async () => {
  const runs = [{ score: 1 }, { score: 0.5 }]; // 2 runs (< min_runs 3) and spread 0.5
  const { status, md, json } = await run(report({ cases: { a: runs, b: three() } }), report({ cases: { a: runs, b: three() } }));
  assert.equal(status, 0);
  assert.deepEqual(json.rows.find((r) => r.case === 'a').warnings, ['thin baseline (n=2)', 'unstable baseline (±0.50)']);
  assert.deepEqual(json.rows.find((r) => r.case === 'b').warnings, []);
  assert.match(md, /\*\*⚠ baseline quality \(never red\):\*\* `a` — thin baseline \(n=2\), unstable baseline/);
});

test('noise guard: a uniform in-band drop (no run reaches baseline) is a consistent shift → red', async () => {
  const base = report({ cases: { a: three() } });
  const cur = report({ cases: { a: three({ score: 0.8 }) } }); // every run 0.8 — nothing reaches 1.0
  const hist = [report({ cases: { a: [{ score: 0.5 }, { score: 1 }] } })];
  const { status, md, json } = await run(base, cur, [], hist);
  assert.equal(status, 1);
  const row = json.rows.find((r) => r.case === 'a');
  assert.equal(row.status, 'regressed');
  assert.match(row.escalated, /consistent shift, not a flake/);
  assert.match(md, /within its ±0\.50 noise band but red anyway: no current run reached the baseline score/);
});

test('noise guard: a drop that persisted across the last two runs is no longer noise → red', async () => {
  const base = report({ cases: { a: three() } });
  const cur = report({ cases: { a: [{ score: 1 }, { score: 0.4 }, { score: 1 }] } }); // flake-shaped, would be noisy
  const hist = [
    report({ cases: { a: [{ score: 1 }, { score: 0.4 }] } }), // oldest: widens the band
    report({ cases: { a: three({ score: 0.8 }) } }),          // already down
    report({ cases: { a: three({ score: 0.8 }) } }),          // newest: still down
  ];
  const { status, md, json } = await run(base, cur, [], hist);
  assert.equal(status, 1);
  const row = json.rows.find((r) => r.case === 'a');
  assert.equal(row.status, 'regressed');
  assert.match(row.escalated, /persisted/);
  assert.match(md, /the drop persisted across the last runs/);
});

test('refusals: 1-turn no-tool low runs on a case whose baseline acts are flagged; a tool-less baseline is not', async () => {
  const acts = { toolUses: [{ tool: 'Bash', input: '{}' }] };
  const base = report({ cases: { a: three(acts), b: three() } }); // b's baseline never uses tools
  const refuse = { score: 0.25, numTurns: 1, toolUses: [] };
  const cur = report({ cases: { a: [refuse, refuse, refuse], b: [refuse, refuse, refuse] } });
  const { status, md, json } = await run(base, cur);
  assert.equal(status, 1); // both regressed
  assert.equal(json.rows.find((r) => r.case === 'a').refusedRuns, 3);
  assert.equal(json.rows.find((r) => r.case === 'b').refusedRuns, 0);
  assert.match(md, /`a`: 3 of 3 run\(s\) look like refusals \(≤1 turn, no tool use\)/);
  assert.doesNotMatch(md, /`b`: \d+ of \d+ run\(s\) look like refusals/);
});

test('baseline quality: a small judge-level spread (≤ threshold/2) does not warn', async () => {
  const runs = [{ score: 1 }, { score: 0.95 }, { score: 1 }]; // spread 0.05 < 0.075
  const { json } = await run(report({ cases: { a: runs } }), report({ cases: { a: runs } }));
  assert.deepEqual(json.rows.find((r) => r.case === 'a').warnings, []);
});

test('refusals: a full-length reply with no tools is drift, not a refusal — no note', async () => {
  const acts = { toolUses: [{ tool: 'Bash', input: '{}' }] };
  const base = report({ cases: { a: three(acts) } });
  // 1 turn, no tools, low score — but a complete answer (the skill simply did not fire)
  const full = { score: 0.25, numTurns: 1, toolUses: [], response: 'public class InvoiceController { '.repeat(40) };
  const { status, md, json } = await run(base, report({ cases: { a: [full, full, full] } }));
  assert.equal(status, 1);
  assert.equal(json.rows.find((r) => r.case === 'a').refusedRuns, 0);
  assert.doesNotMatch(md, /look like refusals/);
});
