import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { coverage, rulesFromMarkdown, rulesFromHooks, assignIds, badgeSvg, markdown } from '../tools/config-coverage.mjs';

const TOOL = new URL('../tools/config-coverage.mjs', import.meta.url).pathname;

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-'));
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p', skills: ['./skills/conventions'], hooks: './hooks/hooks.json' }));
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), `# notes-api\n\n## Code\n- Every endpoint returns the envelope \`ApiResponse\` — never a bare list.\n- Notes are never deleted. "Delete" means archive.\n\n\`\`\`\n- this bullet is inside a fence and is not a rule\n\`\`\`\n\n## Workflow\n1. Before you say a change is done, run \`mvn -q -o test\`.\n- [docs](x)\n`);
  await fs.mkdir(path.join(dir, 'skills/conventions'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills/conventions/SKILL.md'), `---\nname: Spring Conventions\ndescription: house style\n---\n# Conventions\n- DTOs are records grouped in Dtos classes.\n- No Lombok, no field injection in production code.\n`);
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } }));
  const c = (name, covers) => fs.mkdir(path.join(dir, 'evals', name), { recursive: true }).then(() => fs.writeFile(path.join(dir, 'evals', name, 'prompt.md'), `---\nname: ${name}\ncovers: [${covers}]\n---\nprompt\n`));
  await c('envelope', 'claude-md/every-endpoint-returns-the-envelope-apiresponse, skill/spring-conventions/no-lombok-no-field-injection');
  await c('guard', 'hook/pretooluse-bash, nope/not-a-rule');
  await fs.mkdir(path.join(dir, 'evals/results'), { recursive: true });
  return dir;
}

test('rulesFromMarkdown: bullets and numbered items with headings; fences and bare links skipped; frontmatter ignored', () => {
  const r = rulesFromMarkdown(`---\nname: x\n- not a rule\n---\n## A\n- one two three\n\`\`\`\n- fenced\n\`\`\`\n2) four five six\n- [link](u)\n* seven eight nine ten\n`, 'claude-md', 'CLAUDE.md');
  assert.deepEqual(r.map((x) => [x.heading, x.text, x.line]), [['A', 'one two three', 6], ['A', 'four five six', 10], ['A', 'seven eight nine ten', 12]]);
});

test('assignIds: scope/first-six-words, deduplicated; hooks use event-matcher', () => {
  const rules = assignIds([
    ...rulesFromMarkdown('- Run the tests before you commit anything at all\n- Run the tests before you commit anything, always\n', 'claude-md', 'CLAUDE.md'),
    ...rulesFromHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'x' }] }, { hooks: [] }] } }, 'hooks.json'),
  ]);
  assert.deepEqual(rules.map((r) => r.id), ['claude-md/run-the-tests-before-you-commit', 'claude-md/run-the-tests-before-you-commit-2', 'hook/pretooluse-bash', 'hook/pretooluse-all']);
  assert.equal(rules[2].text, 'PreToolUse on Bash → x');
});

test('coverage: counts, uncovered list, unknown ids, cases; results dir ignored', async () => {
  const c = await coverage(await fixture());
  assert.equal(c.total, 6, '3 CLAUDE.md + 2 skill + 1 hook');
  assert.equal(c.covered, 3); assert.equal(c.pct, 50);
  assert.deepEqual(c.uncovered, ['claude-md/notes-are-never-deleted-delete-means', 'claude-md/before-you-say-a-change', 'skill/spring-conventions/dtos-are-records-grouped-in-dtos']);
  assert.deepEqual(c.unknownCovers, [{ case: 'guard', id: 'nope/not-a-rule' }]);
  assert.deepEqual(c.rules.find((r) => r.id === 'hook/pretooluse-bash').cases, ['guard']);
  assert.equal(c.cases.length, 2);
  const md = markdown(c);
  assert.match(md, /\*\*50%\*\* \(3 of 6 rules have a case\)/); assert.match(md, /`claude-md\/notes-are-never-deleted-delete-means` — Notes are never deleted/); assert.match(md, /CLAUDE\.md:5/); assert.match(md, /unknown ids in `covers:` — guard: `nope\/not-a-rule`/);
});

test('empty plugin → no rules, null pct, grey badge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-empty-'));
  const c = await coverage(dir);
  assert.equal(c.total, 0); assert.equal(c.pct, null);
  assert.match(badgeSvg(c.pct), /no rules/); assert.match(badgeSvg(85), /#3fb950/); assert.match(badgeSvg(50), /#d29922/); assert.match(badgeSvg(10), /#f85149/);
  assert.match(markdown(c), /no rules found/);
});

test('CLI: --list, --json, --md, --badge', async () => {
  const dir = await fixture(); const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-out-'));
  const list = execFileSync('node', [TOOL, dir, '--list'], { encoding: 'utf8' });
  assert.match(list, /^✓ claude-md\/every-endpoint-returns-the-envelope-apiresponse\n {4}Every endpoint returns the envelope `ApiResponse` — never a bare list\. {2}\[envelope\]$/m);
  assert.match(list, /^· skill\/spring-conventions\/dtos-are-records-grouped-in-dtos$/m);
  execFileSync('node', [TOOL, dir, '--json', path.join(out, 'c.json'), '--md', path.join(out, 'c.md'), '--badge', path.join(out, 'b.svg')]);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'c.json'), 'utf8')).pct, 50);
  assert.match(await fs.readFile(path.join(out, 'b.svg'), 'utf8'), /50%/);
  assert.match(await fs.readFile(path.join(out, 'c.md'), 'utf8'), /^### Agent-config coverage: \*\*50%\*\*/);
});

test('CLI: --fail-under exits 1 under the bar, 0 at/above it, never on a rule-less plugin', async () => {
  const dir = await fixture(); // 50%
  assert.equal(spawnSync('node', [TOOL, dir, '--fail-under', '80'], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('node', [TOOL, dir, '--fail-under', '50'], { encoding: 'utf8' }).status, 0);
  const r = spawnSync('node', [TOOL, dir, '--fail-under', '80'], { encoding: 'utf8' });
  assert.match(r.stderr, /coverage 50% is under --fail-under 80/);
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-empty-'));
  assert.equal(spawnSync('node', [TOOL, empty, '--fail-under', '80'], { encoding: 'utf8' }).status, 0, 'null pct = no rules = exit 0');
  assert.equal(spawnSync('node', [TOOL, dir], { encoding: 'utf8' }).status, 0, 'no flag, no enforcement');
});
