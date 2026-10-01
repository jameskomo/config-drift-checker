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

test('--agent outside the supported set exits with a clear message', async () => {
  const plugin = await makePlugin();
  const r = spawnSync('node', [SHIM, plugin, '--agent', 'cursor', '--ablation', 'none'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown agent 'cursor' \(claude \| codex \| gemini\)/);
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

test('--regrade inherits the saved run ablation mode — tool_used Skill graders stay scored (no CLI flag)', async () => {
  const plugin = await makePlugin({ runs: 1 });
  await fs.writeFile(path.join(plugin, 'evals/case-a/graders/fired.md'), `---\ntype: tool_used\ntool: Skill\ninput_match: fixture\nmin: 1\n---\nSkill fired.\n`);
  const first = await runShim(plugin); // ablation none via the helper
  const src = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'regrade-abl-')), 'aggregate-result.json');
  await fs.writeFile(src, JSON.stringify(first.report));
  // regrade WITHOUT any --ablation flag: the CLI default (with-without) must not demote the grader
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-bin-'));
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-out-'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: await fs.mkdtemp(path.join(os.tmpdir(), 'fake-state-')), CLAUDE_CONFIG_DIR: await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-')) };
  const r = spawnSync('node', [SHIM, plugin, '--regrade', src, '--no-isolate', '--output-dir', out], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(await fs.readFile(path.join(out, 'aggregate-result.json'), 'utf8'));
  const g = report.cases[0].arms.with[0].graders.find((x) => x.name === 'fired');
  assert.equal(g.scored, true, 'tool_used grader must stay scored on an ablation-none regrade');
  assert.notEqual(report.cases[0].summary.score, null, 'the case score must not collapse to null');
});

test('discovery snapshot: every SKILL.md under the plugin is recorded, malformed ones flagged', async () => {
  const plugin = await makePlugin();
  await fs.mkdir(path.join(plugin, 'skills/conventions'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'skills/conventions/SKILL.md'), '---\nname: Conventions\ndescription: house style\n---\n# body\n');
  await fs.mkdir(path.join(plugin, 'skills/broken'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'skills/broken/SKILL.md'), '# no frontmatter at all\n');
  const { report } = await runShim(plugin, ['--runs', '1']);
  const skills = report.discovered.skills;
  assert.equal(skills.length, 2);
  const good = skills.find((s) => s.dir === 'skills/conventions');
  assert.equal(good.name, 'Conventions'); assert.equal(good.malformed, false);
  const bad = skills.find((s) => s.dir === 'skills/broken');
  assert.equal(bad.malformed, true, 'SKILL.md without name/description is flagged');
});

test('codex agent (experimental): runs via codex exec, bridges AGENTS.md, skips Skill indicators, stamps agent', async () => {
  const plugin = await makePlugin({ runs: 1 });
  // a Claude-only indicator that must be skipped, not failed, on codex
  await fs.writeFile(path.join(plugin, 'evals/case-a/graders/skill-fired.md'), '---\ntype: tool_used\ntool: Skill\nmin: 1\n---\nSkill fired.\n');
  // the scaffold plants a fake codex into .eval-bin (the shim puts it on PATH) and a CLAUDE.md to bridge
  const caseYaml = `scaffold_script: |
  mkdir -p .eval-bin
  cat > .eval-bin/codex << 'SH'
  #!/bin/sh
  [ -f AGENTS.md ] && A=yes || A=no
  echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls","exit_code":0,"output":"ok"}}'
  echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"DONE AGENTSMD=$A\\"}}"
  echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'
  SH
  chmod +x .eval-bin/codex
  echo house rules > CLAUDE.md
`;
  await fs.writeFile(path.join(plugin, 'evals/case-a/case.yaml'), caseYaml);
  const { report } = await runShim(plugin, ['--agent', 'codex', '--scaffold']);
  assert.equal(report.agent, 'codex');
  const run = report.cases[0].arms.with[0];
  assert.match(run.response, /DONE AGENTSMD=yes/, 'CLAUDE.md was bridged to AGENTS.md');
  assert.ok(run.toolUses.some((u) => u.tool === 'Bash' && u.input === 'ls'), 'command_execution mapped to Bash');
  const done = run.graders.find((g) => g.name === 'done');
  assert.equal(done.verdict, 'pass', 'regex grader scores the codex reply');
  const skill = run.graders.find((g) => g.name === 'skill-fired');
  assert.equal(skill.scored, false, 'Skill indicator skipped on codex');
  assert.match(skill.reason, /does not exist on codex/);
  assert.equal(report.cases[0].summary.score, 1, 'skipped indicator does not drag the score');
});

test('gemini agent (experimental): headless text run, GEMINI.md bridged, tool indicators skipped', async () => {
  const plugin = await makePlugin({ runs: 1 });
  await fs.writeFile(path.join(plugin, 'evals/case-a/graders/acted.md'), '---\ntype: tool_used\ntool: Bash\nmin: 1\n---\nRan something.\n');
  const caseYaml = `scaffold_script: |
  mkdir -p .eval-bin
  cat > .eval-bin/gemini << 'SH'
  #!/bin/sh
  [ -f GEMINI.md ] && A=yes || A=no
  echo "DONE GEMINIMD=$A"
  SH
  chmod +x .eval-bin/gemini
  echo house rules > CLAUDE.md
`;
  await fs.writeFile(path.join(plugin, 'evals/case-a/case.yaml'), caseYaml);
  const { report } = await runShim(plugin, ['--agent', 'gemini', '--scaffold']);
  assert.equal(report.agent, 'gemini');
  const run = report.cases[0].arms.with[0];
  assert.match(run.response, /DONE GEMINIMD=yes/, 'CLAUDE.md bridged to GEMINI.md');
  assert.equal(run.graders.find((g) => g.name === 'done').verdict, 'pass');
  const acted = run.graders.find((g) => g.name === 'acted');
  assert.equal(acted.scored, false, 'tool indicator skipped without machine-readable tool calls');
  assert.match(acted.reason, /no machine-readable tool calls/);
  assert.equal(report.cases[0].summary.score, 1);
});

test('discovery: an unquoted colon-space in a SKILL.md description is malformed (issue #14)', async () => {
  const plugin = await makePlugin();
  await fs.mkdir(path.join(plugin, 'skills/colon'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'skills/colon/SKILL.md'), '---\nname: colon\ndescription: runs with repair: true sometimes\n---\nbody\n');
  const { report } = await runShim(plugin, ['--runs', '1']);
  const sk = report.discovered.skills.find((s) => s.dir === 'skills/colon');
  assert.equal(sk.malformed, true, 'strict-YAML-invalid frontmatter is flagged');
});

test('every SKILL.md this repo ships has strictly quoted frontmatter values', async () => {
  const roots = [new URL('../skills', import.meta.url).pathname];
  for (const root of roots) {
    for (const d of await fs.readdir(root)) {
      const t = await fs.readFile(path.join(root, d, 'SKILL.md'), 'utf8');
      const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
      for (const line of fm.split('\n')) {
        const m = line.match(/^(name|description):\s*(.+)$/);
        if (m && !/^["'>|]/.test(m[2])) assert.ok(!m[2].includes(': '), `${d}/SKILL.md ${m[1]}: unquoted ': ' breaks strict YAML`);
      }
    }
  }
});

test('official case format: case.yaml names a scaffold script file; inline still runs with a migration warning', async () => {
  const plugin = await makePlugin({ runs: 1 });
  const c = path.join(plugin, 'evals/case-a');
  await fs.writeFile(path.join(c, 'scaffold.sh'), '#!/usr/bin/env bash\necho fixture > made-by-scaffold.txt\n');
  await fs.writeFile(path.join(c, 'case.yaml'), 'schema_version: "1.1"\nname: case-a\ncontext:\n  scaffold_script: scaffold.sh\n');
  const { report, stderr } = await runShim(plugin, ['--scaffold']);
  assert.match(report.cases[0].scaffold, /made-by-scaffold/, 'the script file was read');
  assert.doesNotMatch(stderr ?? '', /old form/);
  await fs.writeFile(path.join(c, 'case.yaml'), 'schema_version: "1.1"\nname: case-a\ncontext:\n  scaffold_script: |\n    echo legacy > x.txt\n');
  const legacy = await runShim(plugin, ['--scaffold']);
  assert.match(legacy.report.cases[0].scaffold, /echo legacy/);
  assert.match(legacy.stderr ?? '', /inline scaffold_script is the old form/);
});

test('official grader vocabulary: llm focus, and { source: file, path } reads one file', async () => {
  const plugin = await makePlugin({ runs: 1 });
  const g = path.join(plugin, 'evals/case-a/graders');
  await fs.writeFile(path.join(g, 'judge.md'), '---\ntype: llm\nfocus: last_message\n---\nSays DONE.\n');
  await fs.writeFile(path.join(g, 'file-ref.md'), '---\ntype: regex\npattern: never-in-any-file\nmatch: not_contains\ntarget: { source: file, path: out.txt }\n---\nfile check.\n');
  const { report } = await runShim(plugin, ['--runs', '1']);
  const graders = report.cases[0].graders;
  assert.equal(graders.find((x) => x.name === 'judge').focus, 'last_message', 'focus carried into the report');
  const fr = report.cases[0].arms.with[0].graders.find((x) => x.name === 'file-ref');
  assert.equal(fr.verdict, 'pass', 'missing file reads as empty, so not_contains passes');
});

test('{ source: file, path } reads a file the scaffold wrote (any workspace file, like the official runner)', async () => {
  const plugin = await makePlugin({ runs: 1 });
  const c = path.join(plugin, 'evals/case-a');
  await fs.writeFile(path.join(c, 'scaffold.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nROOT="${EVAL_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"\necho "plugin=$(basename "$ROOT")" > seeded.txt\n');
  await fs.writeFile(path.join(c, 'case.yaml'), 'schema_version: "1.1"\nname: case-a\ncontext:\n  scaffold_script: scaffold.sh\n');
  await fs.writeFile(path.join(c, 'graders/seeded.md'), '---\ntype: regex\npattern: plugin=\ntarget: { source: file, path: seeded.txt }\n---\nseeded.\n');
  const { report } = await runShim(plugin, ['--scaffold']);
  const g = report.cases[0].arms.with[0].graders.find((x) => x.name === 'seeded');
  assert.equal(g.verdict, 'pass', 'scaffold-created file is visible to the file-ref grader');
});

test('arm: with-only (official) is scored in the with arm only, like the older arm: with', async () => {
  const plugin = await makePlugin({ runs: 1 });
  await fs.writeFile(path.join(plugin, 'evals/case-a/graders/only-with.md'), '---\ntype: regex\npattern: DONE\narm: with-only\n---\nwith only.\n');
  const { report } = await runShim(plugin, ['--ablation', 'with-without']);
  const w = report.cases[0].arms.with[0].graders.find((x) => x.name === 'only-with');
  const wo = report.cases[0].arms.without[0].graders.find((x) => x.name === 'only-with');
  assert.equal(w.scored, true);
  assert.equal(wo.scored, false, 'not scored in the without arm');
});
