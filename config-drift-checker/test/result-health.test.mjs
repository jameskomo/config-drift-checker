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

// Modelled on the 2.1.310 runner's JSON serializer and the plugin-evals docs ("ended on an API error and scored 0
// without grading"): such a run has score 0, an error and no grader results, and the case and overall aggregates
// include its 0. A timed-out run, by contrast, is graded on what it produced.
const API_ERROR = new URL('./fixtures/official-2.1.299-api-error.json', import.meta.url).pathname;

test('2.1.299 API-error run: errored and ungraded, never a regression; the case score is re-taken over graded runs', async () => {
  const { normalizeResult, classifyCase, caseMap } = await import('../tools/eval-classify.mjs');
  const n = normalizeResult(JSON.parse(await fs.readFile(API_ERROR, 'utf8')));
  const m = caseMap(n), a = m.get('spring-work-triggers-skill'), b = m.get('vue-request-does-not-trigger-skill');
  assert.deepEqual(a.arms.with.map((r) => [r.score, r.isError, !!r.ungraded]), [[1, false, false], [1, false, false], [null, true, true]]);
  assert.equal(a.summary.score, 1, 'the runner said 0.67 because it counted the ungraded 0');
  assert.equal(a.rescored, true);
  assert.equal(b.summary.score, 0.75, 'no ungraded run: the runner\'s own case score stands (the timed-out run was graded)');
  assert.equal(b.arms.with[1].isError, true, 'errored accounting is unchanged: any run with an error counts as errored');
  assert.equal(n.aggregates.overallScore, (1 + 0.75) / 2);
  assert.equal(n.aggregates.erroredRuns, 2); assert.equal(n.aggregates.ungradedRuns, 1); assert.equal(n.aggregates.totalRuns, 5);
  assert.match(n.aggregates.partialReason, /^2 of 5 agent runs errored: API Error: 429 rate_limit_error/);
  const base = { dir: 'spring-work-triggers-skill', arms: { with: [{ score: 1, isError: false }, { score: 1, isError: false }] }, summary: { score: 1 } };
  assert.equal(classifyCase('spring-work-triggers-skill', base, a, null, 0.15).status, 'stable', 'not a regression');
  const raw = JSON.parse(await fs.readFile(API_ERROR, 'utf8'));
  assert.equal(classifyCase('spring-work-triggers-skill', base, { summary: { score: raw.cases[0].aggregates.score } }, null, 0.15).status, 'regressed', 'what the raw 0.67 would have said');
  const h = kv(spawnSync('node', [TOOL, API_ERROR, '--expect-cases', '2'], { encoding: 'utf8' }).stdout);
  assert.deepEqual([h.usable, h.errored, h.total, h.ungraded], ['true', '2', '5', '1'], 'still a usable result; the Action marks it errored, so nothing is stored as a baseline');
});

test('ungraded: only an errored run with a 0 and no grader results, or the explicit flag; a mock abort is a real 0', async () => {
  const { ungraded } = await import('../tools/eval-classify.mjs');
  assert.equal(ungraded(run({ score: 0, error: 'API Error: 529 overloaded_error' })), true);
  assert.equal(ungraded(run({ score: 0, error: 'x', graders: [{ name: 'g', passed: false }] })), false, 'graded on what it produced');
  assert.equal(ungraded(run({ score: 0, error: null, aborted: { server: 's', tool: 't', reason: 'expect' } })), false);
  assert.equal(ungraded(run({ score: 0.5, error: 'x', endedOnApiError: true })), true);
  assert.equal(ungraded(run()), false);
});

test('normalizeResult gives native results an errored count and a partialReason (no more "undefined" headline)', async () => {
  const { normalizeResult } = await import('../tools/eval-classify.mjs');
  const n = normalizeResult(native([{ dir: 'evals/a', arms: { with: [run({ error: 'boom' }), run()] } }]));
  assert.equal(n.aggregates.erroredRuns, 1);
  assert.match(n.aggregates.partialReason, /1 of 2 agent runs errored: boom/);
});
