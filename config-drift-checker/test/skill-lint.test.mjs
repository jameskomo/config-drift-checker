import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RULES, parseFrontmatter, localRefs, lintPlugin, formatFinding, summaryLine, exitCode, findSkillFiles } from '../tools/skill-lint.mjs';

const TOOL = new URL('../tools/skill-lint.mjs', import.meta.url).pathname;
const REPO_PLUGIN = new URL('..', import.meta.url).pathname;
const GOOD_DESC = 'Write and review Spring Boot controllers in house style. Use when the user asks for a REST endpoint. Do not use for frontend work.';
const skill = (name, description = GOOD_DESC, body = '# Body\n\nFollow the rules.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

// Build a plugin in a temp dir from { relative path: content }; a value of null makes a directory.
async function plugin(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lint-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (content === null) { await fs.mkdir(p, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}
const rulesHit = (r) => r.findings.map((f) => f.rule);
async function hits(files, rule) { return (await lintPlugin(await plugin(files))).findings.filter((f) => f.rule === rule); }
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('rules table: every rule has an id, a level, a check, an explanation and a fix hint; ids unique', () => {
  for (const r of RULES) {
    assert.match(r.id, /^[a-z-]+$/);
    assert.ok(['ERROR', 'WARN'].includes(r.level), r.id);
    assert.ok(['skill', 'plugin'].includes(r.scope), r.id);
    assert.equal(typeof r.check, 'function');
    assert.ok(r.explain.length > 10 && r.fix.length > 5, r.id);
    assert.ok(!/[\u2014~]/.test(r.explain + r.fix), `${r.id} text uses an em dash or tilde`);
  }
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
});

test('a clean single-skill plugin has no findings', async () => {
  const r = await lintPlugin(await plugin({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: ['./skills/clean'] }), 'skills/clean/SKILL.md': skill('clean') }));
  assert.deepEqual(r.findings, []);
  assert.equal(r.skills, 1);
  assert.equal(summaryLine(r), '1 skill checked, 0 errors, 0 warnings');
});

test('parseFrontmatter: styles, multi-line values, CRLF, BOM, missing and unclosed', () => {
  const fm = parseFrontmatter('﻿---\r\nname: a\r\ndescription: >\r\n  folded\r\n  text\r\nother: "q: \\"x\\""\r\nlit: |\r\n  one\r\n  two\r\nsq: \'it\'\'s: fine\'\r\nplain: first\r\n  second: part\r\n---\r\nbody\r\n');
  assert.equal(fm.closed, true);
  assert.deepEqual(Object.fromEntries(Object.entries(fm.fields).map(([k, v]) => [k, [v.style, v.value]])), {
    name: ['plain', 'a'], description: ['block', 'folded text'], other: ['quoted', 'q: "x"'], lit: ['block', 'one\ntwo'], sq: ['quoted', "it's: fine"], plain: ['plain', 'first second: part'],
  });
  assert.equal(fm.fields.description.line, 3);
  assert.equal(fm.body.trim(), 'body');
  assert.equal(parseFrontmatter('# no frontmatter').present, false);
  const open = parseFrontmatter('---\nname: x\nbody');
  assert.deepEqual([open.present, open.closed], [true, false]);
});

test('frontmatter-missing: fires without a leading ---, and the field rules stay quiet', async () => {
  const r = await lintPlugin(await plugin({ 'skills/a/SKILL.md': '# A skill\n\nno frontmatter\n' }));
  assert.deepEqual(rulesHit(r), ['frontmatter-missing']);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'frontmatter-missing')).length, 0);
});

test('frontmatter-unclosed: fires without a closing ---', async () => {
  const r = await lintPlugin(await plugin({ 'skills/a/SKILL.md': `---\nname: a\ndescription: ${GOOD_DESC}\n# body\n` }));
  assert.deepEqual(rulesHit(r), ['frontmatter-unclosed']);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'frontmatter-unclosed')).length, 0);
});

test('name-missing: absent or empty name; present name passes', async () => {
  const absent = await hits({ 'skills/a/SKILL.md': `---\ndescription: ${GOOD_DESC}\n---\nbody\n` }, 'name-missing');
  assert.match(absent[0].message, /no name field/);
  const empty = await hits({ 'skills/a/SKILL.md': `---\nname:\ndescription: ${GOOD_DESC}\n---\nbody\n` }, 'name-missing');
  assert.match(empty[0].message, /name is empty/);
  assert.equal(empty[0].level, 'ERROR');
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'name-missing')).length, 0);
});

test('description-missing: absent or empty (including empty quotes); present passes', async () => {
  assert.equal((await hits({ 'skills/a/SKILL.md': '---\nname: a\n---\nbody\n' }, 'description-missing')).length, 1);
  assert.equal((await hits({ 'skills/a/SKILL.md': '---\nname: a\ndescription: ""\n---\nbody\n' }, 'description-missing')).length, 1);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'description-missing')).length, 0);
});

test('yaml-plain-colon: an unquoted ": " in name or description is an error; quoted and block values are fine', async () => {
  const bad = await hits({ 'skills/a/SKILL.md': skill('a', 'Lint skills. Use when the user says: check my skill. Do not use for code.') }, 'yaml-plain-colon');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 3);
  assert.match(bad[0].message, /unquoted description/);
  const wrapped = await hits({ 'skills/a/SKILL.md': `---\nname: a\ndescription: Lint skills. Use when the user says\n  this: or that. Do not use for code.\n---\nbody\n` }, 'yaml-plain-colon');
  assert.equal(wrapped.length, 1, 'a colon on a continuation line of a plain scalar counts too');
  for (const ok of [
    skill('a', '"Lint skills. Use when the user says: check my skill. Do not use for code."'),
    skill('a', "'Lint skills. Use when the user says: check my skill. Do not use for code.'"),
    `---\nname: a\ndescription: >\n  Lint skills. Use when the user says: check it. Do not use for code.\n---\nbody\n`,
    skill('a', 'Lint skills, see https://example.com/x. Use when asked. Do not use for code.'),
  ]) assert.equal((await hits({ 'skills/a/SKILL.md': ok }, 'yaml-plain-colon')).length, 0, ok);
});

test('name-dir-mismatch: name must equal the directory name', async () => {
  const bad = await hits({ 'skills/alpha/SKILL.md': skill('beta') }, 'name-dir-mismatch');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].level, 'ERROR');
  assert.match(bad[0].message, /"beta" does not match the directory "alpha"/);
  assert.equal((await hits({ 'skills/alpha/SKILL.md': skill('alpha') }, 'name-dir-mismatch')).length, 0);
});

test('duplicate-name: two skills with one name in a plugin are reported once, against the second', async () => {
  const r = await lintPlugin(await plugin({ 'skills/a/SKILL.md': skill('a'), 'other/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': skill('b') }));
  const dup = r.findings.filter((f) => f.rule === 'duplicate-name');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].file, path.join('skills', 'a', 'SKILL.md'));
  assert.match(dup[0].message, /also used by other\/a\/SKILL\.md/);
  assert.equal(exitCode(r), 1);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': skill('b') }, 'duplicate-name')).length, 0);
});

test('description-too-long: over 1024 characters is an error, exactly 1024 is fine', async () => {
  const base = 'Use when the user asks. Do not use for other work. ';
  const pad = (n) => (base + 'x'.repeat(n)).slice(0, n);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', pad(1025)) }, 'description-too-long')).length, 1);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', pad(1024)) }, 'description-too-long')).length, 0);
});

test('manifest-invalid-json: a plugin.json that does not parse; valid JSON passes; no manifest is fine', async () => {
  const bad = await hits({ '.claude-plugin/plugin.json': '{ "name": "p", }', 'skills/a/SKILL.md': skill('a') }, 'manifest-invalid-json');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].file, path.join('.claude-plugin', 'plugin.json'));
  assert.equal((await hits({ '.claude-plugin/plugin.json': '{"name":"p"}', 'skills/a/SKILL.md': skill('a') }, 'manifest-invalid-json')).length, 0);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'manifest-invalid-json')).length, 0);
});

test('manifest-skill-missing: each listed skill path that does not exist; a string value works too', async () => {
  const bad = await hits({ '.claude-plugin/plugin.json': JSON.stringify({ skills: ['./skills/a', './skills/gone'] }), 'skills/a/SKILL.md': skill('a') }, 'manifest-skill-missing');
  assert.deepEqual(bad.map((f) => f.message), ['plugin.json lists skill path "./skills/gone", which does not exist']);
  assert.equal((await hits({ '.claude-plugin/plugin.json': JSON.stringify({ skills: './skills/nope' }) }, 'manifest-skill-missing')).length, 1);
  assert.equal((await hits({ '.claude-plugin/plugin.json': JSON.stringify({ skills: './skills' }), 'skills/a/SKILL.md': skill('a') }, 'manifest-skill-missing')).length, 0);
});

test('description-too-short: under 40 characters warns', async () => {
  const bad = await hits({ 'skills/a/SKILL.md': skill('a', 'Use when asked.') }, 'description-too-short');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].level, 'WARN');
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'description-too-short')).length, 0);
});

test('no-trigger-guidance: needs one of the trigger phrases, matched case-insensitively', async () => {
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', 'House conventions for Spring Boot controllers, DTOs and services.') }, 'no-trigger-guidance')).length, 1);
  for (const d of ['USE WHEN the user asks for a controller in Java code.', 'Spring Boot rules. Use whenever Java backend code is written.', 'Spring Boot rules. Use for any Java backend controller work.', 'Spring Boot rules. Trigger phrases: controller, DTO, endpoint.', 'Spring Boot rules, applied when the user writes Java code.'])
    assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', `"${d}"`) }, 'no-trigger-guidance')).length, 0, d);
});

test('no-negative-scope: only when the plugin ships more than one skill', async () => {
  const vague = 'Spring Boot rules. Use when the user asks for a controller in Java.';
  const two = await hits({ 'skills/a/SKILL.md': skill('a', vague), 'skills/b/SKILL.md': skill('b') }, 'no-negative-scope');
  assert.deepEqual(two.map((f) => f.file), [path.join('skills', 'a', 'SKILL.md')]);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', vague) }, 'no-negative-scope')).length, 0, 'a lone skill has nothing to overlap with');
  for (const neg of ["Don't use for Vue.", 'Not for frontend work.', 'Never use it for Vue.', 'DO NOT USE for Vue.'])
    assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', `${vague} ${neg}`), 'skills/b/SKILL.md': skill('b') }, 'no-negative-scope')).length, 0, neg);
});

test('body-empty: nothing but whitespace below the frontmatter warns', async () => {
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, '\n  \n') }, 'body-empty')).length, 1);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a') }, 'body-empty')).length, 0);
});

test('body-too-long: over 500 lines warns, 500 is fine', async () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
  const bad = await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, lines(501)) }, 'body-too-long');
  assert.match(bad[0].message, /501 lines/);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, lines(500)) }, 'body-too-long')).length, 0);
});

test('localRefs: links, bundle-dir backticks and plugin-root paths; placeholders, URLs and project paths skipped', () => {
  const body = [
    'See [the guide](references/guide.md#top) and ![img](assets/x.png "t").',
    'Run `scripts/check.sh`, then `./local.md`. Ignore `src/main/Foo.java`, `references/*.md` and `<plugin>/evals/`.',
    'Links to [site](https://example.com) and [anchor](#here) are skipped.',
    '```',
    'node ${CLAUDE_PLUGIN_ROOT}/tools/a.mjs <plugin> and `references/in-fence.md`',
    '```',
    'Use `${CLAUDE_PLUGIN_ROOT}/ci/x.yml`.',
  ].join('\n');
  assert.deepEqual(localRefs(body, 5).map((r) => [r.base, r.path, r.line]), [
    ['skill', 'references/guide.md', 5], ['skill', 'assets/x.png', 5], ['skill', 'scripts/check.sh', 6], ['skill', './local.md', 6],
    ['plugin', 'tools/a.mjs', 9], ['plugin', 'ci/x.yml', 11],
  ]);
});

test('broken-local-ref: a referenced file the skill or plugin does not ship; existing files pass', async () => {
  const body = 'Read [guide](references/guide.md) and run `scripts/run.sh`.\nThen `node ${CLAUDE_PLUGIN_ROOT}/tools/t.mjs`.\n';
  const bad = await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, body) }, 'broken-local-ref');
  assert.deepEqual(bad.map((f) => [f.line, f.level]), [[5, 'WARN'], [5, 'WARN'], [6, 'WARN']]);
  assert.match(bad[2].message, /relative to the plugin directory/);
  const ok = await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, body), 'skills/a/references/guide.md': 'g', 'skills/a/scripts/run.sh': 's', 'tools/t.mjs': 't' }, 'broken-local-ref');
  assert.equal(ok.length, 0);
});

test('frontmatter-typography: em dash or curly quotes in frontmatter warn; in the body they do not', async () => {
  const bad = await hits({ 'skills/a/SKILL.md': skill('a', `"Rules \u2014 for \u201Cjava\u201D. Use when asked. Do not use for Vue."`) }, 'frontmatter-typography');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 3);
  assert.match(bad[0].message, /em dash and curly quote/);
  assert.equal((await hits({ 'skills/a/SKILL.md': skill('a', GOOD_DESC, 'Body \u2014 with \u2018quotes\u2019.\n') }, 'frontmatter-typography')).length, 0);
});

test('discovery skips node_modules, .git, results, evals, target and dist', async () => {
  const files = { 'skills/a/SKILL.md': skill('a') };
  for (const d of ['node_modules', '.git', 'results', 'evals', 'target', 'dist']) files[`${d}/x/SKILL.md`] = '# broken';
  const dir = await plugin(files);
  assert.deepEqual((await findSkillFiles(dir)).map((f) => path.relative(dir, f)), [path.join('skills', 'a', 'SKILL.md')]);
});

test('formatFinding: level, path with line, rule id, problem and fix on one line', () => {
  assert.equal(formatFinding({ level: 'WARN', file: 'skills/a/SKILL.md', line: 3, rule: 'r', message: 'bad', fix: 'do x' }), 'WARN  skills/a/SKILL.md:3 [r] bad. Fix: do x');
});

test('CLI: exit 0 clean, 1 on an error, warnings only fail with --strict; --json writes findings', async () => {
  const clean = await plugin({ 'skills/a/SKILL.md': skill('a') });
  let r = run([clean]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1 skill checked, 0 errors, 0 warnings');
  assert.equal(run([clean, '--strict']).status, 0);

  const warnOnly = await plugin({ 'skills/a/SKILL.md': skill('a', 'Use when asked about it.') });
  r = run([warnOnly]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^WARN {2}skills\/a\/SKILL\.md \[description-too-short\]/m);
  assert.match(r.stdout, /1 skill checked, 0 errors, 1 warning$/m);
  assert.equal(run([warnOnly, '--strict']).status, 1);

  const broken = await plugin({ 'skills/a/SKILL.md': skill('b'), 'skills/c/SKILL.md': '# none' });
  const out = path.join(broken, 'lint.json');
  r = run([broken, '--json', out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 skills checked, 2 errors, 0 warnings/);
  const j = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual([j.schemaVersion, j.skills, j.errors, j.warnings], [1, 2, 2, 0]);
  assert.deepEqual(j.findings.map((f) => f.rule).sort(), ['frontmatter-missing', 'name-dir-mismatch']);
  assert.ok(j.findings.every((f) => f.level && f.file && f.message && f.fix && f.explain));

  assert.equal(run([]).status, 2);
  assert.equal(run([clean, '--bogus']).status, 2);
  assert.equal(run([path.join(clean, 'missing')]).status, 2);
});

test('the shipped config-drift-checker skills load cleanly (no errors)', async () => {
  const r = await lintPlugin(REPO_PLUGIN);
  assert.ok(r.skills >= 4);
  assert.deepEqual(r.findings.filter((f) => f.level === 'ERROR'), []);
});
