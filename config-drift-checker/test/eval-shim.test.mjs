import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SHIM = new URL('../tools/eval-shim.mjs', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;

// A throwaway plugin with one case (3 runs by default) and a regex grader that wants "DONE".
async function makePlugin({ runs = 3, cdcYml = null, caseModel = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-plugin-'));
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.1' }));
  const c = path.join(dir, 'evals/case-a');
  await fs.mkdir(path.join(c, 'graders'), { recursive: true });
  await fs.writeFile(path.join(c, 'prompt.md'), `---\nname: Case A\ntags: [demo]\ncovers: [code/rule-one]\nruns: ${runs}\nmax_turns: 4\n${caseModel ? `model: ${caseModel}\n` : ''}---\nDo the thing and say DONE.\n`);
  await fs.writeFile(path.join(c, 'graders/done.md'), `---\ntype: regex\npattern: DONE\ntarget: last_message\n---\nSays DONE.\n`);
  if (cdcYml) await fs.writeFile(path.join(dir, '.cdc.yml'), cdcYml);
  return dir;
}

// Runs the shim against the fake claude; returns the parsed report, the fake's call log and stderr.
async function runShim(plugin, extraArgs = [], fakeEnv = {}) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-bin-'));
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-state-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-out-'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: state, CLAUDE_CONFIG_DIR: await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-')), ...fakeEnv };
  const r = spawnSync('node', [SHIM, plugin, '--ablation', 'none', '--no-isolate', '--output-dir', out, ...extraArgs], { env, encoding: 'utf8' });
  const reportPath = path.join(out, 'aggregate-result.json');
  const report = r.status === 0 || r.status === null ? JSON.parse(await fs.readFile(reportPath, 'utf8')) : null;
  let calls = [];
  try { calls = (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { report, calls, stderr: r.stderr, status: r.status };
}
const argOf = (call, flag) => call.args[call.args.indexOf(flag) + 1];

test('no .cdc.yml: schema 1.1 with provenance, pinned track on the unpinned alias, case-default runs', async () => {
  const { report, calls, stderr } = await runShim(await makePlugin());
  assert.equal(report.schemaVersion, '1.1');
  assert.equal(report.agent, 'claude'); assert.equal(report.track, 'pinned');
  assert.deepEqual(report.harness, { name: 'claude-code', version: '9.9.9' });
  assert.deepEqual(report.judge, { model: 'haiku' });
  assert.equal(report.config.model, 'sonnet'); assert.equal(report.config.modelIsPinned, false); assert.equal(report.config.file, null);
  assert.equal(report.config.budgetUsd, 2); // the built-in per-run default
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => argOf(c, '--model') === 'sonnet'));
  assert.ok(calls.every((c) => c.args.includes('--plugin-dir')));
  assert.equal(report.cases[0].arms.with.length, 3);
  assert.ok(report.cases[0].arms.with.every((r) => r.model === 'claude-sonnet-5' && r.score === 1));
  assert.deepEqual(report.cases[0].covers, ['code/rule-one']);
  assert.deepEqual(report.aggregates.resolvedModels, ['claude-sonnet-5']);
  assert.equal(report.aggregates.budget.exceeded, false);
  assert.match(stderr, /track=pinned · model=sonnet \(unpinned alias\) · claude-code=9\.9\.9/);
});

const CDC = `track: canary\nmodel:\n  pinned: claude-sonnet-5\n  canary: sonnet\nharness:\n  pinned: 2.1.200\n  canary: latest\ncanary:\n  runs: 1\n  expand_on_deviation: 2\nbudget:\n  per_run_usd: 5\n`;

test('canary track: one run, expands by two only on deviation', async () => {
  const clean = await runShim(await makePlugin({ cdcYml: CDC }), ['--track', 'canary']);
  assert.equal(clean.report.track, 'canary'); assert.equal(clean.calls.length, 1);
  assert.equal(clean.report.config.expandOnDeviation, 2); assert.equal(clean.report.config.harness, 'latest');
  assert.equal(clean.report.config.budgetUsd, 5);

  const deviating = await runShim(await makePlugin({ cdcYml: CDC }), ['--track', 'canary'], { FAKE_CLAUDE_FAIL: '0' });
  assert.equal(deviating.calls.length, 3, 'first run failed → two more');
  assert.match(deviating.stderr, /deviation in the first 1 run\(s\) — expanding by 2 more/);
  const scores = deviating.report.cases[0].arms.with.map((r) => r.score);
  assert.deepEqual(scores, [0, 1, 1]);
  assert.ok(Math.abs(deviating.report.cases[0].summary.score - 2 / 3) < 1e-9);
});

test('pinned track from .cdc.yml: exact model id, pinned harness recorded, case-default runs, no expansion', async () => {
  const { report, calls } = await runShim(await makePlugin({ cdcYml: CDC }), ['--track', 'pinned'], { FAKE_CLAUDE_FAIL: '0' });
  assert.equal(report.track, 'pinned');
  assert.ok(calls.every((c) => argOf(c, '--model') === 'claude-sonnet-5'));
  assert.equal(report.config.modelIsPinned, true); assert.equal(report.config.harness, '2.1.200'); assert.equal(report.config.harnessIsPinned, true);
  assert.equal(calls.length, 3, 'case default of 3, and pinned never expands');
});

test('config track default is used when --track is omitted; CLI --model beats config and case', async () => {
  const viaConfig = await runShim(await makePlugin({ cdcYml: CDC }));
  assert.equal(viaConfig.report.track, 'canary'); assert.equal(viaConfig.calls.length, 1);
  const cli = await runShim(await makePlugin({ cdcYml: CDC, caseModel: 'haiku' }), ['--track', 'pinned', '--model', 'opus']);
  assert.ok(cli.calls.every((c) => argOf(c, '--model') === 'opus'));
  assert.equal(cli.report.config.modelIsPinned, true, 'an explicit --model counts as pinned');
});

test('a case-level model: in the frontmatter is honoured when no --model is given', async () => {
  const { calls, report } = await runShim(await makePlugin({ caseModel: 'haiku' }));
  assert.ok(calls.every((c) => argOf(c, '--model') === 'haiku'));
  assert.equal(report.config.model, 'haiku');
});

test('budget cap: stops starting runs once spend reaches the cap; what ran is kept and scored', async () => {
  const { report, calls, stderr, status } = await runShim(await makePlugin({ runs: 3 }), ['--budget', '2'], { FAKE_CLAUDE_COST: '1.5' });
  assert.equal(status, 0);
  assert.equal(calls.length, 2, '1.5 + 1.5 = 3.0 ≥ 2 → the third run never starts');
  assert.deepEqual(report.aggregates.budget, { capUsd: 2, spentUsd: 3, exceeded: true, skippedRuns: 1 });
  assert.equal(report.cases[0].summary.score, 1);
  assert.match(stderr, /BUDGET CAP: stopped after \$3\.00 \(cap \$2\); 1 planned run\(s\) not started/);
  const none = await runShim(await makePlugin({ runs: 3 }), ['--budget', '0'], { FAKE_CLAUDE_COST: '1.5' });
  assert.equal(none.calls.length, 3, '--budget 0 disables the cap'); assert.equal(none.report.aggregates.budget, null);
});

test('errored runs are still counted and surfaced (credit exhausted), score null for that run', async () => {
  const { report } = await runShim(await makePlugin({ runs: 2 }), [], { FAKE_CLAUDE_ERROR: '0' });
  assert.equal(report.aggregates.erroredRuns, 1);
  assert.match(report.aggregates.partialReason, /Credit balance is too low/);
  assert.equal(report.cases[0].arms.with[0].score, null); assert.equal(report.cases[0].arms.with[1].score, 1);
});

test('--agent other than claude exits 1 with a clear message', async () => {
  const plugin = await makePlugin();
  const r = spawnSync('node', [SHIM, plugin, '--agent', 'codex', '--ablation', 'none'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agent "codex" is not supported yet/);
});

test('--regrade keeps working and carries the source harness version through', async () => {
  const plugin = await makePlugin({ runs: 2 });
  const first = await runShim(plugin, [], { FAKE_CLAUDE_VERSION: '1.2.3' });
  const src = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'regrade-src-')), 'aggregate-result.json');
  await fs.writeFile(src, JSON.stringify(first.report));
  const re = await runShim(plugin, ['--regrade', src]);
  assert.equal(re.calls.length, 0, 'no agent calls on regrade');
  assert.equal(re.report.harness.version, '1.2.3');
  assert.equal(re.report.cases[0].arms.with.length, 2);
  assert.equal(re.report.regradeOf, src);
});
