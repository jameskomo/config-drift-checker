import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSuite, diagnose, applyFixes, parseFrontmatter, parseRunnerOutput, findRunner, findScaffold, scaffoldFileText, RULES } from '../tools/suite-doctor.mjs';

const TOOL = new URL('../tools/suite-doctor.mjs', import.meta.url).pathname;

// A plugin dir with one case per entry: { caseName: { 'prompt.md': text, 'graders/x.md': text, ... } }
async function suite(cases, { manifest = { name: 'demo' }, evals = 'evals' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-doctor-'));
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify(manifest));
  for (const [name, files] of Object.entries(cases)) {
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(root, evals, name, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, text);
    }
  }
  return root;
}
const fm = (obj, body = 'rubric') => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
const PROMPT = fm({ description: 'a case', tags: '[x]', runs: 1 }, 'Do the thing.');
const GOOD = {
  'prompt.md': PROMPT,
  'graders/a-regex.md': fm({ type: 'regex', pattern: 'ok', target: 'last_message', match: 'contains' }),
  'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', focus: 'last_message' }),
  'graders/c-tool.md': fm({ type: 'tool_used', tool: 'Skill', input_match: 'demo', min: 1, arm: 'with-only' }),
};
const emptyPath = async () => fs.mkdtemp(path.join(os.tmpdir(), 'no-claude-'));
// run the CLI with a PATH that has no claude on it, so the live layer is skipped unless --runner is given
async function cli(args, env = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, PATH: await emptyPath(), ...env } });
}
const rulesOf = (root) => diagnose(loadSuite(root)).map((f) => `${f.level} ${f.rule} ${f.case} ${f.file} ${f.key}${f.fixable ? ' fixable' : ''}`);
async function snapshot(dir) {
  const out = {};
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p)] = `${(await fs.stat(p)).mode}:${await fs.readFile(p, 'utf8')}`; } };
  await walk(dir);
  return out;
}

test('a clean suite reports nothing, exits 0, and skips the live layer when no runner is available', async () => {
  const root = await suite({ good: GOOD, 'with-yaml': { ...GOOD, 'case.yaml': 'schema_version: "1.1"\nname: with-yaml\ncontext:\n  scaffold_script: scaffold.sh\n', 'scaffold.sh': '#!/usr/bin/env bash\ntrue\n' } });
  assert.deepEqual(rulesOf(root), []);
  const r = await cli([root]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /suite-doctor: 2 case\(s\)/);
  assert.match(r.stdout, /live load check: skipped \(no --runner given and no claude on PATH\)/);
  assert.match(r.stdout, /summary: 0 error\(s\), 0 warning\(s\)\. Static checks passed; not confirmed against the runner/);
  assert.doesNotMatch(r.stdout, /ERROR|WARN /);
});

test('every rule has an id, a description and a detect function; fixes are functions', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of RULES) {
    assert.ok(r.id && r.description && typeof r.detect === 'function' && ['ERROR', 'WARN'].includes(r.level), r.id);
    if (r.fix) assert.equal(typeof r.fix, 'function');
  }
});

test('llm grader with target: is an error, fixable unless focus: is also set', async () => {
  const root = await suite({
    a: { ...GOOD, 'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', target: 'last_message' }) },
    b: { ...GOOD, 'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', target: 'last_message', focus: 'last_message' }) },
  });
  assert.deepEqual(rulesOf(root), [
    'ERROR llm-target-is-focus a graders/b-llm.md target fixable',
    'ERROR llm-target-is-focus b graders/b-llm.md target',
  ]);
});

test('inline scaffold_script (block, one-liner) and a top-level or missing script file are caught', async () => {
  const root = await suite({
    block: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: block\nscaffold_script: |\n  git init -q .\n  echo hi > a.txt\n' },
    nested: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: nested\ncontext:\n  scaffold_script: |\n    git init -q .\n' },
    oneliner: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: oneliner\ncontext:\n  scaffold_script: "git init -q ."\n' },
    toplevel: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: toplevel\nscaffold_script: setup.sh\n', 'setup.sh': 'true\n' },
    missing: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: missing\ncontext:\n  scaffold_script: nope.sh\n' },
    clash: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: clash\nscaffold_script: |\n  git init\n', 'scaffold.sh': 'something else\n' },
  });
  assert.deepEqual(rulesOf(root), [
    'ERROR scaffold-script-file block case.yaml scaffold_script fixable',
    'ERROR scaffold-script-file clash case.yaml scaffold_script',
    'ERROR scaffold-under-context missing case.yaml scaffold_script',
    'ERROR scaffold-script-file nested case.yaml scaffold_script fixable',
    'ERROR scaffold-script-file oneliner case.yaml scaffold_script fixable',
    'ERROR scaffold-under-context toplevel case.yaml scaffold_script fixable',
  ]);
});

test('case.yaml without schema_version or name is an error; a case without case.yaml is fine', async () => {
  const root = await suite({
    bare: { 'prompt.md': PROMPT, 'case.yaml': '# comment\ncontext:\n  scaffold_script: s.sh\n', 's.sh': 'true\n' },
    noname: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\n' },
    promptonly: { 'prompt.md': PROMPT },
  });
  assert.deepEqual(rulesOf(root), [
    'ERROR case-yaml-header bare case.yaml schema_version fixable',
    'ERROR case-yaml-header bare case.yaml name fixable',
    'ERROR case-yaml-header noname case.yaml name fixable',
  ]);
});

test('tool_used max: 0 without min: is an error; with min: it is fine', async () => {
  const root = await suite({
    a: { 'prompt.md': PROMPT, 'graders/never.md': fm({ type: 'tool_used', tool: 'Bash', max: 0 }), 'graders/ok.md': fm({ type: 'tool_used', tool: 'Bash', max: 0, min: 0 }), 'graders/max2.md': fm({ type: 'tool_used', tool: 'Bash', max: 2 }) },
  });
  assert.deepEqual(rulesOf(root), ['ERROR tool-used-max-zero-needs-min a graders/never.md max fixable']);
});

test('arm: with is fixable, arm: without and other values are reported only', async () => {
  const g = (arm) => fm({ type: 'regex', pattern: 'x', target: 'last_message', arm });
  const root = await suite({ a: { 'prompt.md': PROMPT, 'graders/1.md': g('with'), 'graders/2.md': g('without'), 'graders/3.md': g('sometimes'), 'graders/4.md': g('both'), 'graders/5.md': g('with-only') } });
  assert.deepEqual(rulesOf(root), [
    'ERROR grader-arm-value a graders/1.md arm fixable',
    'ERROR grader-arm-value a graders/2.md arm',
    'ERROR grader-arm-value a graders/3.md arm',
  ]);
  const without = diagnose(loadSuite(root)).find((f) => f.file === 'graders/2.md');
  assert.match(without.fix, /no official equivalent/);
});

test('grader keys not allowed for the type, a missing type and an unknown type are reported', async () => {
  const root = await suite({ a: {
    'prompt.md': PROMPT,
    'graders/1.md': fm({ type: 'regex', pattern: 'x', target: 'last_message', name: 'mine', weight: 2 }),
    'graders/2.md': fm({ type: 'file_exists', path: 'a.txt', exists: true, target: 'files' }),
    'graders/3.md': fm({ pattern: 'x' }),
    'graders/4.md': fm({ type: 'vibes', criteria: 'x' }),
    'graders/5.md': fm({ type: 'tool_order', before: 'Read', after: 'Edit' }),
    'graders/6.md': fm({ type: 'baseline', baseline_file: 'b.txt', criteria: 'same' }),
  } });
  assert.deepEqual(rulesOf(root), [
    'ERROR grader-known-keys a graders/1.md name',
    'ERROR grader-known-keys a graders/2.md target',
    'ERROR grader-known-keys a graders/3.md type',
    'ERROR grader-known-keys a graders/4.md type',
  ]);
});

test('regex target: files is a warning, not an error, and exits 0', async () => {
  const root = await suite({ a: { 'prompt.md': PROMPT, 'graders/1.md': fm({ type: 'regex', pattern: 'class', target: 'files' }) } });
  assert.deepEqual(rulesOf(root), ['WARN regex-target-files a graders/1.md target']);
  const r = await cli([root]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WARN   a  graders\/1\.md  target:.*source: file, path: <path>.*\[manual\]/);
  assert.match(r.stdout, /0 error\(s\), 1 warning\(s\)/);
});

test('prompt.md keys outside the whitelist are errors; covers: is fixable unless covers.yaml disagrees', async () => {
  const root = await suite({
    a: { 'prompt.md': fm({ description: 'x', covers: '[r/one, r/two]', owner: 'me' }, 'Do it.') },
    b: { 'prompt.md': fm({ description: 'x', covers: '[r/one]' }, 'Do it.'), 'covers.yaml': '- r/one\n- r/zero\n' },
    c: { 'prompt.md': fm({ description: 'x', covers: '[r/new]' }, 'Do it.'), 'covers.yaml': '- r/old\n' },
  });
  assert.deepEqual(rulesOf(root), [
    'ERROR prompt-frontmatter-keys a prompt.md covers fixable',
    'ERROR prompt-frontmatter-keys a prompt.md owner',
    'ERROR prompt-frontmatter-keys b prompt.md covers fixable',
    'ERROR prompt-frontmatter-keys c prompt.md covers',
  ]);
});

test('an error exits 1 and names case, file, key and fix; --json writes structured findings', async () => {
  const root = await suite({ broken: { ...GOOD, 'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', target: 'last_message' }) } });
  const out = path.join(root, 'doctor.json');
  const r = await cli([root, '--json', out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR  broken  graders\/b-llm\.md  target:  llm grader uses target:.*Fix: rename target: to focus: \(value kept\)\. \[--fix can apply\]/);
  assert.match(r.stdout, /summary: 1 error\(s\), 0 warning\(s\), 1 fixable with --fix/);
  const j = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(j.summary.errors, 1);
  assert.equal(j.live.status, 'skipped');
  assert.deepEqual({ ...j.findings[0], message: undefined }, { level: 'ERROR', rule: 'llm-target-is-focus', case: 'broken', source: 'static', file: 'graders/b-llm.md', key: 'target', message: undefined, fix: 'rename target: to focus: (value kept)', fixable: true });
});

test('--fix applies every known fix correctly and a second --fix changes nothing', async () => {
  const root = await suite({
    llm: { ...GOOD, 'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', target: 'last_message' }) },
    scaffold: { 'prompt.md': PROMPT, 'case.yaml': '# keep me\nscaffold_script: |\n  #!/bin/bash\n  set -euo pipefail\n  git init -q .\n  if true; then\n    echo nested > a.txt\n  fi\n\ncontext:\n  plugins: []\n' },
    header: { 'prompt.md': PROMPT, 'case.yaml': 'context:\n  scaffold_script: s.sh\n', 's.sh': 'true\n' },
    toplevel: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\nname: toplevel\nscaffold_script: s.sh\n', 's.sh': 'true\n' },
    tools: { 'prompt.md': PROMPT, 'graders/none.md': fm({ type: 'tool_used', tool: 'Bash', max: 0, arm: 'with' }) },
    covers: { 'prompt.md': '---\ndescription: x\ncovers:\n  - r/one\n  - r/two\nruns: 1\n---\nDo it.\n' },
  });
  const r1 = await cli([root, '--fix']);
  assert.equal(r1.status, 0, r1.stdout);
  assert.equal((r1.stdout.match(/^ {2}FIXED/gm) ?? []).length, 10, r1.stdout);
  assert.match(r1.stdout, /summary: 0 error\(s\), 0 warning\(s\), 10 fixed/);
  const E = path.join(root, 'evals');
  const read = (p) => fs.readFile(path.join(E, p), 'utf8');

  assert.match(await read('llm/graders/b-llm.md'), /^focus: last_message$/m);
  assert.doesNotMatch(await read('llm/graders/b-llm.md'), /^target:/m);

  assert.equal(await read('scaffold/case.yaml'), 'schema_version: "1.1"\nname: scaffold\n# keep me\n\ncontext:\n  scaffold_script: scaffold.sh\n  plugins: []\n');
  assert.equal(await read('scaffold/scaffold.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ngit init -q .\nif true; then\n  echo nested > a.txt\nfi\n');
  assert.equal(statSync(path.join(E, 'scaffold/scaffold.sh')).mode & 0o777, 0o755);

  assert.equal(await read('header/case.yaml'), 'schema_version: "1.1"\nname: header\ncontext:\n  scaffold_script: s.sh\n');
  assert.equal(await read('toplevel/case.yaml'), 'schema_version: "1.1"\nname: toplevel\ncontext:\n  scaffold_script: s.sh\n');
  assert.equal(await read('tools/graders/none.md'), '---\ntype: tool_used\ntool: Bash\nmax: 0\nmin: 0\narm: with-only\n---\nrubric\n');
  assert.equal(await read('covers/prompt.md'), '---\ndescription: x\nruns: 1\n---\nDo it.\n');
  assert.match(await read('covers/covers.yaml'), /^- r\/one\n- r\/two\n$/m);

  const before = await snapshot(root);
  const r2 = await cli([root, '--fix']);
  assert.equal(r2.status, 0);
  assert.doesNotMatch(r2.stdout, /FIXED/);
  assert.match(r2.stdout, /0 fixed/);
  assert.deepEqual(await snapshot(root), before);
});

test('--fix leaves manual findings in place and still exits 1 for them', async () => {
  const root = await suite({ a: { 'prompt.md': PROMPT, 'graders/1.md': fm({ type: 'regex', pattern: 'x', arm: 'without' }), 'graders/2.md': fm({ type: 'llm', criteria: 'x', target: 'last_message' }) } });
  const r = await cli([root, '--fix']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FIXED  a  graders\/2\.md/);
  assert.match(r.stdout, /ERROR  a  graders\/1\.md  arm:.*\[manual\]/);
  assert.match(r.stdout, /1 error\(s\), 0 warning\(s\), 1 fixed/);
});

test('applyFixes and the scaffold helpers are usable as a library', async () => {
  const root = await suite({ a: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\n' } });
  const s = loadSuite(root);
  assert.deepEqual(applyFixes(s).map((f) => f.key), ['name']);
  assert.deepEqual(applyFixes(loadSuite(root)), []);
  const sc = findScaffold(['name: x', 'context:', '  scaffold_script: >', '    echo a', '', 'runs: 1']);
  assert.equal(sc.form, 'block'); assert.equal(sc.parent, 'context'); assert.equal(sc.end, 4);
  assert.equal(scaffoldFileText('#!/bin/sh\necho a\n\n'), '#!/usr/bin/env bash\nset -euo pipefail\necho a\n');
});

test('the eval dir follows experimental.evals in plugin.json; results and mocks are skipped', async () => {
  const root = await suite({ a: GOOD, results: { 'prompt.md': fm({ junk: 1 }) }, mocks: { 'prompt.md': fm({ junk: 1 }) } }, { manifest: { name: 'x', experimental: { evals: 'checks' } }, evals: 'checks' });
  const s = loadSuite(root);
  assert.equal(path.basename(s.evalDir), 'checks');
  assert.deepEqual(s.cases.map((c) => c.name), ['a']);
  const r = await cli([path.join(root, 'nowhere')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no eval dir/);
});

test('parseFrontmatter: scalars, flow and block lists, block scalars, comments', () => {
  const { meta } = parseFrontmatter('---\ntype: regex\n# a comment\npattern: \'a: b\'\nmax: 0\ntags: [a, b]\ncovers:\n  - x\n  - y\nnote: |\n  line 1\n  line 2\n---\nbody');
  assert.deepEqual(meta, { type: 'regex', pattern: 'a: b', max: 0, tags: ['a', 'b'], covers: ['x', 'y'], note: 'line 1\nline 2' });
  assert.deepEqual(parseFrontmatter('no frontmatter').meta, {});
});

// lines captured from Claude Code 2.1.287 `claude plugin eval <dir> --max-cost-usd 0`
const RUNNER_OUT = (E) => [
  'Ablation: defaulting to with-without',
  '⚠ case "guard": its scaffold_script is not run without --scaffold (author-supplied bash that runs as you); the case runs against an unstaged workspace',
  `✗ ${E}/guard/case.yaml: missing required field schema_version (e.g. "1.0")`,
  `✗ ${E}/llm: invalid case.yaml:   graders.1: Unrecognized key(s) in object: 'target'`,
  `✗ ${E}/covers: prompt.md: unknown frontmatter key "covers" (expected one of: schema_version, name)`,
  `✗ ${E}/arm: invalid case.yaml:   graders.0.arm: Invalid enum value. Expected 'with-only' | 'both', received 'without'`,
  `✗ ${E}/named/case.yaml: invalid case.yaml:   name: Required`,
  '5 case file(s) failed to load',
].join('\n');

test('parseRunnerOutput: load-error lines become case, file, key; grader indexes map to files', async () => {
  const root = await suite({
    guard: { 'prompt.md': PROMPT, 'case.yaml': 'name: guard\n' },
    llm: GOOD, covers: { 'prompt.md': PROMPT }, arm: { 'prompt.md': PROMPT, 'graders/z.md': fm({ type: 'regex', pattern: 'x', arm: 'without' }) },
    named: { 'prompt.md': PROMPT, 'case.yaml': 'schema_version: "1.1"\n' },
  });
  const s = loadSuite(root);
  const p = parseRunnerOutput(RUNNER_OUT(s.evalDir), s);
  assert.equal(p.failedCount, 5);
  assert.equal(p.notes.length, 1);
  assert.deepEqual(p.loadErrors.map((e) => `${e.case} ${e.file} ${e.key}`), [
    'guard case.yaml schema_version', 'llm graders/b-llm.md target', 'covers prompt.md covers', 'arm graders/z.md arm', 'named case.yaml name',
  ]);
});

test('findRunner: explicit path, PATH lookup, and a clean skip when neither exists', async () => {
  const dir = await emptyPath();
  assert.equal(findRunner(null, dir).path, null);
  assert.match(findRunner(null, dir).reason, /no claude on PATH/);
  assert.match(findRunner(path.join(dir, 'missing')).reason, /not an executable file/);
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, '#!/bin/sh\n'); await fs.chmod(bin, 0o755);
  assert.equal(findRunner(null, `/nonexistent${path.delimiter}${dir}`).path, bin);
  assert.equal(findRunner(bin).path, bin);
});

// A stand-in for the claude binary: records how it was called, prints load errors like 2.1.287,
// and writes the zero-run result JSON (or, per FAKE_MODE, no JSON or a run that started).
async function fakeRunner() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-runner-'));
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.287 (Claude Code)'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, key: process.env.ANTHROPIC_API_KEY ?? null, config: process.env.CLAUDE_CONFIG_DIR }));
const E = a[2] + '/evals';
if (process.env.FAKE_MODE === 'crash') { console.error('Error: something broke'); process.exit(1); }
if (process.env.FAKE_MODE === 'old' && a.includes('--trust-plugin')) { console.error("error: unknown option '--trust-plugin'"); process.exit(1); }
if (process.env.FAKE_MODE === 'early') { console.error('plugin eval is currently in early access'); process.exit(1); }
if (process.env.FAKE_MODE === 'nocap') { console.error("error: unknown option '--max-cost-usd'"); process.exit(1); }
console.log('⚠ case "llm": grader "c-tool" cannot pass with the granted tools: Bash is not granted');
console.log('✗ ' + E + "/llm: invalid case.yaml:   graders.1: Unrecognized key(s) in object: 'target'");
console.log('✗ ' + E + '/other: invalid case.yaml:   graders.0.weight: Expected number, received string');
console.log('2 case file(s) failed to load');
const runs = process.env.FAKE_MODE === 'spent' ? [{ score: 0 }] : null;
fs.writeFileSync(a[a.indexOf('--json') + 1], JSON.stringify({ schemaVersion: 1, costUsd: runs ? 0.4 : 0, partial: true, partialReason: 'cost_ceiling', cases: runs ? [{ name: 'llm', arms: { with: runs } }] : [] }));
process.exit(2);
`);
  await fs.chmod(bin, 0o755);
  return { bin, log: path.join(dir, 'log.json') };
}

test('live layer: zero-cost invocation, runner errors confirm static findings and add unknown ones', async () => {
  const root = await suite({
    llm: { ...GOOD, 'graders/b-llm.md': fm({ type: 'llm', criteria: 'is good', target: 'last_message' }) },
    other: { 'prompt.md': PROMPT, 'graders/w.md': fm({ type: 'regex', pattern: 'x', weight: '"heavy"' }) },
    fine: GOOD,
  });
  const { bin, log } = await fakeRunner();
  const out = path.join(root, 'doctor.json');
  const r = await cli([root, '--runner', bin, '--json', out], { FAKE_LOG: log, ANTHROPIC_API_KEY: 'sk-should-not-leak' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const called = JSON.parse(await fs.readFile(log, 'utf8'));
  assert.deepEqual(called.argv.slice(0, 3), ['plugin', 'eval', root]);
  assert.equal(called.argv[called.argv.indexOf('--max-cost-usd') + 1], '0');
  for (const f of ['--trust-plugin', '--no-publish', '--output-dir', '--report', '--json']) assert.ok(called.argv.includes(f), f);
  assert.equal(called.key, null, 'no API key reaches the runner');
  assert.ok(called.config.startsWith(os.tmpdir()), 'runner gets a throwaway config dir');
  assert.ok(!existsSync(path.join(root, 'evals/results')), 'nothing written into the suite');

  assert.match(r.stdout, /ERROR  llm  graders\/b-llm\.md  target:.*\[runner agrees\]/);
  assert.match(r.stdout, /ERROR  other  graders\/w\.md  weight:  the runner refused this case: graders\.0\.weight: Expected number/);
  assert.match(r.stdout, /live load check: claude 2\.1\.287 loaded 1 of 3 case\(s\), 2 failed to load; 0 agent run\(s\) started, \$0\.00 spent/);
  assert.match(r.stdout, /1 runner note\(s\) about tool grants and scaffolds omitted/);
  const j = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(j.live.status, 'ok'); assert.equal(j.live.runsStarted, 0); assert.equal(j.live.costUsd, 0);
  assert.equal(j.findings.find((f) => f.case === 'llm').confirmedByRunner, true);
  assert.equal(j.findings.find((f) => f.case === 'other').rule, 'runner-load');
});

test('live layer: a runner that writes no JSON is reported, one that starts runs is flagged', async () => {
  const root = await suite({ fine: GOOD });
  const { bin, log } = await fakeRunner();
  const crash = await cli([root, '--runner', bin], { FAKE_LOG: log, FAKE_MODE: 'crash' });
  assert.match(crash.stdout, /live load check: could not complete .*wrote no result JSON: Error: something broke/);
  const spent = await cli([root, '--runner', bin], { FAKE_LOG: log, FAKE_MODE: 'spent' });
  assert.match(spent.stdout, /WARN   \(suite\).*started 1 run\(s\) costing \$0\.4/);
});

test('live layer: a --runner that does not exist is skipped cleanly, the static result stands', async () => {
  const root = await suite({ fine: GOOD });
  const r = await cli([root, '--runner', path.join(root, 'no-such-claude')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /live load check: skipped \(--runner .* is not an executable file\)/);
  const usage = await cli([]);
  assert.equal(usage.status, 2);
});

test('live layer on older Claude Code: retries without --trust-plugin, skips honestly when no run-free check exists', async () => {
  const root = await suite({ fine: GOOD });
  const { bin, log } = await fakeRunner();
  const old = await cli([root, '--runner', bin], { FAKE_LOG: log, FAKE_MODE: 'old' });
  const called = JSON.parse(await fs.readFile(log, 'utf8'));
  assert.ok(!called.argv.includes('--trust-plugin'), 'the retry drops the flag the old runner rejected');
  assert.match(old.stdout, /live load check: claude 2\.1\.287 loaded/);
  for (const mode of ['early', 'nocap']) {
    const r = await cli([root, '--runner', bin], { FAKE_LOG: log, FAKE_MODE: mode });
    assert.match(r.stdout, /live load check: skipped/);
    assert.match(r.stdout, /not confirmed against the runner/, `${mode}: never claims the suite is valid`);
    assert.doesNotMatch(r.stdout, /Every case is valid/);
  }
});
