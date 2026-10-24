import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prImpact, markdown, globFor, diffRules, kindOf, MARKER } from '../tools/pr-impact.mjs';

const CLI = new URL('../tools/pr-impact.mjs', import.meta.url).pathname;
const DIFF = new URL('../tools/eval-diff.mjs', import.meta.url).pathname;

const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
async function put(root, files) {
  for (const [p, body] of Object.entries(files)) {
    const f = path.join(root, p);
    if (body === null) { await fs.rm(f, { force: true }); continue; }
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
  }
}
const commit = (repo, msg) => { sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', msg); return sh(repo, 'rev-parse', 'HEAD'); };

const P = 'plugins/p';
const BASE = {
  [`${P}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'p', hooks: './hooks/hooks.json' }),
  [`${P}/CLAUDE.md`]: '# House rules\n\n- Never force push to the main branch under any circumstances.\n- Keep commits small and focused on one change.\n',
  [`${P}/skills/conventions/SKILL.md`]: '---\nname: conventions\ndescription: Spring conventions. Use for Spring Boot code. Do not use for Vue.\n---\n# Conventions\n\n- Use constructor injection for every Spring bean.\n- Return records from service methods, never entities.\n',
  [`${P}/hooks/hooks.json`]: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/guard.mjs' }] }] } }),
  [`${P}/hooks-handlers/guard.mjs`]: 'process.exit(0);\n',
  [`${P}/evals/push-rule/prompt.md`]: '---\nruns: 3\n---\nPush it.\n',
  [`${P}/evals/push-rule/covers.yaml`]: '- claude-md/never-force-push-to-the-main\n',
  [`${P}/evals/service-records/prompt.md`]: 'Write a service.\n',
  [`${P}/evals/service-records/covers.yaml`]: '- skill/conventions/return-records-from-service-methods-never\n',
  [`${P}/evals/guard-blocks/prompt.md`]: 'Reset hard.\n',
  [`${P}/evals/guard-blocks/covers.yaml`]: '- hook/pretooluse-bash\n',
  [`${P}/evals/trigger-only/prompt.md`]: 'Hello.\n',
  [`${P}/evals/trigger-only/covers.yaml`]: '[]\n',
  'README.md': 'repo\n',
};

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-impact-'));
  sh(root, 'init', '-q', '-b', 'main');
  await put(root, BASE);
  const base = commit(root, 'base');
  return { root, base };
}

test('a config PR: cost delta, edited, renamed and added rules, hook script, minimal cases, uncovered rules', async () => {
  const { root, base } = await repo();
  sh(root, 'checkout', '-qb', 'feature');
  await put(root, {
    // same first six words (same id), different ending: edited
    [`${P}/CLAUDE.md`]: '# House rules\n\n- Never force push to the main branch, ask a maintainer first.\n- Keep commits small and focused on one change.\n- Write the changelog entry in the same pull request.\n',
    // first words change: the id changes, the old covers.yaml entry dangles
    [`${P}/skills/conventions/SKILL.md`]: '---\nname: conventions\ndescription: Spring conventions. Use for Spring Boot code. Do not use for Vue.\n---\n# Conventions\n\n- Use constructor injection for every Spring bean.\n- Services return records from their methods, never entities.\n',
    [`${P}/hooks-handlers/guard.mjs`]: 'if (process.argv.includes("reset")) process.exit(2);\n',
    [`${P}/agents/reviewer.md`]: '---\nname: reviewer\ndescription: Reviews pull requests for the house rules and conventions.\n---\nReview the diff.\n',
  });
  const head = commit(root, 'feature');
  const r = await prImpact({ repo: root, base: 'main', head, plugin: P });
  assert.equal(r.touched, true);
  assert.equal(r.selection, 'cases');
  assert.deepEqual(r.cases, ['guard-blocks', 'push-rule', 'service-records']);
  assert.equal(r.glob, '*', 'no single pattern names these three and not trigger-only');
  assert.equal(r.globExact, false); assert.deepEqual(r.globAlsoMatches, ['trigger-only']);
  assert.equal(r.braceGlob, '{guard-blocks,push-rule,service-records}');
  assert.equal(r.base.sha, base); assert.equal(r.base.mergeBase, true);

  const byId = Object.fromEntries(r.rules.changed.map((x) => [x.id, x]));
  assert.equal(byId['claude-md/never-force-push-to-the-main'].change, 'edited');
  assert.deepEqual(byId['claude-md/never-force-push-to-the-main'].cases, ['push-rule']);
  const renamed = r.rules.changed.find((x) => x.was === 'skill/conventions/return-records-from-service-methods-never');
  assert.equal(renamed.change, 'edited'); assert.deepEqual(renamed.cases, ['service-records'], 'the cases of the old id still run');
  assert.equal(byId['hook/pretooluse-bash'].change, 'edited');
  assert.deepEqual(byId['hook/pretooluse-bash'].why, ['its script hooks-handlers/guard.mjs changed']);
  const added = r.rules.changed.find((x) => x.change === 'added');
  assert.match(added.id, /^claude-md\/write-the-changelog-entry/);
  assert.deepEqual(added.cases, []);
  assert.ok(r.uncovered.some((u) => u.kind === 'rule' && u.id === added.id));
  assert.ok(r.uncovered.some((u) => u.kind === 'file' && u.file === 'agents/reviewer.md' && u.change === 'added'));
  assert.deepEqual(r.staleCovers.map((s) => [s.case, s.renamedTo]), [['service-records', renamed.id]]);
  assert.ok(r.contextCost.alwaysOn.delta > 0);
  assert.ok(r.contextCost.components.some((c) => c.kind === 'agent' && c.name === 'reviewer' && c.status === 'added'));

  const md = markdown(r);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\*\*This PR adds \d+ always-on tokens to every session \(\+\d+%\)/);
  assert.match(md, /Source: estimate, characters \/ 4\./);
  assert.match(md, /\| reviewer \(added\) \| agent \|/);
  assert.match(md, /\*\*Cases to run: 3\*\*, `--case '\*'` \(one pattern also matches `trigger-only`/);
  assert.match(md, /- `guard-blocks`: covers `hook\/pretooluse-bash` \(edited\)/);
  assert.match(md, new RegExp(`- rule \`${added.id}\` was added and no case tests it`));
  assert.match(md, /- `agents\/reviewer\.md` was added and no case tests it/);
  assert.match(md, /- `service-records` names `skill\/conventions\/return-records-from-service-methods-never`, which this PR renamed to/);
  assert.doesNotMatch(md, new RegExp('[' + String.fromCharCode(0x2014, 0x2013, 0x7e) + ']'), 'plain punctuation');
});

test('a PR that touches no agent config selects nothing; a case-only PR selects that case exactly', async () => {
  const { root } = await repo();
  await put(root, { 'README.md': 'repo, now with docs\n' });
  commit(root, 'docs');
  const none = await prImpact({ repo: root, base: 'HEAD^', plugin: P });
  assert.equal(none.touched, false); assert.equal(none.selection, 'none'); assert.deepEqual(none.cases, []); assert.equal(none.glob, null);
  assert.match(markdown(none), /touches no agent-config files/);
  await put(root, { [`${P}/evals/push-rule/prompt.md`]: '---\nruns: 5\n---\nPush it now.\n' });
  commit(root, 'case');
  const one = await prImpact({ repo: root, base: 'HEAD^', plugin: P });
  assert.deepEqual(one.cases, ['push-rule']); assert.equal(one.glob, 'push-rule'); assert.equal(one.globExact, true);
  assert.deepEqual(one.reasons['push-rule'], ['its own files changed']);
  assert.match(one.contextCost.headline, /does not change the always-on tokens/);
});

test('symlinks in the tree are skipped, never followed into the comment', async () => {
  const { root } = await repo();
  const secret = path.join(root, '..', `secret-${path.basename(root)}.md`);
  await fs.writeFile(secret, '- this secret bullet must never be printed anywhere\n');
  await fs.mkdir(path.join(root, P, 'skills/evil'), { recursive: true });
  symlinkSync(secret, path.join(root, P, 'skills/evil/SKILL.md'));
  commit(root, 'evil');
  const r = await prImpact({ repo: root, base: 'HEAD^', plugin: P });
  assert.ok(r.skipped.includes('skills/evil/SKILL.md'));
  assert.doesNotMatch(JSON.stringify(r) + markdown(r), /secret bullet/);
  await fs.rm(secret);
});

test('CLI: --json carries cases and glob, --md - prints the comment; the glob feeds eval-diff --case', async () => {
  const { root } = await repo();
  await put(root, { [`${P}/skills/conventions/SKILL.md`]: BASE[`${P}/skills/conventions/SKILL.md`].replace('every Spring bean', 'every Spring bean and component') });
  commit(root, 'skill');
  const out = path.join(root, '..', `impact-${path.basename(root)}.json`);
  const r = spawnSync('node', [CLI, '--base', 'HEAD^', '--plugin', P, '--json', out, '--md', '-'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(MARKER));
  const j = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(j.cases, ['service-records'], 'the edited bullet is uncovered, its file still selects the skill case');
  assert.equal(j.glob, 'service-records');
  assert.ok(j.uncovered.some((u) => u.id === 'skill/conventions/use-constructor-injection-for-every-spring'));
  assert.equal(spawnSync('node', [CLI, '--plugin', P], { cwd: root }).status, 2, 'usage error without --base');
  assert.equal(spawnSync('node', [CLI, '--base', 'no-such-ref', '--plugin', P], { cwd: root }).status, 2);

  // a run of only the selected cases is not red for the baseline cases outside the glob
  const res = (cases) => ({ schemaVersion: '1.1', track: 'pinned', generatedAt: `2026-09-0${cases.length}T00:00:00Z`, suite: { name: 'p' },
    cases: cases.map((dir) => ({ dir, name: dir, arms: { with: [1, 1, 1].map((score) => ({ score, isError: false, graders: [] })) }, summary: { score: 1 } })), aggregates: { erroredRuns: 0, totalRuns: 3 } });
  const b = path.join(root, '..', `b-${path.basename(root)}.json`), c = path.join(root, '..', `c-${path.basename(root)}.json`);
  await fs.writeFile(b, JSON.stringify(res(['push-rule', 'service-records', 'guard-blocks'])));
  await fs.writeFile(c, JSON.stringify(res(['service-records'])));
  const red = spawnSync('node', [DIFF, b, c], { encoding: 'utf8' });
  assert.equal(red.status, 1, 'without the selection, unselected cases read as missing');
  const ok = spawnSync('node', [DIFF, b, c, '--case', j.glob], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /case selection `service-records`: 2 baseline cases outside it not compared/);
  for (const f of [out, b, c]) await fs.rm(f);
});

test('globFor: exact single pattern when one exists, else the narrowest superset', () => {
  const all = ['spring-a-records', 'spring-b-records', 'spring-trigger', 'vue-x'];
  assert.deepEqual(globFor(['spring-a-records', 'spring-b-records'], all), { glob: 'spring-*-records', exact: true, alsoMatches: [] });
  assert.deepEqual(globFor(['spring-a-records', 'spring-trigger'], all), { glob: 'spring-*', exact: false, alsoMatches: ['spring-b-records'] });
  assert.deepEqual(globFor(['vue-x'], all), { glob: 'vue-x', exact: true, alsoMatches: [] });
  assert.equal(globFor([], all).glob, null);
});

test('diffRules and kindOf: identical text is unchanged even when its id moved; config vs case vs other', () => {
  const r = (id, text, extra = {}) => ({ id, text, scope: 'claude-md', source: 'CLAUDE.md', heading: 'H', cases: [], ...extra });
  const out = diffRules([r('claude-md/a', 'Keep it small'), r('claude-md/b', 'Never push to main without review')], [r('claude-md/a-2', 'Keep it small'), r('claude-md/b', 'Never push to main without two reviews')]);
  assert.deepEqual(out.map((x) => [x.change, x.id]), [['moved', 'claude-md/a-2'], ['edited', 'claude-md/b']]);
  assert.equal(kindOf('CLAUDE.md'), 'config');
  assert.equal(kindOf('skills/x/references/api.md'), 'config');
  assert.equal(kindOf('.mcp.json'), 'config');
  assert.equal(kindOf('evals/case-a/prompt.md'), 'case');
  assert.equal(kindOf('evals/results/x.json'), 'eval');
  assert.equal(kindOf('scripts/guard.sh', { hookTexts: ['PreToolUse on Bash: bash ${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh'] }), 'hook-script');
  assert.equal(kindOf('README.md'), 'other');
});
