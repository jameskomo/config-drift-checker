import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { estimate, estimateTokens, parseTokens, parseDetails, measure, storeName, loadHistory, trend, headline } from '../tools/context-cost.mjs';

const TOOL = new URL('../tools/context-cost.mjs', import.meta.url).pathname;
const DASH = new URL('../tools/eval-dashboard.mjs', import.meta.url).pathname;

const ALPHA_DESC = 'Use when the user asks how the alpha service is deployed, configured or rolled back. Do not use for the beta service.';
const ALPHA_BODY = '# alpha\n\nDeploy with `make deploy-alpha`. Configuration lives in `config/alpha.yml`; never edit it on the server.';
const CLAUDE_MD = '# House rules\n\nAnswer in plain English. Run the tests before saying a change works.\n';
// one of every component: two skills, an agent, a command, CLAUDE.md, two hook events, an MCP server
const KITCHEN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'kitchen', version: '0.2.0', mcpServers: { notes: { command: 'node', args: ['notes.mjs'] } } }),
  'skills/alpha/SKILL.md': `---\nname: alpha\ndescription: ${ALPHA_DESC}\n---\n\n${ALPHA_BODY}\n`,
  'skills/beta/SKILL.md': '---\nname: beta\ndescription: Use for questions about the beta queue.\n---\n\nThe beta queue drains every five minutes.\n',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews a diff for correctness bugs before it is merged.\ntools: Read, Grep\n---\n\nYou are a careful reviewer.\n',
  'commands/deploy.md': '---\ndescription: Deploy the current branch to staging\n---\n\nRun the staging deploy and report the URL.\n',
  'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ready' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } }),
  'CLAUDE.md': CLAUDE_MD,
};
async function plugin(files = KITCHEN) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-cost-'));
  for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text); }
  return root;
}

// What Claude Code 2.1.295 prints for `claude --plugin-dir <kitchen> plugin details kitchen` (captured verbatim).
const DETAILS_295 = `kitchen 0.2.0
  Description: Fixture plugin with one of every component, for context-cost tests.
  Source: kitchen@inline

Component inventory
  Skills (3)  alpha, beta, deploy
  Agents (1)  reviewer
  Hooks (2)  SessionStart, PreToolUse  (harness-only — no model context cost)
  MCP servers (1)  notes  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~75 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  alpha            ~30        ~50
  beta            < 20        ~20
  reviewer        < 20        ~30
  deploy          < 20       < 20

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
`;

// A stand-in claude: records how it was called and answers `plugin details` per FAKE_MODE:
// default = 2.1.295 (--plugin-dir works), no-plugin-dir = only the skills-dir link resolves, old = no details
// command, garbage = exit 0 with nothing parseable.
async function fakeRunner() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), mode = process.env.FAKE_MODE ?? '';
if (a[0] === '--version') { console.log((process.env.FAKE_VERSION ?? '2.1.295') + ' (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME, cwd: process.cwd(),
  linked: fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'kitchen', '.claude-plugin', 'plugin.json')) }) + '\\n');
if (mode === 'old') { console.error("error: unknown command 'details'"); process.exit(1); }
if (mode === 'garbage') { console.log('hello'); process.exit(0); }
if (a[0] === '--plugin-dir' && mode === 'no-plugin-dir') { console.error("error: unknown option '--plugin-dir'"); process.exit(1); }
const name = a.at(-1);
const resolvable = a[0] === '--plugin-dir' || fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', name));
if (!resolvable) { console.log('Plugin "' + name + '" not found. Run \`claude plugin list\` to see installed plugins.'); process.exit(1); }
process.stdout.write(${JSON.stringify(DETAILS_295)}.replace('kitchen@inline', a[0] === '--plugin-dir' ? 'kitchen@inline' : 'kitchen@skills-dir'));
`);
  await fs.chmod(bin, 0o755);
  return { bin, log: path.join(dir, 'log.jsonl') };
}
const calls = async (log) => (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const emptyPath = async () => fs.mkdtemp(path.join(os.tmpdir(), 'no-claude-'));
async function cli(args, env = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, PATH: await emptyPath(), ...env } });
}

test('estimate: every component kind, characters / 4, harness-only hooks at 0 and MCP listings not counted', async () => {
  const e = estimate(await plugin());
  assert.deepEqual(e.plugin, { name: 'kitchen', version: '0.2.0' });
  assert.deepEqual(e.components.map((c) => `${c.kind}:${c.name}`), ['skill:alpha', 'skill:beta', 'agent:reviewer', 'command:deploy', 'claude-md:CLAUDE.md', 'hook:SessionStart', 'hook:PreToolUse', 'mcp:notes']);
  const alpha = e.components[0];
  assert.equal(alpha.alwaysOn, estimateTokens('alpha' + ALPHA_DESC), 'always-on is the name and description');
  assert.equal(alpha.onInvoke, estimateTokens(ALPHA_BODY), 'on-invoke is the body');
  assert.equal(e.components[4].alwaysOn, estimateTokens(CLAUDE_MD));
  assert.deepEqual(e.components.filter((c) => c.kind === 'hook').map((c) => [c.alwaysOn, c.onInvoke]), [[0, 0], [0, 0]]);
  assert.match(e.components.find((c) => c.name === 'SessionStart').note, /output can be added to context/);
  assert.equal(e.components.at(-1).alwaysOn, null);
  assert.equal(e.totals.alwaysOn, e.components.reduce((s, c) => s + (c.alwaysOn ?? 0), 0));
});

test('estimate: manifest skill paths win over skills/, and the fingerprint follows the files', async () => {
  const root = await plugin({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', skills: ['./custom/one', './more'] }),
    'custom/one/SKILL.md': '---\nname: one\ndescription: first\n---\nbody\n',
    'more/two/SKILL.md': '---\nname: two\ndescription: second\n---\nbody\n',
    'skills/ignored/SKILL.md': '---\nname: ignored\ndescription: not listed in the manifest\n---\n',
  });
  const a = estimate(root);
  assert.deepEqual(a.components.map((c) => c.name), ['one', 'two']);
  assert.equal(estimate(root).fingerprint, a.fingerprint, 'stable');
  await fs.appendFile(path.join(root, 'more/two/SKILL.md'), 'more body\n');
  assert.notEqual(estimate(root).fingerprint, a.fingerprint, 'an edit changes it');
  const bare = await plugin({ 'skills/x/SKILL.md': '---\ndescription: no name field\n---\n' });
  assert.equal(estimate(bare).plugin.name, path.basename(bare), 'no manifest: the dir name');
  assert.equal(estimate(bare).components[0].name, 'x', 'no name field: the skill dir name');
});

test('parse: token figures and the plugin details layout of 2.1.295', () => {
  assert.deepEqual(parseTokens('~75'), { tokens: 75, below: false });
  assert.deepEqual(parseTokens('~1.7k'), { tokens: 1700, below: false });
  assert.deepEqual(parseTokens('< 20'), { tokens: 20, below: true });
  assert.equal(parseTokens('lots'), null);
  const d = parseDetails(DETAILS_295);
  assert.deepEqual(d.plugin, { name: 'kitchen', version: '0.2.0' });
  assert.equal(d.alwaysOn, 75);
  assert.deepEqual(d.components.map((c) => [c.name, c.alwaysOn, c.onInvoke]), [['alpha', 30, 50], ['beta', 20, 20], ['reviewer', 20, 30], ['deploy', 20, 20]]);
  assert.deepEqual(d.components[3].below, ['alwaysOn', 'onInvoke']);
  assert.deepEqual(d.inventory.agents, { count: 1, names: ['reviewer'], note: null });
  assert.deepEqual(d.inventory.hooks.names, ['SessionStart', 'PreToolUse']);
  assert.match(d.inventory['mcp servers'].note, /not counted/);
  assert.equal(parseDetails('Usage: claude plugin [options]'), null);
});

test('official: plugin details via --plugin-dir in a throwaway config, no credentials, temp dir removed', async () => {
  const root = await plugin();
  const { bin, log } = await fakeRunner();
  const out = path.join(root, 'cost.json');
  const r = await cli([root, '--runner', bin, '--json', out], { FAKE_LOG: log, ANTHROPIC_API_KEY: 'sk-should-not-leak', CLAUDE_CODE_OAUTH_TOKEN: 'tok-should-not-leak' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /context-cost: kitchen 0\.2\.0 on Claude Code 2\.1\.295 \(official, from `claude plugin details`\)/);
  const m = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(m.source, 'official');
  assert.equal(m.claudeVersion, '2.1.295');
  assert.equal(m.official.via, 'plugin-dir');
  assert.equal(m.totals.alwaysOn, 75 + estimateTokens(CLAUDE_MD), 'official always-on plus CLAUDE.md, which plugin details does not count');
  assert.deepEqual(m.components.map((c) => `${c.kind}:${c.name}:${c.source}`), ['skill:alpha:official', 'skill:beta:official', 'agent:reviewer:official', 'command:deploy:official',
    'claude-md:CLAUDE.md:estimate', 'hook:SessionStart:estimate', 'hook:PreToolUse:estimate', 'mcp:notes:estimate']);
  assert.ok(m.estimate.totals.alwaysOn > 0, 'the estimate rides along for comparison');
  const [call] = await calls(log);
  assert.deepEqual(call.argv, ['--plugin-dir', root, 'plugin', 'details', 'kitchen']);
  assert.equal(call.key, null); assert.equal(call.token, null);
  assert.ok(!call.config.startsWith(os.homedir()) && call.config !== path.join(os.homedir(), '.claude'), 'never the real config');
  assert.notEqual(call.home, os.homedir());
  assert.equal(existsSync(call.config), false, 'the throwaway config dir is removed');
});

test('official: when --plugin-dir is not understood, a skills-dir link in the throwaway config resolves it', async () => {
  const { bin, log } = await fakeRunner();
  process.env.FAKE_LOG = log; process.env.FAKE_MODE = 'no-plugin-dir';
  try {
    const m = measure(await plugin(), { runner: bin });
    assert.equal(m.source, 'official');
    assert.equal(m.official.via, 'skills-dir');
    const cs = await calls(log);
    assert.equal(cs.length, 2);
    assert.deepEqual(cs[1].argv, ['plugin', 'details', 'kitchen']);
    assert.equal(cs[1].linked, true, 'the link points at the plugin dir');
  } finally { delete process.env.FAKE_LOG; delete process.env.FAKE_MODE; }
});

test('fallback: older Claude Code, unparseable output or no claude at all use the estimate and say why', async () => {
  const root = await plugin();
  const { bin, log } = await fakeRunner();
  const old = await cli([root, '--runner', bin, '--json', '-'], { FAKE_LOG: log, FAKE_MODE: 'old', FAKE_VERSION: '2.1.250' });
  assert.equal(old.status, 0, old.stderr);
  const m = JSON.parse(old.stdout);
  assert.equal(m.source, 'estimate');
  assert.equal(m.official.status, 'skipped');
  assert.match(m.official.reason, /Claude Code 2\.1\.250 has no `claude plugin details`/);
  assert.equal(m.claudeVersion, '2.1.250', 'the version is still recorded');
  assert.deepEqual(m.components, m.estimate.components.map((c) => ({ ...c, source: 'estimate' })));
  const garbage = await cli([root, '--runner', bin], { FAKE_LOG: log, FAKE_MODE: 'garbage' });
  assert.match(garbage.stdout, /\(estimate, characters \/ 4\)/);
  assert.match(garbage.stdout, /official figure failed: `claude plugin details kitchen` gave no token figures: hello; using the static estimate/);
  const none = await cli([root]);
  assert.match(none.stdout, /official figure skipped: no --runner given and no claude on PATH/);
});

test('store and md: the stored file is named <stamp>-cc<version>.json and the md has one row per component', async () => {
  const root = await plugin();
  const { bin, log } = await fakeRunner();
  const store = path.join(root, 'out', 'context-cost');
  const r = await cli([root, '--runner', bin, '--store', store, '--md', '-'], { FAKE_LOG: log });
  assert.equal(r.status, 0, r.stderr);
  const files = await fs.readdir(store);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}Z-cc2\.1\.295\.json$/);
  assert.equal(storeName({ generatedAt: '2026-10-09T14:05:06.789Z', claudeVersion: null }), '20261009T140506Z-ccunknown.json');
  assert.match(r.stdout, /^### Context cost: kitchen 0\.2\.0 on Claude Code 2\.1\.295/);
  assert.match(r.stdout, /\| alpha \| skill \| 30 \| 50 \| official \|/);
  assert.match(r.stdout, /\| deploy \| command \| < 20 \| < 20 \| official \|/);
  assert.match(r.stdout, /\| notes \| mcp \| not counted \| not counted \| estimate \|/);
  assert.doesNotMatch(r.stdout, /stored /, 'stdout carries only the md when --md -');
  assert.equal((await cli([])).status, 2);
  assert.equal((await cli([root, '--history', root])).status, 2, 'a plugin dir and --history are exclusive');
  assert.equal((await cli([root, '--json'])).status, 2);
});

// ---- history ----
const comp = (kind, name, alwaysOn, onInvoke = 0) => ({ kind, name, alwaysOn, onInvoke, source: 'official' });
const doc = (cc, at, components, { source = 'official', fingerprint = 'f1' } = {}) => ({ schemaVersion: 1, tool: 'context-cost', generatedAt: at, plugin: { name: 'kitchen', version: '0.2.0' },
  claudeVersion: cc, source, fingerprint, components, totals: { alwaysOn: components.reduce((s, c) => s + (c.alwaysOn ?? 0), 0), onInvoke: components.reduce((s, c) => s + (c.onInvoke ?? 0), 0) } });
const RELEASES = [
  doc('2.1.287', '2026-09-01T10:00:00Z', [comp('skill', 'alpha', 300, 900), comp('skill', 'beta', 100, 200)]),
  doc('2.1.290', '2026-09-05T10:00:00Z', [comp('skill', 'alpha', 300, 900), comp('skill', 'beta', 100, 200)]),
  doc('2.1.295', '2026-09-09T10:00:00Z', [comp('skill', 'alpha', 360, 950), comp('skill', 'beta', 100, 200), comp('agent', 'reviewer', 12, 40)]),
];
async function historyDir(docs, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-history-'));
  for (const d of docs) await fs.writeFile(path.join(dir, storeName(d)), JSON.stringify(d));
  for (const [f, text] of Object.entries(extra)) await fs.writeFile(path.join(dir, f), text);
  return dir;
}

test('history: one point per release, percent change between neighbours, biggest movers first', async () => {
  const dir = await historyDir([...RELEASES, { ...RELEASES[0], generatedAt: '2026-08-30T10:00:00Z', totals: { alwaysOn: 1, onInvoke: 1 } }], { 'aggregate.json': '{"cases":[]}', 'broken.json': '{' });
  const runs = loadHistory(dir);
  assert.equal(runs.length, 4, 'files that are not context-cost measurements are ignored');
  const t = trend(runs);
  assert.deepEqual(t.points.map((p) => [p.claudeVersion, p.alwaysOn]), [['2.1.287', 400], ['2.1.290', 400], ['2.1.295', 472]], 'the newest run on a version wins');
  assert.equal(t.steps[0].alwaysOn.pct, 0);
  assert.equal(t.steps[1].alwaysOn.pct, 18);
  assert.equal(t.steps[1].sameFiles, true);
  assert.deepEqual(t.steps[1].movers.map((m) => [m.name, m.status, m.alwaysOn.delta]), [['alpha', 'changed', 60], ['reviewer', 'added', 12]]);
  assert.equal(t.steps[1].movers[0].alwaysOn.pct, 20);
  assert.equal(t.headline, 'Your setup got 18% more expensive on Claude Code 2.1.295: 400 to 472 always-on tokens per session (was 2.1.290). Your files did not change, so the difference comes from Claude Code.');
});

test('history: edits and source changes are called out; a single release has no trend yet', () => {
  const edited = trend([RELEASES[1], { ...RELEASES[2], fingerprint: 'f2' }]);
  assert.match(edited.headline, /Your files changed too, so part of the difference is your own edits\.$/);
  const mixed = trend([{ ...RELEASES[1], source: 'estimate' }, RELEASES[2]]);
  assert.equal(mixed.steps[0].comparable, false);
  assert.match(mixed.headline, /measurement source changed between these releases, so the numbers are not directly comparable/);
  const cheaper = trend([RELEASES[2], { ...RELEASES[1], claudeVersion: '2.1.296', generatedAt: '2026-09-10T10:00:00Z' }]);
  assert.match(cheaper.headline, /^Your setup got 15% cheaper on Claude Code 2\.1\.296: 472 to 400/);
  assert.match(trend([RELEASES[0]]).headline, /about 400 tokens to every session on Claude Code 2\.1\.287 \(official\)\. One release measured so far/);
  assert.equal(headline(null, null), 'No context-cost measurements yet.');
});

test('history CLI: text, md and json', async () => {
  const dir = await historyDir(RELEASES);
  const r = await cli(['--history', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /context-cost history: 3 release\(s\) of kitchen/);
  assert.match(r.stdout, /cc2\.1\.295 {2}always-on 472 \(\+18%\) {2}on-invoke 1,190 \(\+8\.2%\) {2}official/);
  assert.match(r.stdout, /biggest movers 2\.1\.290 to 2\.1\.295 \(same files\):\n {4}skill alpha: always-on 300 to 360 \(\+20%\), on-invoke 900 to 950 \(\+5\.6%\)\n {4}agent reviewer: added, 12 always-on/);
  const md = await cli(['--history', dir, '--md', '-']);
  assert.match(md.stdout, /\| 2\.1\.295 \| 472 \| \+18% \| 1,190 \| \+8\.2% \| official \|/);
  const json = JSON.parse((await cli(['--history', dir, '--json', '-'])).stdout);
  assert.equal(json.tool, 'context-cost-history');
  assert.equal(json.latest.claudeVersion, '2.1.295');
  assert.equal((await cli(['--history', path.join(dir, 'missing')])).status, 2);
});

// ---- dashboard integration ----
const run = (cc, at) => ({ schemaVersion: '1.1', track: 'pinned', shim: true, generatedAt: at, suite: { name: 'fixture' }, harness: { name: 'claude-code', version: cc },
  cases: [{ dir: 'a', name: 'a', arms: { with: [{ runIndex: 0, score: 1, numTurns: 4, costUsd: 0.1, durationMs: 5000, model: 'm1', isError: false, toolUses: [], graders: [] }] }, summary: { score: 1 } }],
  aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: 1, costUsd: 0.1, resolvedModels: ['m1'] } });
async function dashboard(costFiles) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dash-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (const [i, cc] of ['2.1.287', '2.1.290', '2.1.295'].entries()) await fs.writeFile(path.join(hist, `2026090${i + 1}T100000Z-cc${cc}-shim-pinned.json`), JSON.stringify(run(cc, `2026-09-0${i + 1}T10:00:00Z`)));
  if (costFiles) { await fs.mkdir(path.join(hist, 'context-cost')); for (const [f, text] of Object.entries(costFiles)) await fs.writeFile(path.join(hist, 'context-cost', f), text); }
  const out = path.join(dir, 'index.html');
  const r = spawnSync(process.execPath, [DASH, hist, '--out', out, '--title', 'ccsuite'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const verdicts = JSON.parse(await fs.readFile(path.join(dir, 'verdicts.json'), 'utf8'));
  delete verdicts.generatedAt;
  return { html: await fs.readFile(out, 'utf8'), verdicts };
}

test('dashboard: without context-cost files the page and verdicts.json are byte-identical', async () => {
  const none = await dashboard(null);
  const empty = await dashboard({});
  const unrelated = await dashboard({ 'notes.json': '{"hello":1}', 'readme.txt': 'x' });
  assert.equal(empty.html, none.html);
  assert.equal(unrelated.html, none.html);
  assert.deepEqual(empty.verdicts, none.verdicts);
  assert.deepEqual(unrelated.verdicts, none.verdicts);
  assert.doesNotMatch(none.html, /Context cost|class="ccb"|\.cch|\.ccm/);
  assert.ok(!('contextCost' in none.verdicts));
});

test('dashboard: context-cost files add the strip after setup health and a contextCost key to verdicts.json', async () => {
  const files = Object.fromEntries(RELEASES.map((d) => [storeName(d), JSON.stringify(d)]));
  const { html, verdicts } = await dashboard(files);
  assert.match(html, /Context cost per Claude Code release <span>always-on tokens added to every session · official<\/span>/);
  assert.match(html, /<p class="cch">Your setup got 18% more expensive on Claude Code 2\.1\.295/);
  const bars = [...html.matchAll(/<rect class="ccb" [^>]*fill="var\(--(\w+)\)"><title>([^<]*)<\/title>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(bars.map((b) => b[0]), ['track', 'track', 'warn'], 'only the 18% rise wears the warn tone');
  assert.equal(bars[2][1], 'cc2.1.295 · 472 always-on tokens · official · +18% vs 2.1.290 · most moved: skill alpha');
  assert.match(html, /Biggest movers 2\.1\.290 to 2\.1\.295<\/div><ul class="ccm"><li><span class="mono">skill alpha<\/span> always-on 300 to 360 \(\+20%\), on-invoke 900 to 950<\/li>/);
  assert.equal(verdicts.contextCost.latest, '2.1.295');
  assert.deepEqual(verdicts.contextCost.versions.map((v) => [v.claudeCode, v.alwaysOn, v.changePct]), [['2.1.295', 472, 18], ['2.1.290', 400, 0], ['2.1.287', 400, null]]);
  for (const k of ['suite', 'pageUrl', 'streak', 'verdicts']) assert.ok(k in verdicts, k);
});

test('dashboard: component names in the strip are HTML-escaped', async () => {
  const evil = '<script>x</script>';
  const docs = [RELEASES[0], doc('2.1.295', '2026-09-09T10:00:00Z', [comp('skill', evil, 900), comp('skill', 'beta', 100, 200)])];
  const { html } = await dashboard(Object.fromEntries(docs.map((d) => [storeName(d), JSON.stringify(d)])));
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});
