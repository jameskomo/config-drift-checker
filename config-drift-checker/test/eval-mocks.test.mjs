import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseMockFile, checkExpectRegex, checkExpect, renderMock, loadMocks, declaredServers, planMocks } from '../tools/eval-mocks.mjs';

const SHIM = new URL('../tools/eval-shim.mjs', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const TOOL = 'mcp__plugin_fixture-plugin_tracker__create_issue';

// The docs' own example: evals/mocks/tracker/create_issue.md
const CREATE_ISSUE = '---\nexpect:\n  title: string\n  priority: [low, medium, high]\n---\n\nCreated issue #4821: {{input.title}}\n';

// A plugin that declares a `tracker` MCP server (whose command must never start) and one case that
// should file an issue; graders are written per test.
async function makePlugin({ graders = {}, mocks = { 'tracker/create_issue.md': CREATE_ISSUE }, caseMocks = {}, runs = 1 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-plugin-'));
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.1' }));
  await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: { command: '/bin/false', args: ['real-server-must-not-start'] } } }));
  await fs.mkdir(path.join(dir, 'skills/triage'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills/triage/SKILL.md'), '---\nname: triage\ndescription: "files issues"\n---\nbody\n');
  const c = path.join(dir, 'evals/file-issue');
  await fs.mkdir(path.join(c, 'graders'), { recursive: true });
  await fs.writeFile(path.join(c, 'prompt.md'), `---\nruns: ${runs}\nmax_turns: 4\n---\nFile an issue for the login bug and say DONE.\n`);
  await fs.writeFile(path.join(c, 'graders/done.md'), '---\ntype: regex\npattern: DONE\n---\nSays DONE.\n');
  for (const [name, body] of Object.entries(graders)) await fs.writeFile(path.join(c, 'graders', name), body);
  for (const [rel, body] of Object.entries(mocks)) { await fs.mkdir(path.dirname(path.join(dir, 'evals/mocks', rel)), { recursive: true }); await fs.writeFile(path.join(dir, 'evals/mocks', rel), body); }
  for (const [rel, body] of Object.entries(caseMocks)) { await fs.mkdir(path.dirname(path.join(c, 'mocks', rel)), { recursive: true }); await fs.writeFile(path.join(c, 'mocks', rel), body); }
  return dir;
}

async function runShim(plugin, extraArgs = [], mcpCalls = [], { ablation = 'none' } = {}) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-bin-'));
  await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 });
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-state-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-out-'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_MCP: JSON.stringify(mcpCalls), CLAUDE_CONFIG_DIR: await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-')) };
  const r = spawnSync('node', [SHIM, plugin, '--ablation', ablation, '--no-isolate', '--output-dir', out, ...extraArgs], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(await fs.readFile(path.join(out, 'aggregate-result.json'), 'utf8'));
  let calls = [];
  try { calls = (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.done); } catch {}
  return { report, calls, stderr: r.stderr };
}
const flagValues = (call, flag) => { const i = call.args.indexOf(flag); return i < 0 ? [] : call.args.slice(i + 1, call.args.findIndex((a, j) => j > i && a.startsWith('--')) >>> 0); };

// ---------- the format ----------
test('parseMockFile: the docs example, block lists, error:, a body with no frontmatter', () => {
  assert.deepEqual(parseMockFile(CREATE_ISSUE), { meta: { expect: { title: 'string', priority: ['low', 'medium', 'high'] } }, body: 'Created issue #4821: {{input.title}}' });
  const block = parseMockFile("---\ntype: fixed\nerror: true\nexpect:\n  'labels.0': /^bug$/i\n  priority:\n    - low\n    - high\n---\nnope\n");
  assert.deepEqual(block.meta, { type: 'fixed', error: true, expect: { 'labels.0': '/^bug$/i', priority: ['low', 'high'] } });
  assert.deepEqual(parseMockFile('---\ntype: agent\ntools: [search, fetch]\n---\nact as the server\n').meta, { type: 'agent', tools: ['search', 'fetch'] });
  assert.deepEqual(parseMockFile('just the result\n'), { meta: {}, body: 'just the result' });
});

test('checkExpectRegex: the documented dialect is accepted, groups, alternation, backreferences and other flags are not', () => {
  for (const ok of ['/^bug$/', '/[a-z]+-\\d{2,4}/i', '/a.b?c*/s', '/^\\w+@x\\.com$/', '/x{3}/']) assert.equal(checkExpectRegex(ok), null, ok);
  assert.match(checkExpectRegex('/(a)/'), /group/);
  assert.match(checkExpectRegex('/a|b/'), /alternation/);
  assert.match(checkExpectRegex('/(a)\\1/'), /group/);
  assert.match(checkExpectRegex('/a\\1/'), /backreference/);
  assert.match(checkExpectRegex('/a/g'), /only i and s/);
  assert.match(checkExpectRegex('/a*?/'), /quantifier on a quantifier/);
  assert.match(checkExpectRegex('/a^b/'), /anchor/);
});

test('checkExpect: type names, regexes, literals, lists and dotted paths', () => {
  const expect = { title: 'string', priority: ['low', 'medium', 'high'], 'meta.team': '/^core-\\d+$/', count: 3, tags: 'array' };
  assert.equal(checkExpect({ title: 'Login bug', priority: 'high', meta: { team: 'core-7' }, count: 3, tags: [] }, expect), null);
  assert.match(checkExpect({ title: 5, priority: 'high', meta: { team: 'core-7' }, count: 3, tags: [] }, expect), /title: expected string, got 5/);
  assert.match(checkExpect({ title: 'x', priority: 'urgent', meta: { team: 'core-7' }, count: 3, tags: [] }, expect), /priority: "urgent" is not one of "low", "medium", "high"/);
  assert.match(checkExpect({ title: 'x', priority: 'low', meta: {}, count: 3, tags: [] }, expect), /meta\.team: nothing does not match/);
  assert.match(checkExpect({ title: 'x', priority: 'low', meta: { team: 'core-7' }, count: 4, tags: [] }, expect), /count: expected 3, got 4/);
});

test('renderMock: input fields, nested fields, fixtures named by input, and no escape from the mock dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-dir-'));
  await fs.mkdir(path.join(dir, 'fixtures'));
  await fs.writeFile(path.join(dir, 'fixtures/42.json'), '{"id":42}');
  assert.equal(renderMock('Created #{{input.n}}: {{input.issue.title}}{{input.missing}}', { n: 1, issue: { title: 'T' } }, dir), 'Created #1: T');
  assert.equal(renderMock('{{file:fixtures/{input.id}.json}}', { id: 42 }, dir), '{"id":42}');
  assert.match(renderMock('{{file:fixtures/{input.id}.json}}', { id: '../../etc/passwd' }, dir), /outside the mock directory/);
  assert.match(renderMock('{{file:fixtures/{input.id}.json}}', { id: 7 }, dir), /not found/);
});

test('loadMocks + planMocks: case files override suite files tool by tool; servers shadow the plugin or stand alone', async () => {
  const plugin = await makePlugin({
    mocks: { 'tracker/create_issue.md': CREATE_ISSUE, 'tracker/close_issue.md': 'closed', 'weather/forecast.md': 'sunny', 'tracker/_tools.json': JSON.stringify({ tools: [{ name: 'close_issue', description: 'Close it', inputSchema: { type: 'object' } }] }) },
    caseMocks: { 'tracker/close_issue.md': '---\nerror: true\n---\nalready closed' },
  });
  const { servers, problems } = loadMocks(path.join(plugin, 'evals'), path.join(plugin, 'evals/file-issue'));
  assert.deepEqual(problems, []);
  assert.equal(servers.get('tracker').tools.get('close_issue').body, 'already closed');
  assert.equal(servers.get('tracker').tools.get('close_issue').error, true);
  assert.equal(servers.get('tracker').listing[0].description, 'Close it');
  const plan = planMocks(servers, 'fixture-plugin', declaredServers(plugin).servers);
  const tracker = plan.find((p) => p.dir === 'tracker'), weather = plan.find((p) => p.dir === 'weather');
  assert.equal(tracker.shadow, true); assert.equal(tracker.key, 'plugin_fixture-plugin_tracker');
  assert.deepEqual(tracker.fullNames.sort(), ['mcp__plugin_fixture-plugin_tracker__close_issue', TOOL]);
  assert.equal(weather.shadow, false); assert.deepEqual(weather.fullNames, ['mcp__weather__forecast']);
});

test('loadMocks: what stops the official runner loading a case is reported', async () => {
  const plugin = await makePlugin({ mocks: {
    'tracker/a.md': '---\nexpect:\n  title: /(x|y)/\n---\nr',
    'tracker/b.md': '---\ntype: agent\nerror: true\n---\nr',
    'tracker/c.md': '---\nabort_when: never\ncolour: red\n---\nr',
    'tracker/_server.md': '---\ntype: agent\ntools: [d, e]\nexpect:\n  q: string\n---\nact',
    'bad.name/x.md': 'r',
    'tracker/stub.md': 'TODO: replace with the canned result this tool should return',
    'tracker/listy.md': '---\ntools: [a]\n---\nr',
    'tracker/two__parts.md': 'r',
    'tracker/think.md': '---\ntype: agent\n---\n',
    'empty/_tools.json': '{"tools": [{"name": "x"}]}',
    'shape/_tools.json': '{"tools": "nope"}',
  } });
  const { problems } = loadMocks(path.join(plugin, 'evals'), null);
  const said = problems.map((p) => `${p.file} ${p.message}`).join('\n');
  assert.match(said, /a\.md expect\.title: \/\(x\|y\)\/ uses a group/);
  assert.match(said, /b\.md error: applies to type: fixed mocks only/);
  assert.match(said, /c\.md unknown mock key colour:/);
  assert.match(said, /c\.md abort_when: applies to type: agent mocks only/);
  assert.match(said, /_server\.md expect: in _server\.md is a load error unless tools: lists a single tool/);
  assert.match(said, /mocks\/bad\.name\/ is not a tool-name segment/);
  assert.match(said, /stub\.md still holds the scaffolded placeholder/);
  assert.match(said, /listy\.md tools: belongs in _server\.md/);
  assert.match(said, /two__parts\.md: name tool files after the tool/);
  assert.match(said, /think\.md a type: agent mock needs a description of the server it plays/);
  assert.match(said, /shape\/_tools\.json expected a saved tools\/list response/);
  assert.equal(problems.find((p) => p.file === 'mocks/empty').level, 'WARN', 'a server with no responders is a warning: nothing is mocked for it');
});

// ---------- the shim end to end, with a real stdio MCP mock server ----------
test('record mode: the plugin server never starts, the mock answers under the plugin\'s tool name, mock_calls grades it', async () => {
  const plugin = await makePlugin({ graders: {
    'called.md': '---\ntype: regex\ntarget: mock_calls\npattern: \'"output":"Created issue #4821: Login bug","verdict":"ok"\'\n---\nFiled it.\n',
    'once.md': '---\ntype: regex\ntarget: mock_calls\npattern: create_issue\nmatch: "count:1"\n---\nOnce.\n',
  } });
  const { report, calls } = await runShim(plugin, [], [{ tool: TOOL, input: { title: 'Login bug', priority: 'high' } }]);
  const call = calls[0];
  assert.deepEqual(Object.keys(call.mcpConfig.mcpServers), ['plugin_fixture-plugin_tracker']);
  assert.notEqual(flagValues(call, '--plugin-dir')[0], plugin, 'the with arm loads a copy of the plugin');
  assert.equal(call.pluginManifest.name, 'fixture-plugin');
  assert.equal(call.pluginManifest.mcpServers, undefined, 'the real tracker server is withheld');
  assert.ok(flagValues(call, '--allowedTools').includes(TOOL), 'a mocked tool needs no grant');
  const run = report.cases[0].arms.with[0];
  assert.deepEqual(run.mockCalls, [{ tool: TOOL, input: { title: 'Login bug', priority: 'high' }, output: 'Created issue #4821: Login bug', verdict: 'ok' }]);
  assert.deepEqual(run.graders.map((g) => [g.name, g.verdict]), [['called', 'pass'], ['done', 'pass'], ['once', 'pass']]);
  assert.equal(run.score, 1);
  assert.equal(report.cases[0].summary.score, 1);
});

test('a call that breaks expect: aborts the run with score 0 and no error, naming server, tool and reason', async () => {
  const plugin = await makePlugin();
  const { report, stderr } = await runShim(plugin, [], [{ tool: TOOL, input: { title: 'Login bug', priority: 'urgent' } }]);
  const run = report.cases[0].arms.with[0];
  assert.equal(run.score, 0); assert.equal(run.isError, false);
  assert.deepEqual(run.aborted, { server: 'tracker', tool: 'create_issue', reason: 'priority: "urgent" is not one of "low", "medium", "high"' });
  assert.equal(run.mockCalls[0].verdict, 'abort');
  assert.match(stderr, /ABORTED by mock tracker\/create_issue/);
});

test('a tool with no mock file is not available; error: true mocks answer as tool errors', async () => {
  const plugin = await makePlugin({ mocks: { 'tracker/create_issue.md': '---\nerror: true\n---\nrate limited' } });
  const { report } = await runShim(plugin, [], [{ tool: TOOL, input: {} }, { tool: 'mcp__plugin_fixture-plugin_tracker__delete_repo', input: {} }]);
  const run = report.cases[0].arms.with[0];
  assert.deepEqual(run.mockCalls, [{ tool: TOOL, input: {}, output: 'rate limited', isError: true, verdict: 'tool_error' }]);
  assert.match(run.toolResults[1].text, /No such tool available/);
});

test('--mocks off: no stand-ins, the real server declaration stays, and a mock_calls grader fails as the official runner fails it', async () => {
  const plugin = await makePlugin({ graders: { 'called.md': '---\ntype: regex\ntarget: mock_calls\npattern: create_issue\n---\nx\n' } });
  const { report, calls } = await runShim(plugin, ['--mocks', 'off']);
  assert.equal(calls[0].mcpConfig, null);
  assert.equal(flagValues(calls[0], '--plugin-dir')[0], plugin);
  const g = report.cases[0].arms.with[0].graders.find((x) => x.name === 'called');
  assert.equal(g.verdict, 'fail'); assert.match(g.reason, /no mock stand-ins were active/);
});

test('--allow-real-servers keeps the unmocked plugin servers and still withholds the mocked one', async () => {
  const plugin = await makePlugin();
  await fs.writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: { command: '/bin/false' }, wiki: { command: 'wiki-server' } } }));
  const { calls } = await runShim(plugin, ['--allow-real-servers']);
  assert.deepEqual(calls[0].pluginManifest.mcpServers, { wiki: { command: 'wiki-server' } });
});

test('a case that needs a type: agent mock is unsupported (unknown, not failed) and starts no runs', async () => {
  const plugin = await makePlugin({ mocks: { 'tracker/create_issue.md': CREATE_ISSUE, 'tracker/_server.md': '---\ntype: agent\ntools: [search]\n---\nAnswer as an issue tracker.' } });
  const { report, calls, stderr } = await runShim(plugin);
  assert.equal(calls.length, 0);
  assert.match(report.cases[0].unsupported, /needs the official runner: tracker\/search is answered by a type: agent mock/);
  assert.equal(report.cases[0].summary.score, null);
  assert.equal(report.aggregates.failed, 0);
  assert.match(stderr, /UNSUPPORTED/);
});

test('a mock file the official runner cannot load scores the case 0 with the reason, without running it', async () => {
  const plugin = await makePlugin({ mocks: { 'tracker/create_issue.md': '---\nexpect:\n  title: /(a|b)/\n---\nx' } });
  const { report, calls } = await runShim(plugin);
  assert.equal(calls.length, 0);
  assert.match(report.cases[0].loadError, /tracker\/create_issue\.md: expect\.title/);
  assert.equal(report.cases[0].summary.score, 0);
  assert.equal(report.aggregates.failed, 1);
});

test('two arms: plugin-server mocks exist only with the plugin, their mock_calls graders are with-only indicators', async () => {
  const plugin = await makePlugin({
    mocks: { 'tracker/create_issue.md': CREATE_ISSUE, 'weather/forecast.md': 'sunny' },
    graders: { 'called.md': '---\ntype: regex\ntarget: mock_calls\npattern: create_issue\n---\nx\n' },
  });
  const { report, calls } = await runShim(plugin, [], [{ tool: TOOL, input: { title: 'T', priority: 'low' } }], { ablation: 'with-without' });
  const withCall = calls.find((c) => c.args.includes('--plugin-dir')), withoutCall = calls.find((c) => !c.args.includes('--plugin-dir'));
  assert.deepEqual(Object.keys(withCall.mcpConfig.mcpServers).sort(), ['plugin_fixture-plugin_tracker', 'weather']);
  assert.deepEqual(Object.keys(withoutCall.mcpConfig.mcpServers), ['weather'], 'a standalone mock is there in both arms');
  // weather is standalone, so not every mocked server is the plugin's: the grader is scored in both arms
  const scoredWith = report.cases[0].arms.with[0].graders.find((g) => g.name === 'called');
  assert.equal(scoredWith.scored, true);

  const pluginOnly = await makePlugin({ graders: { 'called.md': '---\ntype: regex\ntarget: mock_calls\npattern: create_issue\n---\nx\n' } });
  const r2 = await runShim(pluginOnly, [], [{ tool: TOOL, input: { title: 'T', priority: 'low' } }], { ablation: 'with-without' });
  const w = r2.report.cases[0].arms.with[0].graders.find((g) => g.name === 'called');
  const wo = r2.report.cases[0].arms.without[0].graders.find((g) => g.name === 'called');
  assert.equal(w.verdict, 'pass'); assert.equal(w.scored, false); assert.equal(w.withOnly, true);
  assert.equal(wo.verdict, 'skipped'); assert.equal(r2.calls.find((c) => !c.args.includes('--plugin-dir')).mcpConfig, null);
});

test('--regrade re-scores mock_calls graders from the saved calls, with no agent run', async () => {
  const plugin = await makePlugin();
  const first = await runShim(plugin, [], [{ tool: TOOL, input: { title: 'Login bug', priority: 'high' } }]);
  await fs.writeFile(path.join(plugin, 'evals/file-issue/graders/title.md'), '---\ntype: regex\ntarget: mock_calls\npattern: Login bug\n---\nx\n');
  const src = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mock-regrade-')), 'aggregate-result.json');
  await fs.writeFile(src, JSON.stringify(first.report));
  const re = await runShim(plugin, ['--regrade', src]);
  assert.equal(re.calls.length, 0);
  assert.equal(re.report.cases[0].arms.with[0].graders.find((g) => g.name === 'title').verdict, 'pass');
});
