import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATUS, parseSince, globToRegExp, invocationsIn, scanTranscripts, parseSkillDoctor, invokedAs, usageCheck, formatText, markdown, renderHtml } from '../tools/usage-check.mjs';

const TOOL = new URL('../tools/usage-check.mjs', import.meta.url).pathname;
const FIX = new URL('./fixtures/usage-check/', import.meta.url).pathname;
const TRANSCRIPTS = path.join(FIX, 'transcripts');
const SINCE = '2026-09-01';
const SECRETS = /SECRET|billing|refactor|home-dev|\/home\/dev/;
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\nrubric\n`;
const skill = (name) => `---\nname: ${name}\ndescription: Do the ${name} work in house style. Use when the user asks for ${name}. Do not use for anything else.\n---\n# ${name}\n\n- Follow the ${name} rules every time.\n`;

// The "shop" plugin: alpha is used and tested, beta tested but only used before the window, gamma used
// but only has a negative case, delta is dead weight, epsilon is covered by a covers.yaml id only.
async function shopPlugin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-check-'));
  const files = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'shop', version: '0.1.0' }),
    ...Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((n) => [`skills/${n}/SKILL.md`, skill(n)])),
    'evals/alpha-fires/prompt.md': 'Write the alpha thing.\n',
    'evals/alpha-fires/graders/fired.md': fm({ type: 'tool_used', tool: 'Skill', input_match: 'alpha', min: 1 }),
    'evals/beta-fires/prompt.md': 'Write the beta thing.\n',
    'evals/beta-fires/graders/fired.md': fm({ type: 'tool_used', tool: 'Skill', input_match: 'shop:beta', min: 1 }),
    'evals/gamma-negative/prompt.md': 'Write a Vue store.\n',
    'evals/gamma-negative/graders/not-fired.md': fm({ type: 'tool_used', tool: 'Skill', input_match: 'gamma', min: 0, max: 0, arm: 'both' }),
    'evals/epsilon-content/prompt.md': 'Write the epsilon thing.\n',
    'evals/epsilon-content/covers.yaml': '[skill/epsilon/follow-the-epsilon-rules-every-time]\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const shimResult = (verdict) => ({ schemaVersion: '1.1', generatedAt: '2026-10-08T00:00:00Z', suite: { name: 'shop' }, cases: [
  { dir: 'beta-fires', graders: [{ name: 'fired', type: 'tool_used', tool: 'Skill', input_match: 'shop:beta', min: 1 }],
    arms: { with: [{ score: 1, graders: [{ name: 'fired', type: 'tool_used', verdict }] }] }, summary: { score: 1 } },
] });
const row = (r, name) => r.rows.find((x) => x.skill === name);
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('parseSince takes relative windows and ISO dates, and rejects anything else', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  assert.equal(parseSince('30d', now), Date.parse('2026-09-09T00:00:00Z'));
  assert.equal(parseSince('2w', now), Date.parse('2026-09-25T00:00:00Z'));
  assert.equal(parseSince('12h', now), Date.parse('2026-10-08T12:00:00Z'));
  assert.equal(parseSince('2026-09-01', now), Date.parse('2026-09-01'));
  assert.throws(() => parseSince('last month', now), /--since/);
  assert.ok(globToRegExp('*shop*').test('-home-dev-shop'));
  assert.ok(!globToRegExp('*shop').test('-home-dev-shop-api'));
});

test('invocationsIn keeps only the skill name, an id and the time', () => {
  const model = invocationsIn({ type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { content: [{ type: 'text', text: 'SECRET' }, { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'shop:alpha', args: 'SECRET' } }] } });
  assert.deepEqual(model, [{ name: 'shop:alpha', kind: 'model', id: 't1', at: Date.parse('2026-10-01T00:00:00Z') }]);
  const legacy = invocationsIn({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { command: 'beta' } }] } });
  assert.equal(legacy[0].name, 'beta', 'older transcripts name the skill in input.command');
  const typed = invocationsIn({ type: 'user', uuid: 'u1', message: { content: '<command-name>/shop:gamma</command-name><command-args>SECRET</command-args>' } });
  assert.deepEqual(typed.map((i) => [i.name, i.kind]), [['shop:gamma', 'user']]);
  assert.deepEqual(invocationsIn({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a prompt with spaces' } }] } }), [], 'a non-name is never copied out');
  assert.deepEqual(invocationsIn(null), []);
});

test('scanTranscripts streams the fixtures: window, dedup, sub-agent files, malformed lines, project filter', async () => {
  const since = Date.parse(SINCE);
  const { stats, byName } = await scanTranscripts({ root: TRANSCRIPTS, since });
  assert.equal(stats.files, 4);
  assert.equal(stats.projects, 2);
  assert.equal(stats.malformed, 2, 'the truncated line and the non-JSON line are counted, not fatal');
  assert.deepEqual(byName.get('shop:alpha'), { model: 2, user: 0, first: Date.parse('2026-10-01T10:00:05Z'), last: Date.parse('2026-10-06T10:00:00Z') }, 'toolu_1 repeated in the resumed file counts once');
  assert.equal(byName.get('gamma').model, 1);
  assert.equal(byName.get('shop:gamma').model, 1, 'sub-agent transcripts are read');
  assert.equal(byName.get('shop:gamma').user, 1, 'a typed /shop:gamma counts as a real use');
  assert.equal(byName.has('shop:beta'), false, 'an invocation before the window is ignored');
  const filtered = await scanTranscripts({ root: TRANSCRIPTS, since, projects: '*shop' });
  assert.equal(filtered.stats.projects, 1);
  assert.equal(filtered.byName.get('shop:alpha').model, 1);
  const missing = await scanTranscripts({ root: path.join(FIX, 'nope'), since });
  assert.equal(missing.stats.found, false);
});

test('scanTranscripts skips files last written before the window without reading them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-old-'));
  await fs.mkdir(path.join(root, 'p'));
  const f = path.join(root, 'p', 'old.jsonl');
  await fs.writeFile(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: 'alpha' } }] } }) + '\n');
  const old = new Date('2026-01-01T00:00:00Z');
  await fs.utimes(f, old, old);
  const { stats, byName } = await scanTranscripts({ root, since: Date.parse(SINCE) });
  assert.equal(stats.skippedOld, 1); assert.equal(stats.files, 0); assert.equal(byName.size, 0);
});

test('parseSkillDoctor reads the /skill-doctor table, including a source column with spaces', async () => {
  const rows = parseSkillDoctor(await fs.readFile(path.join(FIX, 'skill-doctor.txt'), 'utf8'));
  assert.deepEqual(rows.map((r) => r.name), ['anthropic-skills:docs', 'shop:delta', 'shop:alpha', 'shop:gamma']);
  assert.deepEqual(rows[0], { name: 'anthropic-skills:docs', source: 'claude.ai sync', contextTokens: 340, weekTokens: null, uses: 0, daysSinceUse: null });
  assert.equal(rows[2].weekTokens, 1200); assert.equal(rows[2].daysSinceUse, 0);
  assert.equal(rows[3].daysSinceUse, 3); assert.equal(rows[3].uses, 12);
});

test('invokedAs: bare and namespaced names match; another plugin with the same skill name does not', () => {
  assert.ok(invokedAs('alpha', 'alpha', 'shop'));
  assert.ok(invokedAs('shop:alpha', 'alpha', 'shop'));
  assert.ok(!invokedAs('other-plugin:alpha', 'alpha', 'shop'));
  assert.ok(!invokedAs('alphabet', 'alpha', 'shop'));
});

test('usageCheck sorts every skill into the four verdicts', async () => {
  const r = await usageCheck(await shopPlugin(), { result: shimResult('pass'), since: SINCE, transcripts: TRANSCRIPTS });
  assert.deepEqual(r.counts, { 'dead-weight': 1, 'tested-unused': 2, 'used-untested': 1, healthy: 1 });
  assert.equal(row(r, 'alpha').status, 'healthy'); assert.equal(row(r, 'alpha').uses, 2);
  const beta = row(r, 'beta');
  assert.equal(beta.status, 'tested-unused'); assert.equal(beta.evalsTrigger, true);
  assert.match(beta.message, /your suite may test a prompt users never write/);
  const gamma = row(r, 'gamma');
  assert.equal(gamma.status, 'used-untested', 'a negative (max: 0) case does not test that the skill triggers');
  assert.equal(gamma.uses, 3); assert.equal(gamma.userUses, 1); assert.equal(gamma.lastUsed, '2026-10-05');
  assert.deepEqual(gamma.invokedAs, ['gamma', 'shop:gamma']);
  assert.equal(row(r, 'epsilon').status, 'tested-unused'); assert.equal(row(r, 'epsilon').cases[0].via, 'covers');
  const delta = row(r, 'delta');
  assert.equal(delta.status, 'dead-weight'); assert.equal(delta.contextSource, 'estimate');
  assert.match(delta.message, /costs about \d+ tokens of context every session/);
  assert.equal(r.deadWeightTokens, delta.contextTokens);
  assert.equal(r.rows[0].skill, 'delta', 'dead weight is listed first');
  assert.equal(r.usage.malformedLines, 2);
});

test('the official v1 result shape gives trigger verdicts too; a failing trigger is reported', async () => {
  const native = { schemaVersion: 1, startedAt: '2026-10-08T00:00:00Z', suite: { root: '/x/shop' }, cases: [
    { name: 'beta fires', dir: 'evals/beta-fires', graders: [{ name: 'fired', type: 'tool_used' }], aggregates: { score: 0 },
      arms: { with: [{ score: 0, error: null, graders: [{ name: 'fired', passed: false, scored: true }] }] } },
  ] };
  const r = await usageCheck(await shopPlugin(), { result: native, since: SINCE, transcripts: TRANSCRIPTS });
  assert.equal(row(r, 'beta').evalsTrigger, false);
  assert.match(row(r, 'beta').message, /trigger currently fails/);
  assert.equal(r.evals.result.source, 'claude-plugin-eval');
  const none = await usageCheck(await shopPlugin(), { since: SINCE, transcripts: TRANSCRIPTS });
  assert.equal(row(none, 'beta').evalsTrigger, null, 'no result: the case exists, its verdict is unknown');
});

test('--skill-doctor text supplies the measured context cost, and the usage when no transcript exists', async () => {
  const skillDoctorText = await fs.readFile(path.join(FIX, 'skill-doctor.txt'), 'utf8');
  const r = await usageCheck(await shopPlugin(), { since: SINCE, transcripts: TRANSCRIPTS, skillDoctorText });
  assert.equal(r.usage.source, 'transcripts');
  assert.equal(row(r, 'delta').contextTokens, 250); assert.equal(row(r, 'delta').contextSource, 'skill-doctor');
  assert.match(row(r, 'delta').message, /costs 250 tokens of context every session\./);
  assert.equal(row(r, 'gamma').uses, 3, 'transcripts stay the usage source when they exist');
  const fallback = await usageCheck(await shopPlugin(), { since: SINCE, transcripts: path.join(FIX, 'nope'), skillDoctorText });
  assert.equal(fallback.usage.source, 'skill-doctor');
  assert.equal(row(fallback, 'gamma').uses, 12);
  assert.equal(row(fallback, 'beta').status, 'tested-unused');
});

test('privacy: no prompt, reply, argument or path from a transcript reaches any output', async () => {
  const r = await usageCheck(await shopPlugin(), { result: shimResult('pass'), since: SINCE, transcripts: TRANSCRIPTS });
  for (const out of [JSON.stringify(r), formatText(r), markdown(r), renderHtml(r)]) assert.doesNotMatch(out, SECRETS);
});

test('user-visible text has no em dashes or tildes', async () => {
  const r = await usageCheck(await shopPlugin(), { since: SINCE, transcripts: TRANSCRIPTS, skillDoctorText: await fs.readFile(path.join(FIX, 'skill-doctor.txt'), 'utf8') });
  for (const s of Object.values(STATUS)) assert.doesNotMatch(s.advice + s.label, /[—~]/);
  for (const out of [formatText(r), markdown(r)]) assert.doesNotMatch(out, /[—~]/);
  const page = renderHtml(r).replace(/<style>[\s\S]*<\/style>/, '');
  assert.doesNotMatch(page, /[—~]/);
});

test('renderHtml is self-contained with the report tokens and a dark theme', async () => {
  const html = renderHtml(await usageCheck(await shopPlugin(), { since: SINCE, transcripts: TRANSCRIPTS }));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /--paper:#F3F5F8/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /1 skill is dead weight/);
});

test('CLI: text by default, --json and --md to stdout or a file, --html to a file; usage errors exit 2', async () => {
  const plugin = await shopPlugin();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-cli-'));
  const resultFile = path.join(out, 'result.json');
  await fs.writeFile(resultFile, JSON.stringify(shimResult('pass')));
  const base = [plugin, '--since', SINCE, '--transcripts', TRANSCRIPTS];
  const text = run([...base, resultFile]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^usage-check: 5 skills in shop; real usage from 4 transcript files in 2 projects, since 2026-09-01, 2 malformed lines skipped/);
  assert.match(text.stdout, /DEAD {5}delta/);
  assert.match(text.stdout, /summary: 1 dead weight, 2 tested but unused, 1 used but untested, 1 healthy/);
  const json = run([...base, '--json', '--projects', '*shop']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.usage.projects, 1); assert.equal(parsed.usage.projectFilter, '*shop');
  const files = run([...base, '--json', path.join(out, 'u.json'), '--md', path.join(out, 'u.md'), '--html', path.join(out, 'u.html'), '--skill-doctor', path.join(FIX, 'skill-doctor.txt')]);
  assert.equal(files.status, 0, files.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'u.json'), 'utf8')).skills, 5);
  assert.match(await fs.readFile(path.join(out, 'u.md'), 'utf8'), /\| dead weight \| `delta` \| 0 \| never \| none \| unknown \| 250 tokens \|/);
  assert.match(await fs.readFile(path.join(out, 'u.html'), 'utf8'), /<title>shop · skill usage<\/title>/);
  assert.equal(run([]).status, 2);
  assert.equal(run([plugin, '--since']).status, 2);
  assert.equal(run([plugin, '--since', 'whenever', '--transcripts', TRANSCRIPTS]).status, 2);
  assert.equal(run([path.join(out, 'missing')]).status, 2);
  assert.equal(run([plugin, '--bogus']).status, 2);
});
