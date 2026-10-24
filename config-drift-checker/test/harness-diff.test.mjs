import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseSdkTools, diffSdkTools, wordDiff, variantLabels, tarEntry, fetchSdkTools, harnessDiff, renderMarkdown, renderDiffHtml, toolOf } from '../tools/harness-diff.mjs';
import { fakeNpm, tarball } from './fixtures/fake-npm.mjs';

const TOOL = new URL('../tools/harness-diff.mjs', import.meta.url).pathname;
const FIX = new URL('./fixtures/harness/', import.meta.url).pathname;
const OLD = readFileSync(path.join(FIX, 'old.d.ts'), 'utf8'), NEW = readFileSync(path.join(FIX, 'new.d.ts'), 'utf8');
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (status) => resolve({ status, out, err }));
});

test('parseSdkTools: tools, fields, descriptions, constraints, tuples folded into arrays, union variants named by their tag', () => {
  const m = parseSdkTools(OLD);
  assert.deepEqual(m.tools, ['Agent', 'Ask', 'OldTool', 'Read']);
  assert.deepEqual(toolOf('FileReadInput'), { tool: 'Read', side: 'input' });
  assert.deepEqual(toolOf('ToolInputSchemas'), { tool: null, side: 'other' });
  const agent = m.declarations.AgentInput;
  assert.equal(agent.tool, 'Agent');
  assert.equal(agent.fields.effort.type, '"low" | "medium" | "high"');
  assert.equal(agent.fields.effort.optional, true);
  assert.match(agent.fields.effort.description, /^Reasoning effort for this agent\./);
  const ask = m.declarations.AskInput.fields;
  assert.deepEqual(Object.keys(ask), ['questions', 'questions[].question', 'questions[].multi-select', '[k: string]'], 'the 1-tuple and 2-tuple collapse into one array of the same item');
  assert.equal(ask.questions.type, 'object[]');
  assert.equal(ask.questions.description, 'Questions to ask the user');
  assert.deepEqual(ask.questions.tags, ['minItems 1', 'maxItems 2']);
  assert.deepEqual(Object.keys(m.declarations.AgentOutput.fields), ['{status=completed}.status', '{status=completed}.agentId', '{status=async_launched}.status', '{status=async_launched}.agentId', '{status=async_launched}.outputFile']);
  assert.equal(m.declarations.CronListOutput.fields['jobs[].id'].type, 'string');
  assert.throws(() => parseSdkTools('export interface X { a: string; }'), /no tool input schemas/);
  assert.throws(() => parseSdkTools('export interface AInput { a: ; }'), /expected a type/);
});

test('variantLabels: a literal tag only one variant has, else a key only it has, else its position', () => {
  const obj = (...members) => ({ k: 'object', members: members.map(([key, type, optional = false]) => ({ key, optional, type })) });
  const lit = (v) => ({ k: 'lit', v: JSON.stringify(v) }), str = { k: 'ref', name: 'string' };
  assert.deepEqual(variantLabels([obj(['url', str], ['rail', lit('a')]), obj(['url', str], ['rail', lit('b')])]), ['rail=a', 'rail=b']);
  assert.deepEqual(variantLabels([obj(['url', str], ['task', str]), obj(['url', str], ['trigger', str, true])]), ['task', 'trigger']);
  assert.deepEqual(variantLabels([obj(['url', str]), obj(['url', str])]), ['#1', '#2']);
});

test('wordDiff: word runs, a rewritten phrase reads as one block, identical text is one equal run', () => {
  assert.deepEqual(wordDiff('run it now', 'run it now'), [['=', 'run it now']]);
  assert.deepEqual(wordDiff('Set to false to wait.', 'Set to false only when you must wait.'), [['=', 'Set to false '], ['-', 'to'], ['+', 'only when you must'], ['=', ' wait.']]);
  assert.deepEqual(wordDiff('a b', 'a b c'), [['=', 'a b'], ['+', ' c']]);
  const ops = wordDiff('one two three four', 'one 2 3 four');
  assert.deepEqual(ops, [['=', 'one '], ['-', 'two three'], ['+', '2 3'], ['=', ' four']]);
});

test('diffSdkTools: instruction wording, capabilities and type-only changes, each once, with a plain headline', () => {
  const d = diffSdkTools(parseSdkTools(OLD), parseSdkTools(NEW), { from: '2.0.1', to: '2.0.2' });
  const got = d.changes.map((c) => `${c.class} ${c.kind} ${c.display}`);
  assert.deepEqual(got, [
    'instruction description-changed Agent.effort',
    'instruction description-changed Ask.questions[].question',
    'capability values-added Agent.effort',
    'capability tool-added NewTool',
    'capability tool-removed OldTool',
    'capability field-added Read.allow_large',
    'capability field-added Read.options',
    'type-only constraints-changed Ask.questions',
    'type-only type-changed Read.limit',
    'type-only field-added Agent.{status=completed}.owned',
    'type-only field-added CronList.jobs[].nextFireAt',
  ]);
  assert.ok(!got.some((g) => /run_in_background/.test(g)), 'a reflowed description with the same words is not a change');
  assert.ok(!got.some((g) => /Read\.options\.encoding/.test(g)), 'a new parameter\'s own sub-fields roll up into it');
  assert.equal(d.changes.find((c) => c.field === 'options').nested, 1);
  assert.deepEqual(d.changes.find((c) => c.kind === 'values-added').values, ['max']);
  const s = d.summary;
  assert.equal(s.headline, 'Claude Code 2.0.2 changed the instructions of 3 built-in tools (Agent, Ask, Read), added 4 capabilities and removed 1 capability.');
  assert.deepEqual(s.counts, { instruction: 2, capability: 5, typeOnly: 4 });
  assert.deepEqual([s.toolsAdded, s.toolsRemoved], [['NewTool'], ['OldTool']]);
  assert.ok(s.items.every((i) => i.class !== 'type-only'));

  const same = diffSdkTools(parseSdkTools(OLD), parseSdkTools(OLD), { from: '2.0.1', to: '2.0.1' });
  assert.equal(same.changes.length, 0);
  assert.equal(same.summary.headline, 'Claude Code 2.0.1 made no changes to the built-in tool definitions.');
  const typesOnly = diffSdkTools(parseSdkTools(OLD), parseSdkTools(OLD.replace('cron: string;', 'cron: string;\n    owner?: string;')), { to: '2.0.3' });
  assert.equal(typesOnly.summary.headline, "Claude Code 2.0.3 kept every built-in tool's instructions and capabilities; 1 change touches types only.");
});

test('renderMarkdown and renderDiffHtml: before/after highlights, everything from the package escaped, self-contained page', () => {
  const d = diffSdkTools(parseSdkTools(OLD), parseSdkTools(NEW), { from: '2.0.1', to: '2.0.2' });
  const md = renderMarkdown(d);
  assert.match(md, /^# What changed inside Claude Code 2\.0\.2\n\n\*\*Claude Code 2\.0\.2 changed the instructions of 3 built-in tools/);
  assert.match(md, /After: .*otherwise omit it\.<ins> Ignored for subagent_type: "fork": a fork runs at your own effort\.<\/ins>/);
  assert.match(md, /Before: The question to ask\. <del>End<\/del>/);
  assert.match(md, /- Read: new parameter `allow_large` \(boolean, optional\): Set to true/);
  assert.match(md, /## Type-only/);
  assert.match(md, /- new tool NewTool/);
  const html = renderDiffHtml(d, { backLink: '../' });
  assert.match(html, /<h1>Claude Code 2\.0\.2 changed the instructions of 3 built-in tools \(Agent, Ask, Read\), added 4 capabilities and removed 1 capability\.<\/h1>/);
  assert.match(html, /<ins> Ignored for subagent_type: &quot;fork&quot;: a fork runs at your own effort\.<\/ins>/);
  assert.match(html, /<a href="\.\.\/">release report<\/a>/);
  assert.match(html, /Parameters: <span class="mono">query, limit<\/span>/);
  assert.doesNotMatch(html, /<script|<link|src="http/);
  assert.doesNotMatch(html, /<at most>/, 'description text is escaped');
  for (const t of [md, html]) assert.doesNotMatch(t.replace(/<del>[\s\S]*?<\/del>|<ins>[\s\S]*?<\/ins>/g, ''), /[\u2013\u2014]/, 'our own text has no dashes');
});

test('tarEntry reads one file out of an npm tarball without extracting anything', () => {
  const tgz = tarball({ 'package/package.json': '{}', 'package/sdk-tools.d.ts': 'x'.repeat(1300) });
  assert.equal(tarEntry(tgz, 'package/sdk-tools.d.ts').toString(), 'x'.repeat(1300));
  assert.equal(tarEntry(tgz, 'package/nope'), null);
  assert.throws(() => tarEntry(tgz, 'package/sdk-tools.d.ts', 100), /over the 100 byte cap/);
});

test('fetchSdkTools: npm pack once per version, then the cache; a missing version is a clear error', async () => {
  const npm = await fakeNpm({ '2.0.1': OLD, '2.0.2': NEW });
  const pathBefore = process.env.PATH;
  process.env.PATH = `${npm.binDir}${path.delimiter}${pathBefore}`;
  try {
    assert.equal(fetchSdkTools('2.0.1', { cacheDir: npm.cacheDir }), OLD);
    assert.equal(fetchSdkTools('2.0.1', { cacheDir: npm.cacheDir }), OLD);
    const calls = await npm.calls();
    assert.equal(calls.length, 1, 'the second read comes from the cache');
    assert.deepEqual(calls[0].slice(0, 2), ['pack', '@anthropic-ai/claude-code@2.0.1']);
    assert.ok(calls[0].includes('--ignore-scripts'));
    assert.ok(existsSync(path.join(npm.cacheDir, '2.0.1', 'sdk-tools.d.ts')));
    assert.throws(() => fetchSdkTools('9.9.9', { cacheDir: npm.cacheDir }), /npm pack @anthropic-ai\/claude-code@9\.9\.9 failed: npm error 404/);
    assert.throws(() => fetchSdkTools('../x', { cacheDir: npm.cacheDir }), /not a version/);
    assert.equal(harnessDiff({ from: '2.0.1', to: '2.0.2', cacheDir: npm.cacheDir }).summary.capabilitiesAdded, 4);
    assert.deepEqual((await fs.readdir(npm.cacheDir)).sort(), ['2.0.1', '2.0.2'], 'no tarballs or temp dirs left behind');
  } finally { process.env.PATH = pathBefore; }
});

test('CLI: --json, --md and --html, from npm or from files; bad input exits non-zero', async () => {
  const npm = await fakeNpm({ '2.0.1': OLD, '2.0.2': NEW });
  const env = { PATH: `${npm.binDir}${path.delimiter}${process.env.PATH}`, CDC_HARNESS_CACHE: npm.cacheDir };
  const j = await run(['--from', '2.0.1', '--to', '2.0.2', '--json'], env);
  assert.equal(j.status, 0, j.err);
  const d = JSON.parse(j.out);
  assert.equal(d.from, '2.0.1');
  assert.equal(d.summary.instructionTools.join(), 'Agent,Ask,Read');
  const m = await run(['--from-file', path.join(FIX, 'old.d.ts'), '--to-file', path.join(FIX, 'new.d.ts'), '--to', '2.0.2', '--from', '2.0.1', '--md']);
  assert.equal(m.status, 0, m.err);
  assert.match(m.out, /## Capabilities/);
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')), 'd.html');
  const h = await run(['--from', '2.0.1', '--to', '2.0.2', '--html', '--out', out], env);
  assert.equal(h.status, 0, h.err);
  assert.match(h.out, /^Claude Code 2\.0\.2 changed the instructions/);
  assert.match(await fs.readFile(out, 'utf8'), /^<!doctype html>/);
  const bad = await run(['--from', '2.0.1', '--to', '2.0.9'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /harness-diff: npm pack .*2\.0\.9 failed/);
  assert.equal((await run(['--from', 'latest'])).status, 2);
});
