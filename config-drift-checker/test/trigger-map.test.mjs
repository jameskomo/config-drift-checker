import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wilson, parsePromptFile, evalExpectations, pluginSkills, buildPromptSet, interleave, readRun, analyse, verdictFor, renderHtml, renderMd, descriptionKey, cacheHit, parseGenerated, perCall, generationPrompt } from '../tools/trigger-map.mjs';

const TOOL = new URL('../tools/trigger-map.mjs', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const close = (a, b, eps = 0.002) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

const SPRING = { name: 'spring-api', description: 'House rules for Spring Boot REST controllers and DTOs. Use when the user writes a Spring endpoint. Do not use for Vue or Go.' };
const REVIEW = { name: 'api-review', description: 'Reviews an HTTP API change for naming and status codes. Use when the user asks for a review of an API. Not for writing new code.' };

// two skills, an in-scope trigger case, a negative trigger case, and a case with no Skill grader
async function makePlugin() {
  const dir = await tmp('tm-plugin-');
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.1' }));
  for (const s of [SPRING, REVIEW]) {
    await fs.mkdir(path.join(dir, 'skills', s.name), { recursive: true });
    await fs.writeFile(path.join(dir, 'skills', s.name, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\nRules.\n`);
  }
  const kase = async (name, prompt, graders) => {
    await fs.mkdir(path.join(dir, 'evals', name, 'graders'), { recursive: true });
    await fs.writeFile(path.join(dir, 'evals', name, 'prompt.md'), `---\nruns: 3\n---\n${prompt}\n`);
    for (const [g, body] of Object.entries(graders)) await fs.writeFile(path.join(dir, 'evals', name, 'graders', g), body);
  };
  await kase('spring-trigger', 'Sketch a Spring endpoint for invoices [spring]', { 'fired.md': '---\ntype: tool_used\ntool: Skill\ninput_match: spring-api\nmin: 1\n---\nFires.\n' });
  await kase('vue-negative', 'Write a Pinia store for a cart', { 'not-fired.md': '---\ntype: tool_used\ntool: Skill\ninput_match: spring-api\nmin: 0\nmax: 0\narm: both\n---\nStays out.\n' });
  await kase('unrelated', 'Run git status', { 'done.md': '---\ntype: regex\npattern: DONE\n---\nx\n' });
  return dir;
}

const PROMPTS_YAML = `# my prompts
spring-api:
  fire:
    - Add a POST endpoint for customers [spring]
    - "Write a controller for orders, see issue #12 [spring]"
    - Refactor this controller [review]
  no_fire:
    - Write a Pinia store
    - Review this Go handler [spring]
api-review:
  fire: [review my PR [review], 'audit the endpoint [simplify]']
not-a-skill:
  fire:
    - ignored
`;
const GENERATED = {
  'Skill name: spring-api': JSON.stringify({ fire: ['gen spring one [spring]', 'gen spring two'], no_fire: ['gen vue store'] }),
  'Skill name: api-review': 'Here you go: ' + JSON.stringify({ fire: ['gen review [review]'], no_fire: ['gen format code'] }),
};
const MARKERS = { '[spring]': 'fixture-plugin:spring-api', '[review]': 'fixture-plugin:api-review', '[simplify]': 'simplify' };

async function runTool(plugin, args = [], env = {}, { state = null } = {}) {
  const bin = await tmp('tm-bin-');
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
  state ??= await tmp('tm-state-');
  const userCfg = await tmp('tm-usercfg-');
  const r = spawnSync('node', [TOOL, plugin, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: state, CLAUDE_CONFIG_DIR: userCfg, FAKE_CLAUDE_COST: '0.001', FAKE_CLAUDE_SKILLS: JSON.stringify(MARKERS), FAKE_CLAUDE_JSON_REPLY: JSON.stringify(GENERATED), ...env } });
  const read = async (f) => { try { return (await fs.readFile(path.join(state, f), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { ...r, state, userCfg, calls: (await read('calls.jsonl')).filter((e) => !e.done), jsonCalls: await read('json-calls.jsonl') };
}
const argOf = (call, flag) => call.args[call.args.indexOf(flag) + 1];

test('wilson: matches the textbook interval, including at 0 and n', () => {
  assert.equal(wilson(0, 0), null);
  const a = wilson(0, 8); close(a.low, 0); close(a.high, 0.3244);
  const b = wilson(5, 10); close(b.low, 0.2366); close(b.high, 0.7634);
  const c = wilson(10, 10); close(c.low, 0.7225); close(c.high, 1);
  const d = wilson(13, 21); close(d.low, 0.4093); close(d.high, 0.7924);
});

test('parsePromptFile: block and flow lists, quotes, # inside items, multi-line and block items, JSON, errors with a line', () => {
  const p = parsePromptFile(PROMPTS_YAML);
  assert.deepEqual(p['spring-api'].fire, ['Add a POST endpoint for customers [spring]', 'Write a controller for orders, see issue #12 [spring]', 'Refactor this controller [review]']);
  assert.deepEqual(p['spring-api'].no_fire, ['Write a Pinia store', 'Review this Go handler [spring]']);
  assert.deepEqual(p['api-review'].fire, ['review my PR [review]', 'audit the endpoint [simplify]']);
  const q = parsePromptFile('s:\n  no-fire:\n    - a plain item that\n      wraps onto a second line\n    - |\n      line one\n      line two\n    - >\n      folded\n      text\n');
  assert.deepEqual(q.s.no_fire, ['a plain item that wraps onto a second line', 'line one\nline two', 'folded text']);
  assert.deepEqual(parsePromptFile('{"s": {"fire": ["x"], "no_fire": []}}'), { s: { fire: ['x'], no_fire: [] } });
  assert.throws(() => parsePromptFile('s:\n  - orphan\n', 'p.yaml'), /p\.yaml:2: a list item must sit under fire: or no_fire:/);
  assert.throws(() => parsePromptFile('s:\n  maybe:\n    - x\n'), /expected fire: or no_fire:/);
  assert.throws(() => parsePromptFile('just text'), /expected "<skill-name>:"/);
});

test('evalExpectations: a Skill grader with min 1 is an in-scope prompt, max 0 an out-of-scope one; other cases are ignored', async () => {
  const dir = await makePlugin();
  const plugin = await pluginSkills(dir);
  assert.deepEqual(plugin.skills.map((s) => s.name), ['api-review', 'spring-api']);
  const ex = await evalExpectations(dir, plugin);
  assert.deepEqual(ex, [
    { skill: 'spring-api', expect: 'fire', text: 'Sketch a Spring endpoint for invoices [spring]', source: 'eval:spring-trigger' },
    { skill: 'spring-api', expect: 'no_fire', text: 'Write a Pinia store for a cart', source: 'eval:vue-negative' },
  ]);
});

test('buildPromptSet merges a text shared by sources; interleave spreads skills evenly', () => {
  const set = buildPromptSet([
    { skill: 'a', expect: 'fire', text: 'one', source: 'file' }, { skill: 'a', expect: 'fire', text: ' One ', source: 'generated' },
    { skill: 'b', expect: 'no_fire', text: 'one', source: 'file' }, { skill: 'a', expect: 'fire', text: 'two', source: 'file' },
    { skill: 'b', expect: 'fire', text: 'three', source: 'file' }, { skill: 'a', expect: 'fire', text: '', source: 'file' },
  ]);
  assert.equal(set.length, 3);
  assert.deepEqual(set[0].expect, [{ skill: 'a', expect: 'fire', sources: ['file', 'generated'] }, { skill: 'b', expect: 'no_fire', sources: ['file'] }]);
  assert.deepEqual(interleave(set).map((p) => p.text), ['one', 'three', 'two']);
});

test('readRun: a max-turns stop after a Skill call is a clean run; plugin prefixes are stripped; errors without a call count as errors', () => {
  const ctx = { pluginName: 'fixture-plugin', names: ['spring-api', 'api-review'] };
  const ev = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n');
  const skill = (s) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: s } }] } });
  const r1 = readRun(ev({ type: 'system', subtype: 'init', model: 'm', skills: ['fixture-plugin:spring-api'] }, skill('fixture-plugin:spring-api'), { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.0015, modelUsage: { 'claude-haiku-5-5': {} } }), ctx);
  assert.deepEqual(r1.fired, ['spring-api']); assert.equal(r1.error, null); assert.equal(r1.costUsd, 0.0015); assert.equal(r1.model, 'claude-haiku-5-5');
  assert.deepEqual(r1.available, ['fixture-plugin:spring-api']);
  const r2 = readRun(ev(skill('simplify'), skill('fixture-plugin:api-review'), { type: 'result', subtype: 'success', is_error: false }), ctx);
  assert.deepEqual(r2.fired, ['simplify', 'api-review']);
  const r3 = readRun(ev({ type: 'result', subtype: 'success', is_error: false, result: 'Here is the code' }), ctx);
  assert.deepEqual(r3.fired, []); assert.equal(r3.error, null);
  assert.equal(readRun(ev({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low' }), ctx).error, 'Credit balance is too low');
  assert.equal(readRun('', ctx).error, 'no result from claude');
});

// a hand-built measurement: spring-api hits 13 of 21, three of its prompts went to api-review
function scenario() {
  const prompts = [], trials = [];
  const add = (skill, expect, text, fired) => { const id = `p${prompts.length + 1}`; prompts.push({ id, text, expect: [{ skill, expect, sources: ['file'] }] }); trials.push({ prompt: id, run: 0, fired, error: null }); };
  for (let i = 0; i < 13; i++) add('spring-api', 'fire', `spring ${i}`, ['spring-api']);
  for (let i = 0; i < 3; i++) add('spring-api', 'fire', `refactor ${i}`, ['api-review']);
  for (let i = 0; i < 5; i++) add('spring-api', 'fire', `quiet ${i}`, []);
  for (let i = 0; i < 8; i++) add('spring-api', 'no_fire', `vue ${i}`, []);
  for (let i = 0; i < 9; i++) add('api-review', 'fire', `review ${i}`, ['api-review']);
  add('api-review', 'fire', 'review simplify', ['simplify']);
  add('api-review', 'no_fire', 'format', ['api-review']);
  return { prompts, trials };
}

test('analyse: rates with Wilson intervals, collisions, stolen prompts, statuses and the plain verdicts', () => {
  const { prompts, trials } = scenario();
  const a = analyse({ pluginName: 'fixture-plugin', skills: [SPRING, REVIEW], prompts, trials: [...trials, { prompt: 'p1', run: 1, fired: [], error: 'boom' }] });
  const [sp, rv] = a.skills;
  assert.equal(sp.positives.k, 13); assert.equal(sp.positives.n, 21); close(sp.positives.ci.low, 0.4093);
  assert.deepEqual(sp.collisions.map(({ skill, count, external }) => ({ skill, count, external })), [{ skill: 'api-review', count: 3, external: false }]);
  assert.equal(sp.misses, 5); assert.equal(sp.status, 'misses'); assert.equal(sp.tone, 'warn');
  assert.equal(sp.verdict, 'spring-api fires on 62% of in-scope prompts (13 of 21 prompts, 95% CI 41 to 79%); 3 prompts fired api-review instead; 5 fired no skill. It never fired on its 8 out-of-scope prompts (95% CI 0 to 32%)');
  assert.equal(rv.positives.k, 9); assert.equal(rv.positives.n, 10);
  assert.deepEqual(rv.collisions.map((c) => [c.skill, c.external]), [['simplify', true]]);
  assert.deepEqual(rv.stolen.map((x) => [x.skill, x.count]), [['spring-api', 3]]);
  assert.equal(rv.negatives.k, 1); assert.equal(rv.status, 'leaky');
  assert.match(rv.verdict, /1 prompt fired simplify \(outside the plugin\) instead/);
  assert.match(rv.verdict, /It fired on 1 of 1 out-of-scope prompt \(100%, 95% CI 21 to 100%\)\. It also fired on 3 prompts meant for spring-api$/);
  assert.equal(a.measured.errored, 1);
  // matrix: rows per (skill, fire | no_fire), columns are plugin skills, then outside skills, then none
  assert.deepEqual(a.matrix.columns.map((c) => c.id), ['spring-api', 'api-review', 'simplify', 'none']);
  const row = a.matrix.rows.find((r) => r.skill === 'spring-api' && r.kind === 'fire');
  assert.deepEqual(row, { skill: 'spring-api', kind: 'fire', total: 21, counts: { 'spring-api': 13, 'api-review': 3, none: 5 } });
  assert.deepEqual(a.headline, { tone: 'warn', mark: '◆', text: '2 of 2 skills need attention' }); // worst skill tone: both amber
});

test('analyse: runs say runs, a skill missing from the session is not loaded, and a clean skill is reliable', () => {
  const prompts = [{ id: 'p1', text: 'x', expect: [{ skill: 'spring-api', expect: 'fire', sources: ['file'] }] }, { id: 'p2', text: 'y', expect: [{ skill: 'api-review', expect: 'fire', sources: ['file'] }] }];
  const trials = [0, 1].flatMap((run) => [{ prompt: 'p1', run, fired: run ? ['spring-api', 'run'] : ['spring-api'] }, { prompt: 'p2', run, fired: [] }]);
  const a = analyse({ pluginName: 'fixture-plugin', skills: [SPRING, REVIEW], prompts, trials, runs: 2, available: ['fixture-plugin:spring-api', 'simplify'] });
  assert.equal(a.skills[0].status, 'ok'); assert.equal(a.skills[0].label, 'reliable');
  assert.match(a.skills[0].verdict, /\(2 of 2 runs, 95% CI 34 to 100%\); on 1 it fired together with run$/);
  assert.deepEqual(a.skills[0].coFired.map((c) => [c.skill, c.count, c.external]), [['run', 1, true]]);
  assert.match(a.skills[0].notes[0], /only 2 in-scope runs/);
  assert.equal(a.skills[1].status, 'not-loaded'); assert.match(a.skills[1].verdict, /never loaded/);
  assert.equal(analyse({ pluginName: 'x', skills: [SPRING], prompts: [], trials: [] }).headline.text, 'Nothing measured');
  assert.equal(verdictFor({ name: 's', status: 'no-data', positives: { n: 0 }, negatives: { n: 0 }, collisions: [], misses: 0, stolen: [] }), 's has no in-scope prompts to measure');
});

test('renderHtml / renderMd: self-contained page with both themes and a heatmap; markdown tables', () => {
  const { prompts, trials } = scenario();
  const a = analyse({ pluginName: 'fixture-plugin', skills: [SPRING, REVIEW], prompts, trials });
  const res = { plugin: 'fixture-plugin', generatedAt: '2026-10-24T10:00:00Z', harness: { version: '9.9.9' }, config: { model: 'haiku', runs: 1, maxTurns: 1, budget: 1, minFire: 0.8, maxFalseFire: 0.1 }, resolvedModels: ['claude-haiku-5-5'], spent: 0.05, budget: { skipped: 0 }, sources: { file: prompts.length, evals: 0, generated: 0 }, prompts, trials, ...a };
  const html = renderHtml(res);
  assert.match(html, /prefers-color-scheme:dark/); assert.match(html, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /2 of 2 skills need attention/);
  assert.match(html, /class="hm t-pass hi" style="--a:62%"/); // spring-api's own column on its in-scope row
  assert.match(html, /class="hm t-fail" style="--a:14%"/); // 3 of 21 went to api-review
  assert.match(html, /simplify <i class="tag">other<\/i>/);
  assert.doesNotMatch(html, /[\u2013\u2014~]/);
  const md = renderMd(res);
  assert.match(md, /\| spring-api \| misses in-scope work \| 62% \(13\/21\) \| 41 to 79% \| 0% \(0\/8\) \| 0 to 32% \| api-review ×3 \|/);
  assert.match(md, /\| for spring-api \| 13 \| 3 \| 0 \| 5 \|/);
});

test('generation helpers: prompt names the skill, replies are parsed and trimmed, cache entries follow the description', () => {
  assert.match(generationPrompt(SPRING, 4), /Skill name: spring-api[\s\S]*Write 4 in-scope prompts[\s\S]*Write 4 adjacent out-of-scope prompts/);
  assert.deepEqual(parseGenerated('sure: {"fire": ["a", " ", "b", "c"], "no_fire": ["d"]}', 2), { fire: ['a', 'b'], no_fire: ['d'] });
  assert.throws(() => parseGenerated('no json here', 2), /no JSON object/);
  const cache = { skills: { 'spring-api': { key: descriptionKey(SPRING), count: 5, fire: [], no_fire: [] } } };
  assert.ok(cacheHit(cache, SPRING, 5)); assert.ok(cacheHit(cache, SPRING, 3));
  assert.equal(cacheHit(cache, SPRING, 6), null);
  assert.equal(cacheHit(cache, { ...SPRING, description: SPRING.description + ' Changed.' }, 5), null);
  assert.equal(perCall('claude-haiku-5-5').family, 'haiku'); assert.equal(perCall('mystery').family, null);
});

test('end to end with the fake claude: three sources, isolated cheap runs, rates, collisions, cached generation', async () => {
  const dir = await makePlugin();
  const pf = path.join(await tmp('tm-p-'), 'prompts.yaml');
  await fs.writeFile(pf, PROMPTS_YAML);
  const out = await tmp('tm-out-');
  const args = ['--prompts', pf, '--generate', '2', '--json', path.join(out, 'm.json'), '--md', path.join(out, 'm.md'), '--html', path.join(out, 'm.html'), '-j', '3'];
  const r = await runTool(dir, args);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(await fs.readFile(path.join(out, 'm.json'), 'utf8'));
  // generation: one json call per skill on the judge model, no tools, isolated config
  assert.equal(r.jsonCalls.length, 2);
  assert.ok(r.jsonCalls.every((c) => argOf(c, '--model') === 'haiku' && argOf(c, '--tools') === '' && c.configDir !== r.userCfg));
  const cache = JSON.parse(await fs.readFile(path.join(dir, '.cdc-trigger-prompts.json'), 'utf8'));
  assert.deepEqual(cache.skills['spring-api'].fire, ['gen spring one [spring]', 'gen spring two']);
  assert.equal(cache.skills['api-review'].key, descriptionKey(REVIEW));
  // measurement: every prompt once, Skill-only, one turn, plugin loaded, fresh config dir and empty cwd per call
  assert.equal(res.prompts.length, 14);
  assert.equal(r.calls.length, 14);
  for (const c of r.calls) {
    assert.equal(argOf(c, '--max-turns'), '1'); assert.equal(argOf(c, '--tools'), 'Skill'); assert.equal(argOf(c, '--model'), 'haiku');
    assert.ok(c.args.includes('--strict-mcp-config')); assert.equal(argOf(c, '--plugin-dir'), dir);
    assert.notEqual(c.configDir, r.userCfg);
  }
  assert.equal(new Set(r.calls.map((c) => c.cwd)).size, 14);
  assert.deepEqual(res.sources, { file: 7, evals: 2, generated: 5 });
  const sp = res.skills.find((s) => s.name === 'spring-api'), rv = res.skills.find((s) => s.name === 'api-review');
  assert.deepEqual([sp.positives.k, sp.positives.n, sp.negatives.k, sp.negatives.n, sp.misses], [4, 6, 1, 4, 1]);
  assert.deepEqual(sp.collisions.map((c) => [c.skill, c.count]), [['api-review', 1]]);
  assert.deepEqual(sp.falseFirePrompts, ['Review this Go handler [spring]']);
  assert.deepEqual([rv.positives.k, rv.positives.n, rv.negatives.k, rv.negatives.n], [2, 3, 0, 1]);
  assert.deepEqual(rv.collisions.map((c) => [c.skill, c.external]), [['simplify', true]]);
  assert.deepEqual(rv.stolen.map((x) => [x.skill, x.count]), [['spring-api', 1]]);
  close(res.spent, 0.016, 1e-9); // 2 generation calls + 14 measurement calls at $0.001
  assert.match(r.stdout, /spring-api fires on 67% of in-scope prompts \(4 of 6 prompts, 95% CI 30 to 90%\); 1 prompt fired api-review instead; 1 fired no skill/);
  assert.match(r.stderr, /"not-a-skill" is not a skill of fixture-plugin/);
  assert.match(await fs.readFile(path.join(out, 'm.md'), 'utf8'), /### Trigger map: fixture-plugin/);
  assert.match(await fs.readFile(path.join(out, 'm.html'), 'utf8'), /fixture-plugin trigger map/);

  // a rerun reuses the cache: no generation calls; --regenerate makes them again
  const again = await runTool(dir, ['--prompts', pf, '--generate', '2', '--json', '-']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.jsonCalls.length, 0);
  assert.equal(JSON.parse(again.stdout).prompts.length, 14);
  const regen = await runTool(dir, ['--generate', '2', '--regenerate', '--no-evals', '--skill', 'api-review']);
  assert.equal(regen.jsonCalls.length, 1);
  assert.equal(regen.calls.length, 2);
});

test('budget: no call starts once spend plus what is in flight would pass the cap; skills are interleaved', async () => {
  const dir = await makePlugin();
  const pf = path.join(await tmp('tm-p-'), 'prompts.yaml');
  await fs.writeFile(pf, PROMPTS_YAML);
  const r = await runTool(dir, ['--prompts', pf, '--no-generate', '--no-evals', '--budget', '0.25', '-j', '1', '--json', '-'], { FAKE_CLAUDE_COST: '0.1' });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(res.budget, { capUsd: 0.25, spentUsd: res.spent, exceeded: true, skipped: 5 });
  close(res.spent, 0.2, 1e-9);
  // the first two calls cover two different groups, not two prompts of one skill
  const firstTwo = res.trials.map((t) => res.prompts.find((p) => p.id === t.prompt).expect[0]);
  assert.notDeepEqual(firstTwo[0], firstTwo[1]);
  assert.match(r.stderr, /budget: .* not starting more/);
});

test('--dry-run counts prompts per source and estimates the cost without calling anything', async () => {
  const dir = await makePlugin();
  const pf = path.join(await tmp('tm-p-'), 'prompts.yaml');
  await fs.writeFile(pf, PROMPTS_YAML);
  const r = await runTool(dir, ['--prompts', pf, '--generate', '3', '--runs', '2', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length + r.jsonCalls.length, 0);
  assert.match(r.stdout, /spring-api: in scope 3 yours, 1 from evals, 0 cached; out of scope 2 yours, 1 from evals, 0 cached \+ 3 in \/ 3 out to generate/);
  assert.match(r.stdout, /21 prompts × 2 runs = 42 measurement calls on haiku, plus 2 generation calls on haiku/);
  assert.match(r.stdout, /Estimated cost: about \$0\.\d+ .*per 100 prompts/);
  assert.match(r.stdout, /Dry run: nothing called, \$0 spent\./);
  assert.equal(existsSync(path.join(dir, '.cdc-trigger-prompts.json')), false);
});

test('a skill missing from the session skill list is reported as not loaded; all-error runs exit 1; usage errors exit 2', async () => {
  const dir = await makePlugin();
  const nl = await runTool(dir, ['--no-generate', '--json', '-'], { FAKE_CLAUDE_INIT_SKILLS: 'fixture-plugin:api-review,simplify' });
  assert.equal(nl.status, 0, nl.stderr);
  const res = JSON.parse(nl.stdout);
  assert.equal(res.skills.find((s) => s.name === 'spring-api').status, 'not-loaded');
  assert.deepEqual(res.available, ['fixture-plugin:api-review', 'simplify']);

  const err = await runTool(dir, ['--no-generate'], { FAKE_CLAUDE_ERROR: '0,1' });
  assert.equal(err.status, 1);
  assert.match(err.stdout, /Nothing measured/);

  for (const bad of [['--runs', '0'], ['--budget', '0'], ['--concurrency', '9'], ['--skill', 'nope'], ['--bogus'], ['--json', '-', '--md', '-']]) {
    const u = await runTool(dir, bad);
    assert.equal(u.status, 2, `${bad.join(' ')}: ${u.stderr}`);
  }
  const none = await runTool(dir, ['--no-generate', '--no-evals']);
  assert.equal(none.status, 1); assert.match(none.stderr, /no prompts to run/);
});
