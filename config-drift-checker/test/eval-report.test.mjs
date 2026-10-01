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
  assert.match(html, /⚠ baseline quality \(never red\):<\/b> <code>a<\/code>, thin baseline \(n=2\), unstable baseline \(±0\.60\)/);
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

// ---- setup health panel (cur.preflight = { skills: skill-lint JSON, suite: suite-doctor JSON }) ----
const withPreflight = (preflight) => ({ ...JSON.parse(JSON.stringify(cur)), preflight });
const cleanSkills = { schemaVersion: 1, pluginDir: 'p', skills: 4, errors: 0, warnings: 0, findings: [] };
const liveOk = { status: 'ok', runner: '/usr/bin/claude', version: '2.1.287', loadErrors: [], notes: [], failedCount: 0, runsStarted: 0, costUsd: 0, loaded: 6 };
const cleanSuite = { pluginDir: 'p', evalDir: 'evals', cases: 6, fixApplied: false, fixed: [], findings: [], live: liveOk, summary: { errors: 0, warnings: 0, fixed: 0, fixable: 0 } };
const healthPanel = (html) => html.split('class="xtr health"')[1]?.split('<details class="howto"')[0] ?? '';
const skillWarn = (i) => ({ level: 'WARN', rule: 'no-negative-scope', file: `skills/s${i}/SKILL.md`, line: 3, message: `skill ${i} names no negative scope`, fix: 'add a "Do not use for ..." sentence' });
const suiteErr = { level: 'ERROR', rule: 'scaffold-top-level', case: 'guard', file: 'eval.yaml', key: 'scaffold_script', message: 'scaffold_script belongs under context:', fix: 'move it under context:', fixable: true, confirmedByRunner: true };

test('setup health: without preflight nothing new renders, no chip, no panel', () => {
  const html = renderReport(cur, base, { thresholds: { score: 0.15 }, history, minBaselineRuns: 3 });
  assert.doesNotMatch(html, /Setup health/);
  assert.doesNotMatch(html, /class="xtr health"/);
  assert.doesNotMatch(html, /setup health/);
  assert.doesNotMatch(html, /class="tile /);
});

test('setup health: a clean preflight shows pass tiles and one reassuring line', () => {
  const html = renderReport(withPreflight({ skills: cleanSkills, suite: cleanSuite }), base, { threshold: 0.15 });
  const panel = healthPanel(html);
  assert.match(panel, /Setup health on Claude Code 2\.1\.287/);
  assert.match(panel, /these checks start no model runs/);
  assert.match(panel, /<div class="tile t-pass"><span class="tile-h">Skills<\/span><span class="tile-v">✓ clean<\/span><span class="tile-s">4 skills checked · 0 errors · 0 warnings<\/span>/);
  assert.match(panel, /<div class="tile t-pass"><span class="tile-h">Eval suite format<\/span><span class="tile-v">✓ clean<\/span>/);
  assert.match(panel, /loaded 6 of 6 cases · confirmed by the runner/);
  assert.match(panel, /✓<\/span> No setup problems: 4 skills and 6 eval cases pass every static check, and the runner loaded the suite\./);
  assert.doesNotMatch(panel, /class="hfind"/);
  assert.match(html, /<span class="chip pass" title="[^"]*">✓ setup health<\/span>/, 'the checks row gains an active chip');
  // the panel sits between the checks row and the rest of the report
  assert.ok(html.indexOf('What this report checks') < html.indexOf('Setup health on'));
});

test('setup health: version falls back to the harness, and a single part renders alone', () => {
  const html = renderReport(withPreflight({ skills: cleanSkills }), base, { threshold: 0.15 });
  const panel = healthPanel(html);
  assert.match(panel, /Setup health on Claude Code 2\.1\.200/);
  assert.match(panel, /Skills<\/span>/);
  assert.doesNotMatch(panel, /Eval suite format/);
  assert.match(panel, /No setup problems: 4 skills pass every static check\./);
});

test('setup health: errors and warnings carry tone, glyph, word, fix text and suite tags, errors first', () => {
  const skills = { ...cleanSkills, warnings: 1, findings: [skillWarn(1)] };
  const suite = { ...cleanSuite, findings: [suiteErr], summary: { errors: 1, warnings: 0, fixed: 0, fixable: 1 } };
  const panel = healthPanel(renderReport(withPreflight({ skills, suite }), base, { threshold: 0.15 }));
  assert.match(panel, /<div class="tile t-warn"><span class="tile-h">Skills<\/span><span class="tile-v">⚠ 1 warning<\/span>/);
  assert.match(panel, /<div class="tile t-fail"><span class="tile-h">Eval suite format<\/span><span class="tile-v">✖ 1 error<\/span>/);
  const lis = panel.match(/<li>[\s\S]*?<\/li>/g);
  assert.equal(lis.length, 2);
  assert.match(lis[0], /<span class="lv fail">✖ error<\/span><code>guard \/ eval\.yaml scaffold_script:<\/code> scaffold_script belongs under context:/, 'the suite error comes first');
  assert.match(lis[0], /<span class="tag">\[--fix can apply\]<\/span> <span class="tag">runner agrees<\/span>/);
  assert.match(lis[0], /<span class="fx">Fix: move it under context:<\/span>/);
  assert.match(lis[1], /<span class="lv warn">⚠ warning<\/span><code>skills\/s1\/SKILL\.md:3<\/code> skill 1 names no negative scope/);
  assert.match(lis[1], /Fix: add a &quot;Do not use for \.\.\.&quot; sentence/);
  assert.doesNotMatch(lis[1], /class="tag"/, 'skill findings carry no suite tags');
  assert.doesNotMatch(panel, /No setup problems/);
});

test('setup health: more than 12 findings are cut to 12 with an "and N more" line', () => {
  const findings = Array.from({ length: 15 }, (_, i) => skillWarn(i));
  const panel = healthPanel(renderReport(withPreflight({ skills: { ...cleanSkills, warnings: 15, findings } }), base, { threshold: 0.15 }));
  assert.equal((panel.match(/<li>/g) ?? []).length, 12);
  assert.match(panel, /and 3 more; run skill-lint and suite-doctor locally for the full list\./);
  assert.match(panel, /⚠ 15 warnings/);
});

test('setup health: a live check that did not run says not confirmed and why', () => {
  const suite = { ...cleanSuite, live: { status: 'skipped', reason: 'no --runner given and no claude on PATH' } };
  const panel = healthPanel(renderReport(withPreflight({ suite }), base, { threshold: 0.15 }));
  assert.match(panel, /Setup health on Claude Code 2\.1\.200/, 'no live version, so the harness version');
  assert.match(panel, /6 cases checked statically · not confirmed: no --runner given and no claude on PATH/);
  assert.doesNotMatch(panel, /confirmed by the runner/);
  assert.match(panel, /No setup problems: 6 eval cases pass every static check\./);
  assert.doesNotMatch(panel, /runner loaded the suite/);
});

test('setup health: finding text is HTML-escaped', () => {
  const evil = { ...skillWarn(0), file: 'skills/<b>x</b>/SKILL.md', message: '<script>alert(1)</script> & "quoted"', fix: '<img src=x onerror=alert(1)>' };
  const suite = { ...cleanSuite, live: { status: 'failed', reason: '<svg onload=alert(1)>' }, findings: [{ ...suiteErr, case: '<i>c</i>' }] };
  const html = renderReport(withPreflight({ skills: { ...cleanSkills, warnings: 1, findings: [evil] }, suite }), base, { threshold: 0.15 });
  assert.doesNotMatch(html, /<script|<img |<svg onload|<b>x<\/b>|<i>c<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quoted&quot;/);
  assert.match(html, /Fix: &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /not confirmed: &lt;svg onload=alert\(1\)&gt;/);
});
