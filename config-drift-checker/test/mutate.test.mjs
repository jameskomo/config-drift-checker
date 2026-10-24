import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSuite, generateMutants, relevantCases, sampleMutants, materialize, blurDescription, invertLines, summarize, renderMutateHtml, renderMutateMd, mutateJson, OPERATORS, BLURRED } from '../tools/mutate.mjs';

const TOOL = new URL('../tools/mutate.mjs', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

// A setup with a CLAUDE.md rule nothing covers, a skill with two body rules and a marker in its trigger
// description, and one hook. Four cases: one per skill rule, a trigger tripwire that only mentions the
// skill, and a hook case. The fake (FAKE_CLAUDE_REQUIRE in fakeEnv) fails the controller case when DTOMARK
// is gone and the trigger case when WIDGETMARK is gone; the secrets and guard cases never notice anything.
async function makePlugin() {
  const dir = await tmp('mutate-plugin-');
  const w = async (rel, text) => { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), text); };
  await w('.claude-plugin/plugin.json', JSON.stringify({ name: 'widget-kit', version: '0.0.1', skills: ['./skills/widgets'], hooks: './hooks/hooks.json' }, null, 2));
  await w('CLAUDE.md', '# Team rules\n\n- Always run the linter before you commit.\n');
  await w('skills/widgets/SKILL.md', '---\nname: widgets\ndescription: Widget conventions. Use when the user asks for widget work (WIDGETMARK).\n---\n# Widgets\n\n- Controllers return DTOs, never entities (DTOMARK).\n- Never log secrets in widget code,\n  not even at debug level.\n\nDone.\n');
  await w('hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs' }] }] } }, null, 2));
  await w('hooks/guard.mjs', 'process.exit(0);\n');
  const kase = async (name, prompt, covers, grader = 'Says DONE.') => {
    await w(`evals/${name}/prompt.md`, `---\nname: ${name}\nmax_turns: 4\n---\n${prompt}\n`);
    await w(`evals/${name}/graders/done.md`, `---\ntype: regex\npattern: DONE\ntarget: last_message\n---\n${grader}\n`);
    await w(`evals/${name}/covers.yaml`, covers.length ? covers.map((c) => `- ${c}`).join('\n') + '\n' : '[]\n');
  };
  await kase('controller', 'Write a widget controller and say DONE.', ['skill/widgets/controllers-return-dtos-never-entities-dtomark']);
  await kase('secrets', 'Secrets check, say DONE.', ['skill/widgets/never-log-secrets-in-widget-code']);
  await kase('trigger', 'Trigger check, say DONE.', [], 'The widgets skill fired and the reply says DONE.');
  await kase('guard', 'Guard check, say DONE.', ['hook/pretooluse-bash']);
  await w('evals/results/old/aggregate-result.json', JSON.stringify({ cases: [{ dir: 'controller', summary: { score: 1 }, arms: { with: [{ score: 1, costUsd: 0.2 }] } }, { dir: 'guard', summary: { score: 1 }, arms: { with: [{ score: 1, costUsd: 0.1 }] } }] }));
  return dir;
}
const fakeEnv = { FAKE_CLAUDE_REQUIRE: 'controller:DTOMARK,Trigger check:WIDGETMARK' };

async function snapshot(dir) {
  const out = {};
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p)] = await fs.readFile(p, 'utf8'); } };
  await walk(dir);
  return out;
}

async function runTool(plugin, args, extraEnv = {}) {
  const bin = await tmp('mutate-bin-');
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
  const state = await tmp('mutate-state-');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: state, CLAUDE_CONFIG_DIR: await tmp('mutate-cfg-'), ...fakeEnv, ...extraEnv };
  const r = spawnSync('node', [TOOL, plugin, ...args], { env, encoding: 'utf8' });
  let calls = [];
  try { calls = (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.done); } catch {}
  return { ...r, calls };
}

test('generateMutants: every operator, mapped to config-coverage rule ids, with a plain description', async () => {
  const plugin = await makePlugin();
  const suite = await loadSuite(plugin);
  const ms = await generateMutants(plugin, suite);
  assert.deepEqual(ms.map((m) => m.id), [
    'delete-rule:claude-md/always-run-the-linter-before-you',
    'invert-rule:claude-md/always-run-the-linter-before-you',
    'delete-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark',
    'invert-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark',
    'delete-rule:skill/widgets/never-log-secrets-in-widget-code',
    'invert-rule:skill/widgets/never-log-secrets-in-widget-code',
    'blur-trigger:skill/widgets',
    'drop-skill:skill/widgets',
    'disable-hook:hook/pretooluse-bash',
  ]);
  const by = Object.fromEntries(ms.map((m) => [m.id, m]));
  const del = by['delete-rule:skill/widgets/never-log-secrets-in-widget-code'];
  assert.equal(del.description, "deleted rule 'Never log secrets in widget code, not even at debug level.' from skills/widgets/SKILL.md");
  assert.equal(del.ops[0].content.includes('debug level'), false, 'a wrapped bullet goes with all its lines');
  assert.match(del.ops[0].content, /DTOMARK\)\.\n\nDone\./);
  const inv = by['invert-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark'];
  assert.equal(inv.heuristic, true);
  assert.match(inv.ops[0].content, /Controllers return DTOs, always entities/);
  assert.match(by['invert-rule:claude-md/always-run-the-linter-before-you'].ops[0].content, /- Never run the linter/);
  const blur = by['blur-trigger:skill/widgets'].ops[0].content;
  assert.match(blur, new RegExp(`^---\\nname: widgets\\ndescription: ${BLURRED.replace(/\./g, '\\.')}\\n---\\n`));
  assert.doesNotMatch(blur, /WIDGETMARK/);
  const drop = by['drop-skill:skill/widgets'];
  assert.deepEqual(drop.ops.map((o) => [o.path, !!o.remove]), [['skills/widgets', true], ['.claude-plugin/plugin.json', false]]);
  assert.deepEqual(JSON.parse(drop.ops[1].content).skills, []);
  const hook = by['disable-hook:hook/pretooluse-bash'];
  assert.deepEqual(JSON.parse(hook.ops[0].content), { hooks: {} });
  assert.match(hook.description, /^disabled hook PreToolUse on Bash \(node .*guard\.mjs\) in hooks\/hooks\.json$/);
  assert.deepEqual((await generateMutants(plugin, suite, { operators: ['drop-skill'] })).map((m) => m.operator), ['drop-skill']);
});

test('relevantCases: covers.yaml for rules; covers or a mention for skills and hooks; nothing for an untested rule', async () => {
  const plugin = await makePlugin();
  const suite = await loadSuite(plugin);
  const rel = Object.fromEntries((await generateMutants(plugin, suite)).map((m) => [m.id, relevantCases(m, suite.cases)]));
  assert.deepEqual(rel['delete-rule:claude-md/always-run-the-linter-before-you'], []);
  assert.deepEqual(rel['delete-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark'], ['controller']);
  assert.deepEqual(rel['blur-trigger:skill/widgets'], ['controller', 'secrets', 'trigger'], 'trigger only mentions the skill in its grader');
  assert.deepEqual(rel['disable-hook:hook/pretooluse-bash'], ['guard']);
});

test('blurDescription and invertLines: block scalars collapse to one line, case is kept, must not before must', () => {
  assert.equal(blurDescription('---\nname: x\ndescription: >\n  long\n  text\nother: 1\n---\nbody'), `---\nname: x\ndescription: ${BLURRED}\nother: 1\n---\nbody`);
  assert.equal(blurDescription('no frontmatter'), null);
  assert.equal(invertLines(['You must not push.'], 0, 0).lines[0], 'You must push.');
  assert.equal(invertLines(['**NEVER** skip tests'], 0, 0).lines[0], '**ALWAYS** skip tests');
  assert.equal(invertLines(["Don't use Lombok"], 0, 0).lines[0], 'Do use Lombok');
  assert.equal(invertLines(['Use records.'], 0, 0), null);
});

test('sampleMutants: reproducible for a seed, round-robin across operators, generation order kept', () => {
  const ms = OPERATORS.flatMap((op) => Array.from({ length: 4 }, (_, i) => ({ id: `${op}-${i}`, operator: op })));
  const a = sampleMutants(ms, 5, 'x'), b = sampleMutants(ms, 5, 'x');
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
  assert.deepEqual(a.map((m) => m.operator), OPERATORS, 'one per operator');
  assert.deepEqual(a, [...a].sort((p, q) => ms.indexOf(p) - ms.indexOf(q)));
  const picks = new Set(['1', '2', '3', '4', '5'].map((seed) => sampleMutants(ms, 10, seed).map((m) => m.id).join()));
  assert.ok(picks.size > 1, 'other seeds pick other mutants');
  assert.equal(sampleMutants(ms, 99, 'x'), ms);
});

test('materialize: edits land in a copy with only the chosen cases; the original is untouched', async () => {
  const plugin = await makePlugin();
  const before = await snapshot(plugin);
  const suite = await loadSuite(plugin);
  const drop = (await generateMutants(plugin, suite, { operators: ['drop-skill'] }))[0];
  const copy = await materialize(plugin, { ops: drop.ops, cases: ['controller'] });
  assert.equal(existsSync(path.join(copy.dir, 'skills/widgets')), false);
  assert.deepEqual((await fs.readdir(path.join(copy.dir, 'evals'))).sort(), ['controller']);
  assert.equal(existsSync(path.join(copy.dir, 'hooks/guard.mjs')), true);
  await assert.rejects(materialize(plugin, { ops: [{ path: '../escape', content: 'x' }] }), /outside the copy/);
  await copy.cleanup();
  assert.deepEqual(await snapshot(plugin), before);
});

test('summarize and renderers: score, the plain sentence, gaps listed apart from weak tests', () => {
  const m = (status, extra) => ({ status, operator: 'delete-rule', relevant: status === 'uncovered' ? [] : ['c'], cases: [], killedBy: [], costUsd: 0.1, description: `mutant ${status}`, id: `id-${status}`, ...extra });
  const results = [m('killed', { ruleId: 'skill/a/one', cases: [{ dir: 'c', status: 'regressed', before: 1, after: 0 }] }), m('survived', { ruleId: 'skill/a/two' }), m('uncovered', { ruleId: 'claude-md/x' }), m('uncovered', { operator: 'invert-rule', ruleId: 'claude-md/x', heuristic: true }), m('unrun', { operator: 'disable-hook', hook: 'hook/pretooluse-bash' })];
  const s = summarize(results);
  assert.deepEqual([s.killed, s.survived, s.uncovered, s.unrun, s.judged], [1, 1, 2, 1, 4]);
  assert.equal(s.score, 0.25);
  assert.equal(s.sentence, 'Your suite catches 1 of 4 sabotages. Nothing tests: rule claude-md/x. Tested but not caught: rule skill/a/two. 1 mutant did not run (budget).');
  assert.equal(summarize([]).score, null);
  const j = mutateJson({ mutants: results, reference: { source: 'run', costUsd: 0.3 }, spent: 0.7, budget: 5, runs: 1, full: false, threshold: 0.15 }, { suite: 'widget-kit', generatedAt: '2026-10-24T10:00:00Z', generated: 9, seed: '1' });
  const html = renderMutateHtml(j);
  assert.match(html, /Catches 1 of 4 sabotages/);
  assert.match(html, /Nothing tests these/);
  assert.match(html, /2 mutants had no case that tests them\. 1 stayed green under a case that claims it\. 1 did not run \(budget\)\./);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /<b>c<\/b> <span class="from">1\.00 to 0\.00<\/span>/);
  assert.match(html, /sampled from 9/);
  assert.doesNotMatch(html, /<script/);
  assert.match(renderMutateMd(j), /\| caught \| delete-rule \| mutant killed \| c \(1\.00 to 0\.00\) \| \$0\.10 \|/);
  for (const text of [html, renderMutateMd(j), s.sentence]) assert.doesNotMatch(text, /[\u2013\u2014~]/, 'no en or em dashes, no tildes');
});

test('CLI end to end with the fake claude: caught, missed and untested mutants; the original never changes', async () => {
  const plugin = await makePlugin();
  const before = await snapshot(plugin);
  const out = await tmp('mutate-out-');
  const r = await runTool(plugin, ['--runner', 'shim', '--json', path.join(out, 'm.json'), '--html', path.join(out, 'm.html'), '--md', '-', '--out-dir', path.join(out, 'runs')]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(await fs.readFile(path.join(out, 'm.json'), 'utf8'));
  const st = Object.fromEntries(j.mutants.map((m) => [m.id, m.status]));
  assert.deepEqual(st, {
    'delete-rule:claude-md/always-run-the-linter-before-you': 'uncovered',
    'invert-rule:claude-md/always-run-the-linter-before-you': 'uncovered',
    'delete-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark': 'killed',
    'invert-rule:skill/widgets/controllers-return-dtos-never-entities-dtomark': 'survived',
    'delete-rule:skill/widgets/never-log-secrets-in-widget-code': 'survived',
    'invert-rule:skill/widgets/never-log-secrets-in-widget-code': 'survived',
    'blur-trigger:skill/widgets': 'killed',
    'drop-skill:skill/widgets': 'killed',
    'disable-hook:hook/pretooluse-bash': 'survived',
  });
  const blur = j.mutants.find((m) => m.operator === 'blur-trigger');
  assert.deepEqual(blur.killedBy, ['trigger']);
  assert.deepEqual(j.mutants.find((m) => m.operator === 'drop-skill').killedBy, ['controller', 'trigger']);
  assert.deepEqual(j.reference.cases.map((c) => [c.dir, c.score]), [['controller', 1], ['guard', 1], ['secrets', 1], ['trigger', 1]]);
  assert.equal(j.summary.score, 3 / 9);
  assert.match(j.summary.sentence, /^Your suite catches 3 of 9 sabotages\. Nothing tests: rule claude-md\/always-run-the-linter-before-you\. Tested but not caught: /);
  // reference 4 cases, then 1 + 1 + 1 + 1 + 3 + 3 + 1 for the mutants that have a relevant case
  assert.equal(r.calls.length, 15);
  assert.equal(j.spent.toFixed(2), '1.50');
  assert.match(r.stdout, /^### Mutation test: widget-kit/);
  assert.match(await fs.readFile(path.join(out, 'm.html'), 'utf8'), /Catches 3 of 9 sabotages/);
  assert.equal(existsSync(path.join(out, 'runs', 'reference.json')), true, '--out-dir keeps the reference for a later --baseline');
  assert.deepEqual(await snapshot(plugin), before, 'the original plugin is never touched');
  // every agent run loaded a temp copy, never the plugin itself
  const dirs = r.calls.map((c) => c.args[c.args.indexOf('--plugin-dir') + 1]);
  assert.ok(dirs.every((d) => d && !d.startsWith(plugin)));
});

test('CLI --baseline skips the reference run; --budget stops starting mutants and marks them not run', async () => {
  const plugin = await makePlugin();
  const base = await tmp('mutate-base-');
  const baseline = { cases: ['controller', 'secrets', 'trigger', 'guard'].map((dir) => ({ dir, summary: { score: 1 }, arms: { with: [{ score: 1 }] } })), aggregates: { totalRuns: 4, erroredRuns: 0 } };
  await fs.writeFile(path.join(base, 'b.json'), JSON.stringify(baseline));
  const a = await runTool(plugin, ['--runner', 'shim', '--operators', 'delete-rule', '--baseline', path.join(base, 'b.json'), '--json', '-']);
  assert.equal(a.status, 0, a.stderr);
  const ja = JSON.parse(a.stdout);
  assert.equal(ja.reference.source, 'baseline');
  assert.equal(a.calls.length, 2, 'only the two covered delete-rule mutants ran');
  assert.deepEqual(ja.mutants.map((m) => m.status), ['uncovered', 'killed', 'survived']);

  const b = await runTool(plugin, ['--runner', 'shim', '--budget', '0.55', '--json', '-']);
  assert.equal(b.status, 0, b.stderr);
  const jb = JSON.parse(b.stdout);
  assert.deepEqual(jb.mutants.map((m) => m.status), ['uncovered', 'uncovered', 'killed', 'survived', 'unrun', 'unrun', 'unrun', 'unrun', 'unrun']);
  assert.match(jb.mutants[4].note, /budget \$0\.55 spent before this mutant/);
  assert.match(jb.summary.sentence, /5 mutants did not run \(budget\)\./);
  assert.equal(b.calls.length, 6);
});

test('CLI --full runs the rest of the suite on what the relevant cases missed; an untested mutant stays a gap', async () => {
  const plugin = await makePlugin();
  const r = await runTool(plugin, ['--runner', 'shim', '--operators', 'delete-rule', '--full', '--concurrency', '2', '--json', '-']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.mutants.map((m) => [m.status, m.cases.length]), [['uncovered', 4], ['killed', 1], ['survived', 4]]);
  assert.equal(r.calls.length, 4 + 4 + 1 + 4, 'the killed mutant never ran past its relevant case');
});

test('CLI --dry-run and --max-mutants: lists a reproducible sample with a cost estimate from history, runs nothing', async () => {
  const plugin = await makePlugin();
  const r = await runTool(plugin, ['--dry-run', '--max-mutants', '5', '--seed', '7', '--json', '-']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, true);
  assert.equal(j.mutants.length, 5);
  assert.deepEqual([...new Set(j.mutants.map((m) => m.operator))].sort(), [...OPERATORS].sort());
  assert.match(r.stderr, /Mutants: 5 of 9 \(seed 7\)/);
  assert.match(r.stderr, /Estimated cost: about \$\d+\.\d\d/);
  assert.match(r.stderr, /Dry run: nothing run, \$0 spent\./);
  const again = await runTool(plugin, ['--dry-run', '--max-mutants', '5', '--seed', '7', '--json', '-']);
  assert.deepEqual(JSON.parse(again.stdout).mutants.map((m) => m.id), j.mutants.map((m) => m.id));
  const bad = await runTool(plugin, ['--operators', 'nope', '--dry-run']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--operators takes a comma list/);
});
