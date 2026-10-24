import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { anonymise, looksSecret, skillProfile, relevance, namesSkill, classifyEntry, readSession, mineSession, jaccard, mineCases,
  caseFiles, validateCaseFiles, writeCandidates, acceptCandidates, defaultStaging, formatText, dependsOnContext } from '../tools/case-miner.mjs';
import { doctor } from '../tools/suite-doctor.mjs';

const TOOL = new URL('../tools/case-miner.mjs', import.meta.url).pathname;
const TRANSCRIPTS = new URL('./fixtures/case-miner/transcripts/', import.meta.url).pathname;
const NOW = Date.parse('2026-10-20T00:00:00Z');
const OPTS = { since: '2026-10-01', transcripts: TRANSCRIPTS, now: NOW, osUser: 'nobody', osHome: '/home/nobody' };
// Text that must never leave the transcripts: the fake secrets and personal data in s1, assistant text,
// tool results, and prompts that are not a person's (headless, sub-agent, suggestion, notification, ...).
const LEAKS = /FAKE|sk-ant|ghp_|AKIA|xoxb|Jane|Doe|example\.com|token=|\/home\/dev|LEGACY-CODE-LINE|int total|ASSISTANT|TOOL-RESULT|SKILL-BODY|NOTIFICATION-TEXT|SUGGESTED-TEXT|PEER-TEXT|SIDECHAIN|MALFORMED|HEADLESS|OLD-TEXT|SUBAGENT/;

const JAVA = '---\nname: java-api\ndescription: House rules for Spring Boot REST controllers, services and DTOs in Java. Use when the user asks to write or review a "REST controller", "endpoint", "DTO" or "JPA repository". Do NOT use for Vue, Pinia or frontend work.\npaths:\n  - src/main/java/**/*.java\n---\n# java-api\n';
const VUE = '---\nname: vue-store\ndescription: Pinia store conventions for Vue 3 apps. Use when the user asks for a "Pinia store" or Vue state management. Do not use for backend or Java work.\n---\n# vue-store\n';
const NOTES = '---\nname: release-notes\ndescription: Writes release notes from merged pull requests. Use when the user asks for "release notes" or a changelog entry.\n---\n# release-notes\n';
async function shopPlugin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-miner-'));
  const files = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'shop', version: '0.1.0' }),
    'skills/java-api/SKILL.md': JAVA, 'skills/vue-store/SKILL.md': VUE, 'skills/release-notes/SKILL.md': NOTES,
    'evals/release-notes-fires/prompt.md': '---\ndescription: existing case\n---\nWrite release notes for the merged pull requests since v1.2.0.\n',
    'evals/release-notes-fires/graders/fired.md': '---\ntype: tool_used\ntool: Skill\ninput_match: release-notes\nmin: 1\n---\nfired\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const run = (args, cwd) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd });
const byKind = (plan, skill) => Object.fromEntries(['trigger', 'missed', 'no-trigger'].map((k) => [k, plan.candidates.filter((c) => c.skill === skill && c.kind === k).length]));
async function readTree(dir) {
  let out = '';
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += await fs.readFile(path.join(e.parentPath ?? e.path, e.name), 'utf8');
  return out;
}

test('anonymise removes paths, emails, token URLs, known key formats, names and long code, and says what it removed', () => {
  const code = ['```java', ...Array.from({ length: 8 }, (_, i) => `  int v${i} = ${i};`), '```'].join('\n');
  const text = `my name is Jane Doe, mail jane.doe@example.com. Edit /home/dev/shop/src/main/java/com/acme/A.java and /home/dev/notes/plan.md and ~/x/y.txt. `
    + 'Keys: sk-ant-FAKE0000notarealkey0000xyz ghp_FAKEfake0000FAKEfake0000FAKEfake00 github_pat_FAKE0000fake0000FAKE0000x AKIAIOSFODNN7EXAMPLE xoxb-FAKE-not-a-real-token '
    + 'AI' + 'zaFAKEfake0000FAKEfake0000FAKEfake000 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignature0000 Bearer FAKEbearer0000token0000x '
    + `password=hunter22 api_key: Zx9FAKEvalue Q3fA9kLm2Xp7Rt5Vw8Yz1Bc4Nd6Eg0Hj. See https://ci.example.com/run/42?token=FAKE123 and https://u:FAKEpass@git.example.com/r. Host 10.1.2.3.\n${code}\ndone`;
  const a = anonymise(text, { cwd: '/home/dev/shop', home: '/home/dev', users: ['dev'] });
  assert.doesNotMatch(a.text, LEAKS);
  assert.doesNotMatch(a.text, /hunter22|Zx9FAKE|Q3fA9|10\.1\.2\.3|FAKEpass|plan\.md.*plan\.md/);
  assert.match(a.text, /my name is <name>, mail <email>\./);
  assert.match(a.text, /<repo>\/src\/main\/java\/com\/acme\/A\.java/, 'a path in the session repo keeps its repo-relative part');
  assert.match(a.text, /<path>\/plan\.md and <path>\/y\.txt/, 'any other home path keeps only its file name');
  assert.match(a.text, /password=<secret> api_key: <secret>/);
  assert.match(a.text, /<code block removed: 8 lines>\ndone$/);
  const what = Object.fromEntries(a.removed.map((r) => [r.what, r.n]));
  assert.deepEqual(what, { 'code block': 1, secret: 11, 'URL with a token': 2, email: 1, 'IP address': 1, path: 3, name: 1 });
  for (const k of ['Anthropic or OpenAI key', 'GitHub token', 'Slack token', 'AWS key id', 'Google API key', 'JWT', 'bearer token', 'high-entropy string']) assert.ok(a.note.includes(k), k);
  assert.match(a.note, /^removed 1 code block \(8 lines\), 11 secrets \(/);
});

test('anonymise leaves ordinary prompt text alone and truncates long prompts', () => {
  const plain = 'Write GET /api/invoices/{id} in spring-boot-conventions-2 style for v2.1.287, the token: string field, and say the password is wrong. Host 127.0.0.1. Docs at https://docs.spring.io/spring-boot/index.html.';
  const a = anonymise(plain, { cwd: '/home/dev/shop', users: ['dev'] });
  assert.equal(a.text, plain);
  assert.equal(a.note, 'nothing removed');
  const long = anonymise('word '.repeat(400), { maxChars: 100 });
  assert.ok(long.text.length <= 113 && long.text.endsWith('[truncated]'));
  assert.match(long.note, /cut from 1999 to 100 characters/);
  const pasted = anonymise(['Fix this:', ...Array.from({ length: 7 }, (_, i) => `    at com.acme.Foo.bar${i}(Foo.java:${i})`), 'thanks'].join('\n'));
  assert.equal(pasted.text, 'Fix this:\n<pasted code or log removed: 7 lines>\nthanks');
  const list = anonymise(['Steps:', ...Array.from({ length: 7 }, (_, i) => `  - step ${i};`)].join('\n'));
  assert.equal(list.note, 'nothing removed', 'an indented list is not a paste');
  assert.ok(looksSecret('3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c'));
  assert.ok(!looksSecret('spring-boot-conventions-reference-2'));
  assert.ok(!looksSecret('InvoiceControllerIntegrationTest'));
});

test('skillProfile reads keywords from the positive part of the description, its quoted phrases and its paths: scope', () => {
  const p = skillProfile({ name: 'java-api', description: 'House rules for Spring Boot REST controllers in Java. Use when the user asks for a "REST controller" or "JPA repository". Do NOT use for Vue or Pinia work.', raw: 'name: java-api\npaths:\n  - src/main/java/**/*.java\n' });
  assert.ok(['spring', 'boot', 'rest', 'controller', 'java', 'jpa', 'repository'].every((w) => p.words.includes(w)), p.words.join(','));
  assert.ok(!p.words.some((w) => ['use', 'user', 'house', 'rule', 'vue', 'pinia'].includes(w)));
  assert.deepEqual(p.phrases, [['rest', 'controller'], ['jpa', 'repository']]);
  assert.deepEqual(p.negWords, ['vue', 'pinia']);
  assert.deepEqual(p.globs, ['src/main/java/**/*.java']);
  const r = relevance(p, 'Review the JPA repository for orders');
  assert.equal(r.score, 3); assert.deepEqual(r.hits, ['jpa repository']);
  assert.equal(relevance(p, 'Write a Pinia store in Vue').score, -2, 'words the description excludes count against it');
  assert.equal(relevance(p, 'fix the null check', ['/home/dev/shop/src/main/java/a/B.java'], '/home/dev/shop').scoped, true, 'a file the agent touched in the scope counts');
  assert.equal(relevance(p, 'fix the null check', ['/home/dev/shop/web/src/App.vue'], '/home/dev/shop').scoped, false);
  assert.ok(namesSkill('use the java-api skill', 'java-api', 'shop'));
  assert.ok(namesSkill('try /shop:docs', 'docs', 'shop'));
  assert.ok(!namesSkill('update the docs', 'docs', 'shop'), 'a one-word name is only a name next to "skill" or a slash');
  assert.ok(namesSkill('use the docs skill', 'docs', 'shop'));
});

test('classifyEntry keeps only prompts a person typed', () => {
  const u = (content, extra = {}) => ({ type: 'user', uuid: 'x', message: { content }, ...extra });
  assert.equal(classifyEntry(u('Add a controller')).kind, 'prompt');
  assert.equal(classifyEntry(u([{ type: 'text', text: 'Add a controller' }, { type: 'text', text: '<ide_opened_file>/home/dev/x</ide_opened_file>' }])).text, 'Add a controller');
  assert.equal(classifyEntry(u([{ type: 'tool_result', tool_use_id: 't', content: 'x' }])).kind, 'skip');
  assert.equal(classifyEntry(u('x', { isMeta: true })).kind, 'skip');
  assert.equal(classifyEntry(u('x', { isSidechain: true })).kind, 'skip');
  assert.deepEqual(classifyEntry(u('<command-name>/shop:java-api</command-name>')), { kind: 'command', command: 'shop:java-api' });
  for (const extra of [{ entrypoint: 'sdk-cli' }, { promptSource: 'sdk' }, { promptSource: 'system' }, { promptSource: 'suggestion_accepted' }, { origin: { kind: 'peer' } }, { isCompactSummary: true }]) assert.equal(classifyEntry(u('Add a controller', extra)).kind, 'other', JSON.stringify(extra));
  for (const t of ['<task-notification>x</task-notification>', '[Request interrupted by user]', '<local-command-stdout>x</local-command-stdout>', 'This session is being continued from a previous conversation']) assert.equal(classifyEntry(u(t)).kind, 'other', t);
  assert.ok(dependsOnContext('yes do it')); assert.ok(dependsOnContext('ok go ahead and continue please')); assert.ok(!dependsOnContext('Add a REST controller for invoices'));
});

test('readSession streams a transcript into turns and counts malformed lines', async () => {
  const { turns, stats } = await readSession(path.join(TRANSCRIPTS, '-home-dev-shop', 's6.jsonl'));
  assert.equal(stats.malformed, 2);
  assert.deepEqual(turns.map((t) => t.kind), ['prompt', 'other', 'other', 'other', 'other'], 'notification, suggestion, agent message and interruption are turn boundaries, not prompts');
  assert.deepEqual(turns[0].fired, ['shop:java-api']);
  const s2 = await readSession(path.join(TRANSCRIPTS, '-home-dev-shop', 's2.jsonl'));
  assert.deepEqual(s2.turns.map((t) => t.kind), ['prompt', 'command', 'prompt']);
  assert.deepEqual(s2.turns[0].files, ['/home/dev/shop/src/main/java/com/acme/billing/InvoiceController.java']);
});

test('mineSession: fired is a trigger, a later /skill or correction makes a miss, a complaint makes a negative', () => {
  const skills = [JAVA, VUE].map((t) => { const name = t.match(/name: (\S+)/)[1]; const description = t.match(/description: (.*)/)[1]; return { name, profile: skillProfile({ name, description, raw: t }) }; });
  const p = (text, fired = [], at = 0) => ({ kind: 'prompt', uuid: `u${at}`, at, cwd: '/r', text, fired, files: [] });
  const c = (command, at) => ({ kind: 'command', uuid: `c${at}`, at, cwd: '/r', text: null, command, fired: [], files: [] });
  const kinds = (turns) => mineSession(turns, skills, { pluginName: 'shop' }).map((x) => `${x.skill}:${x.kind}:${x.turn.uuid}`);
  assert.deepEqual(kinds([p('Add a REST controller for invoices', ['shop:java-api'], 1)]), ['java-api:trigger:u1']);
  assert.deepEqual(kinds([p('Add an endpoint for invoices', [], 1), c('shop:java-api', 2)]), ['java-api:missed:u1']);
  assert.deepEqual(kinds([p('Add an endpoint for invoices', [], 1), p('thanks', [], 2), p('more', [], 3), p('still', [], 4), c('shop:java-api', 5)]), [], 'the signal must come within 3 turns');
  assert.deepEqual(kinds([p('Add an endpoint for invoices', [], 1), c('shop:java-api', 2 * 3_600_000 + 2)]), [], 'and within 2 hours');
  assert.deepEqual(kinds([p('Add an endpoint for invoices', ['shop:java-api'], 1), p('Add a second endpoint for invoices', [], 2), c('shop:java-api', 3)]), ['java-api:trigger:u1'], 'a skill already loaded in the session is not missed');
  assert.deepEqual(kinds([p('Fix the typo in the README', [], 1), c('shop:java-api', 2)]), [], 'an unrelated prompt is not a miss');
  assert.deepEqual(kinds([p('Write a Pinia store for the cart', ['shop:java-api'], 1), p('Why did you load the java-api skill? Not relevant.', [], 2)]), ['java-api:no-trigger:u1'], 'a complaint about java-api is not a correction for vue-store');
  assert.deepEqual(kinds([p('Write a Pinia store for the cart', ['shop:java-api'], 1), p('That is irrelevant, start over', [], 2)]), ['java-api:no-trigger:u1']);
  assert.deepEqual(kinds([p('Review the JPA repository for orders', [], 1), p("You didn't follow our rules, use the java-api skill", ['shop:java-api'], 2)]), ['java-api:missed:u1'], 'a correction prompt is never a trigger candidate itself');
  const conf = mineSession([p('Add a REST controller for invoices with a DTO', ['shop:java-api'], 1), p('With java-api, add a REST controller for orders', ['shop:java-api'], 2)], skills, { pluginName: 'shop' });
  assert.equal(conf[0].confidence >= 0.75, true); assert.ok(conf[1].confidence < 0.5); assert.match(conf[1].why, /names the skill outright/);
});

test('mineCases on the fixtures: kinds, dedupe, window, --max, and nothing private in the result', async () => {
  const dir = await shopPlugin();
  const plan = await mineCases(dir, OPTS);
  assert.equal(plan.scan.files, 10, 'the sub-agent transcript is not read');
  assert.equal(plan.scan.projects, 2);
  assert.equal(plan.scan.malformed, 2);
  assert.equal(plan.scan.headless, 1);
  assert.deepEqual(byKind(plan, 'java-api'), { trigger: 2, missed: 2, 'no-trigger': 1 });
  assert.deepEqual(byKind(plan, 'vue-store'), { trigger: 1, missed: 0, 'no-trigger': 0 }, 'the Vue prompt is java-api\'s negative, not a vue-store miss');
  assert.deepEqual(byKind(plan, 'release-notes'), { trigger: 0, missed: 0, 'no-trigger': 0 });
  assert.deepEqual(plan.dropped, { 'depends on earlier turns': 0, 'empty after anonymisation': 0, 'already in the suite': 1, 'near duplicate': 1, 'over --max': 1 });
  const missed = plan.candidates.filter((c) => c.kind === 'missed');
  assert.deepEqual(missed.map((c) => c.date).sort(), ['2026-10-12', '2026-10-13']);
  assert.match(missed.find((c) => c.date === '2026-10-12').why, /typed \/shop:java-api in the next turn; the prompt matches the description \(endpoint, api\) and a file in its paths: scope/);
  assert.match(missed.find((c) => c.date === '2026-10-13').why, /corrected the agent and the skill fired/);
  const neg = plan.candidates.find((c) => c.kind === 'no-trigger');
  assert.equal(neg.label, 'high'); assert.match(neg.prompt, /^Write a Pinia store/);
  const s1 = plan.candidates.find((c) => c.date === '2026-10-10');
  assert.match(s1.note, /removed 1 code block \(9 lines\), 4 secrets \(Anthropic or OpenAI key, GitHub token, Slack token, AWS key id\), 1 URL with a token, 1 email, 1 path, 1 name/);
  assert.match(s1.prompt, /<repo>\/src\/main\/java\/com\/acme\/billing\/InvoiceController\.java/);
  assert.equal(plan.candidates.filter((c) => /customers/.test(c.prompt)).length, 1, 'near-identical prompts are merged');
  assert.doesNotMatch(JSON.stringify(plan.candidates), LEAKS);
  assert.ok(plan.candidates.every((c) => /^mined-[a-z-]+-(trigger|missed|no-trigger)-[0-9a-f]{6}$/.test(c.id)));

  const one = await mineCases(dir, { ...OPTS, max: 1, skill: 'java-api' });
  assert.deepEqual(one.candidates.map((c) => c.kind), ['missed']);
  assert.deepEqual(one.skills.map((s) => s.name), ['java-api']);
  const shop = await mineCases(dir, { ...OPTS, projects: '*shop' });
  assert.equal(byKind(shop, 'vue-store').trigger, 0);
  const late = await mineCases(dir, { ...OPTS, since: '2026-10-15' });
  assert.ok(late.candidates.every((c) => c.date >= '2026-10-15'));
  const early = await mineCases(dir, { ...OPTS, since: '2026-07-01', max: 20 });
  assert.equal(early.candidates.filter((c) => c.date === '2026-08-01').length, 1, 'a wider window reaches the old session');
  await assert.rejects(mineCases(dir, { ...OPTS, skill: 'nope' }), /no skill named nope/);
  const none = await mineCases(dir, { ...OPTS, transcripts: path.join(TRANSCRIPTS, 'missing') });
  assert.equal(none.scan.found, false); assert.equal(none.candidates.length, 0);
  assert.match(formatText(plan, null, { dryRun: true }), /java-api: 2 triggers, 2 missed triggers, 1 near-miss negative[\s\S]*left out: 1 already in the suite, 1 near duplicate, 1 over --max\ndry run: nothing written\.$/);
});

test('generated cases pass every suite-doctor rule, and the grader is the evals-convert trigger form', () => {
  for (const kind of ['trigger', 'missed', 'no-trigger']) {
    const files = caseFiles({ id: `mined-java-api-${kind}-abc123`, skill: 'java-api', kind, confidence: 0.8, label: 'high', date: '2026-10-10', why: 'it "fired" here', prompt: '---\nAdd a REST controller\n---', note: 'nothing removed' });
    assert.deepEqual(validateCaseFiles(files), [], kind);
    const grader = files.find((f) => f.rel.startsWith('graders/')).text;
    assert.match(grader, /input_match: '"skill"\\s\*:\\s\*"\(\?:\[\\w-\]\+:\)\?java-api"'/);
    assert.match(grader, kind === 'no-trigger' ? /min: 0\nmax: 0\narm: both/ : /min: 1\narm: with-only/);
  }
  assert.ok(jaccard('Add a REST controller for customers', 'add a rest controller for customers please') >= 0.8);
  assert.ok(jaccard('Add a REST controller for customers', 'Write a Pinia store') < 0.2);
});

test('staging: review files, a .gitignore, nothing in the suite, no clobbering on a rerun, never inside the eval dir', async () => {
  const dir = await shopPlugin();
  const plan = await mineCases(dir, OPTS);
  const res = writeCandidates(plan);
  const staging = defaultStaging(dir);
  assert.equal(res.staging, staging); assert.equal(res.written.length, plan.candidates.length); assert.deepEqual(res.invalid, []);
  assert.equal(readFileSync(path.join(staging, '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  const md = readFileSync(path.join(staging, 'candidates.md'), 'utf8');
  for (const c of plan.candidates) assert.ok(md.includes(`## ${c.id}`) && md.includes(c.prompt) && md.includes(c.note) && md.includes(c.date), c.id);
  assert.doesNotMatch(await readTree(staging), LEAKS);
  assert.deepEqual((await fs.readdir(path.join(dir, 'evals'))).sort(), ['release-notes-fires'], 'nothing reaches the suite before accept');
  const d = doctor(dir, { live: false });
  assert.equal(d.cases, 1); assert.equal(d.summary.errors, 0);

  const edited = path.join(staging, plan.candidates[0].id, 'prompt.md');
  await fs.appendFile(edited, 'my edit\n');
  const again = writeCandidates(await mineCases(dir, OPTS));
  assert.equal(again.written.length, 0); assert.equal(again.kept.length, plan.candidates.length);
  assert.match(readFileSync(edited, 'utf8'), /my edit/, 'a rerun never overwrites a staged candidate');
  assert.throws(() => writeCandidates(plan, path.join(dir, 'evals', '.candidates')), /inside the eval dir/);
});

test('accept moves a candidate into the suite, refuses to overwrite, and keeps the index in step', async () => {
  const dir = await shopPlugin();
  const plan = await mineCases(dir, OPTS);
  writeCandidates(plan);
  const [a, b] = plan.candidates.map((c) => c.id);
  const r = acceptCandidates([a], { pluginDir: dir });
  assert.deepEqual(r.moved, [a]); assert.deepEqual(r.refused, []);
  assert.ok(existsSync(path.join(dir, 'evals', a, 'prompt.md')));
  assert.ok(!existsSync(path.join(defaultStaging(dir), a)));
  assert.ok(!readFileSync(path.join(defaultStaging(dir), 'candidates.md'), 'utf8').includes(a));
  const d = doctor(dir, { live: false });
  assert.equal(d.cases, 2); assert.equal(d.summary.errors, 0);

  await fs.mkdir(path.join(dir, 'evals', b));
  const clash = acceptCandidates([b, 'nope', '../evil'], { pluginDir: dir });
  assert.deepEqual(clash.moved, []);
  assert.deepEqual(clash.refused.map((x) => x.id), [b, 'nope', '../evil']);
  assert.match(clash.refused[0].why, /already exists; not overwritten/);
  assert.ok(existsSync(path.join(defaultStaging(dir), b)), 'a refused candidate stays staged');
  const again = await mineCases(dir, OPTS);
  assert.ok(!again.candidates.some((c) => c.id === a), 'an accepted prompt is now in the suite and is not mined again');
});

test('CLI: --dry-run writes nothing, --json prints the plan, accept exits 1 on a refusal, bad flags exit 2', async () => {
  const dir = await shopPlugin();
  const base = ['--transcripts', TRANSCRIPTS, '--since', '2026-10-01'];
  const dry = run([dir, ...base, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: nothing written\./);
  assert.ok(!existsSync(defaultStaging(dir)));
  assert.doesNotMatch(dry.stdout, LEAKS);
  const json = run([dir, ...base, '--dry-run', '--json', '--skill', 'java-api', '--max', '2']);
  const j = JSON.parse(json.stdout);
  assert.equal(j.dryRun, true); assert.equal(j.staged, null); assert.equal(j.candidates.length, 2);
  assert.doesNotMatch(json.stdout, LEAKS);
  const out = path.join(dir, 'review');
  const wrote = run([dir, ...base, '--out', out]);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(wrote.stdout, /staged \d+ new candidates in .*review\/[\s\S]*accept <id\.\.\.> --plugin .* --out /);
  const id = (await fs.readdir(out)).find((x) => x.startsWith('mined-'));
  const acc = run(['accept', id, 'nope', '--plugin', dir, '--out', out]);
  assert.equal(acc.status, 1);
  assert.match(acc.stdout, new RegExp(`accepted ${id}[\\s\\S]*refused  nope`));
  assert.equal(run([dir, '--max', '0']).status, 2);
  assert.equal(run([dir, '--since', 'last month', ...base.slice(0, 2)]).status, 2);
  assert.equal(run([dir, '--bogus']).status, 2);
  assert.equal(run([dir, ...base, '--out', path.join(dir, 'evals', 'staging')]).status, 2);
  assert.equal(run(['accept']).status, 2);
});
