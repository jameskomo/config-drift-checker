import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../tools/eval-report.mjs';

// A result whose cases have the given with-arm run scores; summary.score is the mean.
const kase = (dir, scores) => ({
  dir, name: dir, tags: [],
  arms: { with: scores.map((score, i) => ({ runIndex: i, score, numTurns: 4, costUsd: 0.1, durationMs: 5000, model: 'm1', isError: false, toolUses: [{ tool: 'Bash', input: '{}' }], graders: [{ name: 'done', type: 'regex', score, verdict: score === 1 ? 'pass' : 'fail', scored: true }] })) },
  summary: { score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null },
});
const result = (cases) => ({
  schemaVersion: '1.1', track: 'pinned', shim: true, generatedAt: '2026-09-03T00:00:00Z', suite: { name: 'fixture' },
  harness: { name: 'claude-code', version: '2.1.200' },
  cases: Object.entries(cases).map(([dir, scores]) => kase(dir, scores)),
  aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: 9, costUsd: 0.9 },
});

// baseline a=[1,1,1]; current a=[1,0.4,0.4] (Δ −0.40); history puts the noise band at ±0.50 → noisy
const base = result({ a: [1, 1, 1], b: [1, 1, 1] });
const cur = result({ a: [1, 0.4, 0.4], b: [1, 1, 1] });
const history = [result({ a: [1, 1], b: [1, 1, 1] }), result({ a: [0.5, 1], b: [1, 1, 1] })];

test('with --history: a drop inside the noise band renders noisy (amber), never red', () => {
  const html = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  assert.match(html, /No regressions · 1 noisy/);
  assert.match(html, /class="move warn"/, 'the move card is amber, not red');
  assert.match(html, /noisy · within ±0\.50 band/);
  assert.match(html, /<tr class="st-noisy">/);
  assert.doesNotMatch(html, /<tr class="st-regressed">/);
  assert.match(html, /<th>noise<\/th>/);
  assert.match(html, /⚠ 1 noisy:<\/b> dropped past 0\.15 but within historical noise \(±0\.50 over the last 2 runs\)/);
  assert.match(html, /noise ±0\.50/, 'the case header carries the band');
});

test('sparkline: one bar per with-arm run in the case header, no JS', () => {
  const html = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  const sparks = html.match(/<svg class="spark"[^>]*>/g) ?? [];
  assert.equal(sparks.length, 2, 'one sparkline per case');
  const aSection = html.split('id="case-a"')[1].split('id="case-b"')[0];
  const bars = aSection.match(/<rect /g) ?? [];
  assert.equal(bars.length, 3);
  assert.match(aSection, /<svg class="spark" viewBox="0 0 23 22"/);
  assert.doesNotMatch(html, /<script/, 'still script-free');
});

test('without --history: the flat threshold decides, as before', () => {
  const html = renderReport(cur, base, { threshold: 0.15 });
  assert.match(html, /1 case regressed vs baseline/);
  assert.match(html, /<tr class="st-regressed">/);
  assert.doesNotMatch(html, /class="st-noisy"/);
});

test('baseline-quality warnings render as a never-red note', () => {
  const thinBase = result({ a: [1, 0.4] }); // 2 runs (< min 3), spread 0.6
  const html = renderReport(result({ a: [1, 0.4] }), thinBase, { threshold: 0.15, minBaselineRuns: 3 });
  assert.match(html, /⚠ baseline quality \(never red\):<\/b> <code>a<\/code> — thin baseline \(n=2\), unstable baseline \(±0\.60\)/);
});

test('suite completeness: cases on disk but not in the run are listed, stamp shows N of M', () => {
  const html = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3, suiteDirs: ['a', 'b', 'c-not-run', 'd-not-run'] });
  assert.match(html, /2 of 4 in suite/);
  assert.match(html, /Not evaluated in this run \(2 of the suite\)/);
  assert.match(html, /<code>c-not-run<\/code>/);
  assert.match(html, /suite completeness/);
  // without suiteDirs: no strip, chip shown as inactive guidance
  const bare = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  assert.doesNotMatch(bare, /Not evaluated in this run/);
  assert.match(bare, /run with --config to compare against the suite on disk/);
});

test('checks panel: counts grader verdicts and runs, marks the layer beyond a plain claude plugin eval', () => {
  const html = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  assert.match(html, /6 grader verdicts across 6 agent runs on 2 cases/);
  assert.match(html, /A plain <code>claude plugin eval<\/code> run stops there/);
  assert.match(html, /✓ baseline diff/); assert.match(html, /✓ noise bands/); assert.match(html, /✓ refusal screening/);
  // no baseline, no history: chips flip to guidance
  const alone = renderReport(cur, null, { thresholds: { score: 0.15 }, history: null, minBaselineRuns: 3 });
  assert.match(alone, /run with --baseline to compare/);
});

test('discovered skills panel: invoked, never invoked, and malformed each render distinctly', () => {
  const withSkill = JSON.parse(JSON.stringify(cur));
  withSkill.discovered = { skills: [
    { dir: 'skills/conventions', name: 'Conventions', description: 'x', malformed: false },
    { dir: 'skills/unused', name: 'Unused', description: 'y', malformed: false },
    { dir: 'skills/broken', name: 'broken', description: null, malformed: true },
  ] };
  withSkill.cases[0].arms.with[0].toolUses = [{ tool: 'Skill', input: '{"command":"conventions"}' }];
  const html = renderReport(withSkill, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  assert.match(html, /Skills discovered at run start/);
  assert.match(html, /✓ conventions · invoked in 1/);
  assert.match(html, /⚠ unused · never invoked this run/);
  assert.match(html, /✖ broken · malformed/);
});
