import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { previousVersion, parseSuitesFile, parseOptOut, pluginDirFromPath, normaliseSuite, mergeSuites, classifyCase, headline, totalsOf, renderHtml } from '../tools/release-report.mjs';

const TOOL = new URL('../tools/release-report.mjs', import.meta.url).pathname;
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

test('previousVersion: the stable release right before, prereleases ignored', () => {
  assert.equal(previousVersion(['2.1.280', '2.1.287', '2.1.295-beta.1', '2.1.290', '2.1.295', '2.1.296'], '2.1.295'), '2.1.290');
  assert.equal(previousVersion(['2.1.295'], '2.1.295'), null);
});

test('suites file: YAML list or JSON; opt-out list; plugin dir from a code-search path', () => {
  assert.deepEqual(parseSuitesFile('# head\n- repo: a/b\n  path: plugins/x  # note\n  ref: v1\n- repo: "c/d"\n'), [{ repo: 'a/b', path: 'plugins/x', ref: 'v1' }, { repo: 'c/d' }]);
  assert.deepEqual(parseSuitesFile('[{"repo":"a/b"}]'), [{ repo: 'a/b' }]);
  assert.throws(() => parseSuitesFile('repo: a/b\n'), /cannot read line/);
  assert.deepEqual([...parseOptOut('# c\nOwner/Repo\n\nx/y # why\n')], ['owner/repo', 'x/y']);
  assert.equal(pluginDirFromPath('evals/case/prompt.md'), '.');
  assert.equal(pluginDirFromPath('plugins/p/evals/a/b/prompt.md'), 'plugins/p');
  assert.equal(pluginDirFromPath('src/prompt.md'), null);
});

test('normaliseSuite refuses unsafe repos, paths and refs; mergeSuites honours opt-out and lets the list win', () => {
  for (const repo of ['a/b/c', '../evil', 'a/..', '.x/y', '-a/b']) assert.match(normaliseSuite({ repo }).error, /owner\/name/, repo);
  assert.match(normaliseSuite({ repo: 'a/b', path: '../etc' }).error, /inside the repo/);
  assert.match(normaliseSuite({ repo: 'a/b', path: '/etc' }).error, /inside the repo/);
  assert.match(normaliseSuite({ repo: 'a/b', ref: '--upload-pack=x' }).error, /branch or tag/);
  assert.deepEqual(normaliseSuite({ repo: 'a/b', path: './p/' }, 'list'), { repo: 'a/b', path: 'p', ref: null, source: 'list' });
  const merged = mergeSuites([[normaliseSuite({ repo: 'a/b', ref: 'v2' }, 'list')], [normaliseSuite({ repo: 'A/b' }, 'discovered'), normaliseSuite({ repo: 'no/thanks' }, 'discovered')], [normaliseSuite({ repo: 'No/Thanks' }, 'previous')]], new Set(['no/thanks']));
  assert.deepEqual(merged.map((s) => `${s.repo}@${s.ref}:${s.source}`), ['a/b@v2:list']);
});

test('classifyCase covers every pair of outcomes; the headline reads like a sentence', () => {
  assert.equal(classifyCase(true, true), 'loads');
  assert.equal(classifyCase(true, false), 'broke');
  assert.equal(classifyCase(false, false), 'never-loaded');
  assert.equal(classifyCase(false, true), 'fixed');
  assert.equal(classifyCase(null, true), 'loads');
  assert.equal(classifyCase(null, false), 'fails');
  assert.equal(classifyCase(true, null), 'unchecked');
  const t = totalsOf([{ status: 'checked', cases: [{ status: 'loads' }, { status: 'never-loaded' }] }, { status: 'skipped', cases: [] }]);
  assert.equal(headline('2.1.295', t), 'Claude Code 2.1.295: 1 public suite, 2 cases. 1 load, 0 broke on this release, 1 never loaded');
  assert.equal(headline('2.1.295', { ...t, fixed: 2 }), 'Claude Code 2.1.295: 1 public suite, 2 cases. 1 load, 0 broke on this release, 2 fixed on this release, 1 never loaded');
});

test('renderHtml escapes everything that comes from a repo', () => {
  const html = renderHtml({ generatedAt: '2026-10-09T00:00:00Z', claudeCode: { version: '2.1.295', previous: '2.1.287' }, headline: 'h', totals: totalsOf([]), history: [],
    suites: [{ repo: 'a/b', path: '.', status: 'checked', stars: 3, description: '<img src=x onerror=alert(1)>', commit: 'abcdef1234', cases: [{ name: '<script>x</script>', status: 'broke', error: '"bad" & <worse>', doctor: null }] }] });
  assert.doesNotMatch(html, /<img src=x|<script>x/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /&quot;bad&quot; &amp; &lt;worse&gt;/);
});

// ---------- end to end: fixture repos, two fake runners, a fake GitHub API; no network ----------
const fm = (obj, body = '') => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
const GRADER = fm({ type: 'regex', pattern: 'ok', target: 'last_message' });
const ok = (extra = '') => ({ 'prompt.md': fm({ description: 'x' }, `Do it. ${extra}`), 'graders/g.md': GRADER });

async function gitRepo(base, repo, files) {
  const dir = path.join(base, `${repo}.git`);
  for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), text); }
  const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
}
const suiteFiles = (cases, prefix = '') => Object.fromEntries([[`${prefix}.claude-plugin/plugin.json`, '{"name":"p"}'], ...Object.entries(cases).flatMap(([c, files]) => Object.entries(files).map(([f, t]) => [`${prefix}evals/${c}/${f}`, t]))]);

// A fake claude for one version. The runner gets no env beyond PATH and HOME, so everything it needs is baked in.
// A case fails to load when its grader has no frontmatter ("graders: Required") or its prompt says FAILS_ON: <this version>.
async function fakeClaude(version, logDir) {
  const dir = await tmp(`fake-cc-${version}-`);
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('${version} (Claude Code)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(logDir, 'calls.jsonl'))}, JSON.stringify({ version: '${version}', argv: a, env: process.env, homeEntries: fs.readdirSync(process.env.HOME) }) + '\\n');
const evals = path.join(a[2], 'evals'); let failed = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (!e.isDirectory()) continue; const c = path.join(d, e.name);
  if (!fs.existsSync(path.join(c, 'prompt.md'))) { walk(c); continue; }
  const gd = path.join(c, 'graders'); const gs = fs.existsSync(gd) ? fs.readdirSync(gd).filter((f) => fs.readFileSync(path.join(gd, f), 'utf8').startsWith('---')) : [];
  if (!gs.length) { console.log('✗ ' + c + ': invalid case.yaml:   graders: Required'); failed++; }
  else if (fs.readFileSync(path.join(c, 'prompt.md'), 'utf8').includes('FAILS_ON: ${version}')) { console.log('✗ ' + c + ': prompt.md: unknown frontmatter key "covers"'); failed++; } } };
walk(evals);
if (failed) console.log(failed + ' case file(s) failed to load');
fs.writeFileSync(a[a.indexOf('--json') + 1], JSON.stringify({ schemaVersion: 1, claudeVersion: '${version}', costUsd: 0, partial: true, partialReason: 'cost_ceiling', cases: [] }));
process.exit(2);
`);
  await fs.chmod(bin, 0o755);
  return bin;
}

function fakeGitHub() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/search/code')) return send(200, { items: [
      { path: 'evals/new-key/prompt.md', repository: { full_name: 'acme/breaks' } },
      { path: 'evals/fine/prompt.md', repository: { full_name: 'acme/breaks' } },
      { path: 'plugins/design/evals/rubric/prompt.md', repository: { full_name: 'acme/prose' } },
      { path: 'evals/x/prompt.md', repository: { full_name: 'acme/other-harness' } },
      { path: 'evals/y/prompt.md', repository: { full_name: 'optout/repo' } },
      { path: 'evals/z/prompt.md', repository: { full_name: 'acme/missing' } },
    ] });
    const m = req.url.match(/^\/repos\/([^/]+\/[^/?]+)/);
    if (m) return send(200, { stargazers_count: m[1].length, description: m[1] === 'acme/breaks' ? 'Breaks <b>sometimes</b>' : null, size: m[1] === 'acme/huge' ? 999999 : 10 });
    send(404, {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, seen })));
}

const run = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (status) => resolve({ status, out, err }));
});

test('end to end: discovers, clones, load-checks under both versions in a bare env, classifies and publishes', async () => {
  const base = await tmp('rr-git-');
  await gitRepo(base, 'acme/stable', suiteFiles({ one: ok(), two: ok() }));
  await gitRepo(base, 'acme/breaks', suiteFiles({ 'new-key': ok('FAILS_ON: 2.1.295'), fine: ok(), 'back-again': ok('FAILS_ON: 2.1.287') }));
  await gitRepo(base, 'acme/prose', { 'README.md': 'x', ...suiteFiles({ rubric: { 'prompt.md': fm({ description: 'x' }, 'Design it.'), 'graders/rubric.md': '# Rubric\n\nPass when the page is good.\n' } }, 'plugins/design/') });
  await gitRepo(base, 'acme/other-harness', { 'evals/x/prompt.md': 'Not a plugin eval case.\n', 'evals/x/expected.json': '{}' });
  await gitRepo(base, 'optout/repo', suiteFiles({ y: ok() }));
  await gitRepo(base, 'acme/huge', suiteFiles({ big: ok() }));

  const logs = await tmp('rr-logs-');
  const next = await fakeClaude('2.1.295', logs), prev = await fakeClaude('2.1.287', logs);
  const gh = await fakeGitHub();
  const work = await tmp('rr-work-');
  const out = path.join(work, 'site');
  const suites = path.join(work, 'suites.yml');
  await fs.writeFile(suites, '- repo: acme/stable\n- repo: acme/huge\n- repo: optout/repo\n- repo: ../evil\n');
  const optOut = path.join(work, 'opt-out.txt');
  await fs.writeFile(optOut, '# asked to be left out\noptout/repo\n');
  const env = { CDC_GITHUB_API: gh.url, GITHUB_TOKEN: 'test-token', CDC_CLONE_BASE: `file://${base}/`, ANTHROPIC_API_KEY: 'sk-must-not-leak', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-must-not-leak' };
  try {
    const r = await run(['--version', '2.1.295', '--previous', '2.1.287', '--suites', suites, '--discover', '--opt-out', optOut, '--out-dir', out,
      '--runner', `2.1.295=${next}`, '--runner', `2.1.287=${prev}`], env);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /skipping a suites-file entry: not an owner\/name repo: \.\.\/evil/);
    assert.ok(gh.seen.every((s) => s.auth === 'Bearer test-token'));
    assert.ok(!gh.seen.some((s) => s.url.includes('optout')), 'opted-out repos are not even looked up');

    const rep = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
    const by = Object.fromEntries(rep.suites.map((s) => [s.repo, s]));
    assert.ok(!by['optout/repo'], 'opt-out wins over the explicit list and discovery');
    const statuses = (repo) => Object.fromEntries(by[repo].cases.map((c) => [c.name, c.status]));
    assert.deepEqual(statuses('acme/stable'), { one: 'loads', two: 'loads' });
    assert.deepEqual(statuses('acme/breaks'), { 'back-again': 'fixed', fine: 'loads', 'new-key': 'broke' });
    assert.deepEqual(statuses('acme/prose'), { rubric: 'never-loaded' });
    assert.equal(by['acme/prose'].path, 'plugins/design');
    const rubric = by['acme/prose'].cases[0];
    assert.equal(rubric.error, 'graders: Required');
    assert.equal(rubric.doctor.rule, 'grader-prose-rubric');
    assert.equal(rubric.doctor.fixable, true);
    assert.equal(by['acme/breaks'].cases.find((c) => c.name === 'new-key').error, 'unknown frontmatter key "covers"');
    assert.equal(by['acme/other-harness'].status, 'not-a-suite');
    assert.equal(by['acme/huge'].status, 'skipped');
    assert.match(by['acme/huge'].reason, /over the 200 MB cap/);
    assert.equal(by['acme/missing'].status, 'skipped');
    assert.match(by['acme/missing'].reason, /clone failed/);
    assert.equal(by['acme/breaks'].stars, 'acme/breaks'.length);
    assert.match(by['acme/stable'].commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(rep.totals, { suites: 3, cases: 6, loads: 3, broke: 1, fixed: 1, neverLoaded: 1, fails: 0, unchecked: 0 });
    assert.equal(rep.headline, 'Claude Code 2.1.295: 3 public suites, 6 cases. 3 load, 1 broke on this release, 1 fixed on this release, 1 never loaded');
    assert.ok(r.out.includes(rep.headline));

    // the runner saw a bare environment: PATH and an empty HOME, no tokens, no scaffold, the $0 ceiling
    const calls = (await fs.readFile(path.join(logs, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 6, 'three suites, two versions each');
    for (const c of calls) {
      assert.deepEqual(Object.keys(c.env).filter((k) => !['PWD', 'SHLVL', '_'].includes(k)).sort(), ['HOME', 'PATH']);
      assert.deepEqual(c.homeEntries, []);
      assert.equal(c.argv[c.argv.indexOf('--max-cost-usd') + 1], '0');
      for (const f of ['--trust-plugin', '--no-publish']) assert.ok(c.argv.includes(f));
      assert.ok(!c.argv.includes('--scaffold'));
    }
    assert.ok(!(await fs.readdir(work)).some((f) => f.startsWith('clones')), 'clones live in a temp dir that is removed');

    const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.includes(rep.headline));
    assert.match(html, /Suite authors: run <code>node tools\/suite-doctor\.mjs &lt;plugin&gt; --fix<\/code>/);
    assert.match(html, /open an issue to opt out/);
    assert.match(html, /href="https:\/\/github\.com\/acme\/breaks"/);
    assert.match(html, /Breaks &lt;b&gt;sometimes&lt;\/b&gt;/);
    assert.match(html, /broke on this release<\/span><\/td><td class="nm">new-key/);
    assert.match(html, /make it an llm grader.*\(<code>--fix<\/code> applies this\)/);
    assert.doesNotMatch(html, /other-harness/, 'repos that are not plugin eval suites get no card');
    assert.doesNotMatch(html, /optout/);
    assert.ok(existsSync(path.join(out, 'archive', '2.1.295.json')));
    assert.doesNotMatch(html + JSON.stringify(rep), /must-not-leak/);

    // the next release: no list, no discovery; the last report's suites carry over, and the history strip grows
    const next2 = await fakeClaude('2.1.296', logs);
    const r2 = await run(['--version', '2.1.296', '--previous', '2.1.295', '--opt-out', optOut, '--out-dir', out, '--runner', `2.1.296=${next2}`, '--runner', `2.1.295=${next}`], { ...env, CDC_GITHUB_API: gh.url });
    assert.equal(r2.status, 0, r2.err);
    const rep2 = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(rep2.suites.map((s) => s.repo).sort(), ['acme/breaks', 'acme/huge', 'acme/missing', 'acme/prose', 'acme/stable']);
    assert.equal(rep2.suites.find((s) => s.repo === 'acme/breaks').cases.find((c) => c.name === 'new-key').status, 'fixed', 'the 2.1.296 fake has no FAILS_ON for it');
    assert.deepEqual(rep2.history.map((h) => h.version), ['2.1.295', '2.1.296']);
    const html2 = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(html2, /Per release/);
    assert.match(html2, /<b class="mono">2\.1\.295<\/b>/);
  } finally { gh.srv.close(); }
});

test('a runner whose version does not match is refused before any suite is checked', async () => {
  const logs = await tmp('rr-logs-');
  const wrong = await fakeClaude('2.1.280', logs);
  const work = await tmp('rr-work-');
  await fs.writeFile(path.join(work, 's.yml'), '- repo: acme/x\n');
  const r = await run(['--version', '2.1.295', '--previous', '2.1.287', '--suites', path.join(work, 's.yml'), '--out-dir', path.join(work, 'out'), '--runner', `2.1.295=${wrong}`, '--runner', `2.1.287=${wrong}`], {});
  assert.equal(r.status, 1);
  assert.match(r.err, /the runner for 2\.1\.295 reports version 2\.1\.280/);
  assert.ok(!existsSync(path.join(logs, 'calls.jsonl')));
});

test('classifySuite: the suite-doctor suggestion shown is the one that answers the runner error', async () => {
  const { classifySuite } = await import('../tools/release-report.mjs');
  const suite = { pluginDir: '/x', cases: [{ name: 'c' }] };
  const err = { case: 'c', file: 'prompt.md', key: 'fixture', message: 'unknown frontmatter key "fixture"' };
  const findings = [
    { case: 'c', level: 'ERROR', rule: 'tool-used-max-zero-needs-min', file: 'graders/a.md', key: 'max', fix: 'add min: 0', fixable: true },
    { case: 'c', level: 'ERROR', rule: 'prompt-frontmatter-keys', file: 'prompt.md', key: 'fixture', fix: 'remove fixture:', fixable: false },
  ];
  const [c] = classifySuite(suite, { previous: { status: 'ok', loadErrors: [err] }, next: { status: 'ok', loadErrors: [err] } }, findings);
  assert.equal(c.status, 'never-loaded');
  assert.equal(c.doctor.rule, 'prompt-frontmatter-keys');
  assert.equal(c.doctor.more, 1);
});
