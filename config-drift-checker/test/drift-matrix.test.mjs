import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickReference, versionRanges, evaluateMatrix, runMatrix, loadMatrixDir, estimateCost, renderMatrixHtml, renderMatrixMd, matrixJson, cellId } from '../tools/drift-matrix.mjs';
import { lastVersions, caseTags, suiteView, usableReason } from '../tools/cc-release.mjs';

const TOOL = new URL('../tools/drift-matrix.mjs', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

// two cases (one tagged demo, one slow), each with a regex grader that wants "DONE"
async function makePlugin(cdcYml = null) {
  const dir = await tmp('matrix-plugin-');
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.1' }));
  for (const [c, tags] of [['case-a', 'tags: [demo]'], ['case-b', 'tags:\n  - slow']]) {
    await fs.mkdir(path.join(dir, 'evals', c, 'graders'), { recursive: true });
    await fs.writeFile(path.join(dir, 'evals', c, 'prompt.md'), `---\nname: ${c}\n${tags}\nmax_turns: 4\n---\nDo the thing and say DONE.\n`);
    await fs.writeFile(path.join(dir, 'evals', c, 'graders/done.md'), `---\ntype: regex\npattern: DONE\ntarget: last_message\n---\nSays DONE.\n`);
  }
  if (cdcYml) await fs.writeFile(path.join(dir, '.cdc.yml'), cdcYml);
  return dir;
}

// stands in for installRelease: a bin dir whose `claude` is the fake, reporting the requested version;
// failModel[version] makes that model's answers miss "DONE" on that version only
function fakeInstaller(state, { failModel = {}, extraEnv = {} } = {}) {
  const installed = [];
  const install = async (v) => {
    installed.push(v);
    const bin = await tmp('matrix-bin-');
    await fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexport FAKE_CLAUDE_VERSION=${v}\n${failModel[v] ? `export FAKE_CLAUDE_FAIL_MODEL=${failModel[v]}\n` : ''}exec node "${FAKE}" "$@"\n`, { mode: 0o755 });
    return { binDir: bin, env: { ...process.env, FAKE_CLAUDE_STATE: state, CLAUDE_CONFIG_DIR: await tmp('matrix-cfg-'), ...extraEnv }, cleanup: () => fs.rm(bin, { recursive: true, force: true }) };
  };
  return { install, installed };
}
const calls = async (state) => { try { return (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.done); } catch { return []; } };

// a minimal normalized result: { case: score }
const result = (scores, { model = 'claude-x', cost = 0.1, turns = 2, errored = false } = {}) => ({
  cases: Object.entries(scores).map(([dir, s]) => ({ dir, summary: { score: errored ? null : s }, arms: { with: [{ score: errored ? null : s, isError: errored, numTurns: turns, costUsd: cost, model }] } })),
  aggregates: { totalRuns: Object.keys(scores).length, erroredRuns: errored ? Object.keys(scores).length : 0, costUsd: cost * Object.keys(scores).length },
});

test('pickReference: explicit spec, then the .cdc.yml pins when in the grid, then first model on the oldest version', () => {
  const vs = ['2.1.288', '2.1.290'], ms = ['sonnet', 'haiku'];
  assert.deepEqual(pickReference(vs, ms, { spec: '2.1.290:haiku' }), { version: '2.1.290', model: 'haiku' });
  assert.deepEqual(pickReference(vs, ms, { spec: 'haiku', pinnedVersion: '2.1.290' }), { version: '2.1.290', model: 'haiku' });
  assert.deepEqual(pickReference(vs, ms, { pinnedVersion: '2.1.290', pinnedModel: 'sonnet' }), { version: '2.1.290', model: 'sonnet' });
  assert.deepEqual(pickReference(vs, ms, { pinnedVersion: '2.1.100', pinnedModel: 'opus' }), { version: '2.1.288', model: 'sonnet' });
});

test('versionRanges and lastVersions: consecutive tested versions collapse, prereleases never count', () => {
  const tested = ['2.1.288', '2.1.289', '2.1.290', '2.1.291', '2.1.293', '2.1.295'];
  assert.equal(versionRanges(['2.1.289', '2.1.290', '2.1.291', '2.1.295'], tested), '2.1.289 to 2.1.291, 2.1.295');
  assert.equal(versionRanges(['2.1.288'], tested), '2.1.288');
  assert.deepEqual(lastVersions(['2.1.9', '2.1.10', '2.1.11-beta.1', '2.1.8', '2.1.10'], 2), ['2.1.9', '2.1.10']);
});

test('caseTags reads inline and block tag lists; usableReason matches result-health', () => {
  assert.deepEqual(caseTags('---\nname: x\ntags: [a, "b"]\n---\nbody'), ['a', 'b']);
  assert.deepEqual(caseTags('---\ntags:\n  - slow\n  - db\nname: x\n---\n'), ['slow', 'db']);
  assert.deepEqual(caseTags('no frontmatter'), []);
  assert.equal(usableReason(null), 'no result file');
  assert.match(usableReason(result({ a: 1 }, { errored: true })), /every run errored/);
  assert.match(usableReason(result({ a: 1 }), 2), /only 1 of 2 cases loaded/);
  assert.equal(usableReason(result({ a: 1 }), 1), '');
});

test('evaluateMatrix: colors against the reference and writes one plain-English verdict per model', () => {
  const versions = ['2.1.288', '2.1.290', '2.1.295'], models = ['sonnet', 'haiku'];
  const cells = [
    { version: '2.1.290', model: 'sonnet', state: 'ran', json: result({ a: 1, b: 1 }) },
    { version: '2.1.288', model: 'sonnet', state: 'ran', json: result({ a: 1, b: 1 }) },
    { version: '2.1.295', model: 'sonnet', state: 'unrun', reason: 'budget $1 spent before this cell' },
    { version: '2.1.288', model: 'haiku', state: 'ran', json: result({ a: 1, b: 0 }, { turns: 4 }) },
    { version: '2.1.290', model: 'haiku', state: 'ran', json: result({ a: 1, b: 1 }) },
    { version: '2.1.295', model: 'haiku', state: 'ran', json: result({ a: 1, b: 1 }) },
  ];
  const ev = evaluateMatrix(cells, { versions, models, reference: { version: '2.1.290', model: 'sonnet' } });
  assert.equal(ev.verdicts.haiku, 'haiku: safe on 2.1.290 to 2.1.295; fails b on 2.1.288');
  assert.equal(ev.verdicts.sonnet, 'sonnet: safe on 2.1.288 to 2.1.290; not run on 2.1.295');
  const h288 = ev.cells.find((c) => c.version === '2.1.288' && c.model === 'haiku');
  assert.equal(h288.cases.b.status, 'regressed'); assert.equal(h288.cases.b.delta, -1);
  assert.equal(h288.passed, 1); assert.equal(h288.total, 2); assert.equal(h288.meanTurns, 4); assert.ok(Math.abs(h288.costUsd - 0.2) < 1e-9);
  assert.ok(ev.cells.find((c) => c.version === '2.1.290' && c.model === 'sonnet').isRef);

  // a case the reference also misses is amber and still safe; errored cells are named, not hidden
  const ev2 = evaluateMatrix([
    { version: '1.0.0', model: 'm', state: 'ran', json: result({ a: 1, b: 0.5 }) },
    { version: '1.0.1', model: 'm', state: 'ran', json: result({ a: 1, b: 0.5 }) },
    { version: '1.0.2', model: 'm', state: 'ran', json: result({ a: 1, b: 1 }, { errored: true }) },
  ], { versions: ['1.0.0', '1.0.1', '1.0.2'], models: ['m'], reference: { version: '1.0.0', model: 'm' } });
  assert.equal(ev2.cells[1].cases.b.status, 'below');
  assert.deepEqual(ev2.refBelow, ['b']);
  assert.equal(ev2.verdicts.m, 'm: safe on 1.0.0 to 1.0.1; errored on 1.0.2');

  // without a usable reference, the pass score alone decides
  const ev3 = evaluateMatrix([{ version: '1.0.1', model: 'm', state: 'ran', json: result({ a: 0 }) }], { versions: ['1.0.0', '1.0.1'], models: ['m'], reference: { version: '1.0.0', model: 'm' } });
  assert.equal(ev3.refUsable, false); assert.equal(ev3.cells[1].cases.a.status, 'fail');
  assert.equal(ev3.verdicts.m, 'm: not safe on any tested version; fails a on 1.0.1; not run on 1.0.0');

  const html = renderMatrixHtml(ev, { suite: 'demo', budget: 5, spent: 1.2 });
  for (const s of ['<title>demo model matrix</title>', 'haiku: safe on 2.1.290 to 2.1.295; fails b on 2.1.288', 'Claude Code 2.1.295', 'st-regressed', 'not run', '>2/2<', '$1.20', 'prefers-color-scheme:dark', 'Safe on 4 of 6 cells']) assert.ok(html.includes(s), `page has ${s}`);
  assert.ok(!/[—~]/.test(html.replace(/<style>[\s\S]*<\/style>/, '')), 'no em dashes or tildes in the visible text');
  const md = renderMatrixMd(ev, { suite: 'demo', spent: 1.2, budget: 5 });
  assert.match(md, /- haiku: safe on 2\.1\.290 to 2\.1\.295; fails b on 2\.1\.288/);
  assert.match(md, /\| 2\.1\.288 \| haiku \| 1\/2 \| \$0\.20 \| 4\.0 \| fails b \|/);
  assert.match(md, /\| 2\.1\.290 \| sonnet \(reference\) \| 2\/2 \|/);
  const j = matrixJson(ev, { suite: 'demo' });
  assert.equal(j.cells.length, 6); assert.equal(j.cells.find((c) => c.state === 'unrun').verdict, 'unrun'); assert.ok(!('json' in j.cells[0]));
});

test('estimateCost: per-model mean from history (alias matches its resolved id), all-model mean otherwise', () => {
  const est = estimateCost([{ json: result({ a: 1, b: 1 }, { model: 'claude-haiku-4-5', cost: 0.02 }) }, { json: result({ a: 1 }, { model: 'claude-sonnet-5', cost: 0.2 }) }], ['haiku', 'opus']);
  assert.equal(est.samples, 3);
  assert.ok(Math.abs(est.perModel.haiku.usd - 0.02) < 1e-9); assert.equal(est.perModel.haiku.exact, true);
  assert.ok(Math.abs(est.perModel.opus.usd - 0.08) < 1e-9); assert.equal(est.perModel.opus.exact, false);
});

test('runMatrix + fake claude: every cell is a stored aggregate result on its own version, reference first, verdicts from real shim runs', async () => {
  const plugin = await makePlugin(), state = await tmp('matrix-state-'), outDir = await tmp('matrix-out-');
  const { install, installed } = fakeInstaller(state, { failModel: { '2.1.1': 'haiku' } });
  const reference = { version: '2.1.2', model: 'sonnet' };
  const res = await runMatrix({ plugin, versions: ['2.1.1', '2.1.2'], models: ['sonnet', 'haiku'], reference, runner: 'shim', budget: 5, outDir, install, log: () => {} });
  assert.deepEqual(installed, ['2.1.2', '2.1.1'], 'the reference version is installed and run first, each version once');
  assert.equal(res.cells.length, 4); assert.ok(res.cells.every((c) => c.state === 'ran' && c.runner === 'shim'));
  assert.ok(Math.abs(res.spent - 0.8) < 1e-9, '4 cells × 2 cases × 1 run × $0.10');
  const log = await calls(state);
  assert.equal(log.length, 8);
  assert.deepEqual([...new Set(log.map((c) => c.args[c.args.indexOf('--model') + 1]))].sort(), ['haiku', 'sonnet']);
  for (const c of res.cells) {
    const stored = JSON.parse(await fs.readFile(path.join(outDir, `${cellId(c.version, c.model)}.json`), 'utf8'));
    assert.deepEqual(stored.cases.find((x) => x.dir === 'case-b').tags, ['slow'], 'block-list tags parse in the shim');
    assert.equal(stored.harness.version, c.version); assert.deepEqual(stored.matrix, { version: c.version, model: c.model, runner: 'shim', note: null });
    assert.ok(existsSync(path.join(outDir, `${cellId(c.version, c.model)}.html`)));
  }
  const ev = evaluateMatrix(res.cells, { versions: ['2.1.1', '2.1.2'], models: ['sonnet', 'haiku'], reference });
  assert.equal(ev.verdicts.sonnet, 'sonnet: safe on 2.1.1 to 2.1.2');
  assert.equal(ev.verdicts.haiku, 'haiku: safe on 2.1.2; fails case-a and case-b on 2.1.1');

  // --from: the same dir re-rendered without running anything (no installs, no new calls)
  await fs.writeFile(path.join(outDir, 'matrix.json'), JSON.stringify(matrixJson(ev, { suite: 'fixture-plugin', budget: 5, spent: res.spent })));
  const r = spawnSync('node', [TOOL, '--from', outDir, '--md', '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- haiku: safe on 2\.1\.2; fails case-a and case-b on 2\.1\.1/);
  assert.match(r.stdout, /Reference: sonnet on Claude Code 2\.1\.2/);
  const page = await fs.readFile(path.join(outDir, 'matrix.html'), 'utf8');
  assert.ok(page.includes('fixture-plugin') && page.includes('href="cc2.1.1-haiku.html"'));
  assert.equal((await calls(state)).length, 8);
  const loaded = await loadMatrixDir(outDir);
  assert.equal(loaded.cells.length, 4); assert.equal(loaded.manifest.reference.version, '2.1.2');
});

test('runMatrix: the budget is a ceiling for the whole grid; cells past it are marked not run, never started', async () => {
  const plugin = await makePlugin(), state = await tmp('matrix-state-'), outDir = await tmp('matrix-out-');
  const { install, installed } = fakeInstaller(state, { extraEnv: { FAKE_CLAUDE_COST: '1' } });
  const res = await runMatrix({ plugin, versions: ['2.1.1', '2.1.2'], models: ['sonnet', 'haiku'], reference: { version: '2.1.1', model: 'sonnet' }, runner: 'shim', budget: 1.5, outDir, install, log: () => {} });
  assert.deepEqual(res.cells.map((c) => `${c.version}/${c.model}/${c.state}`), ['2.1.1/sonnet/ran', '2.1.1/haiku/unrun', '2.1.2/sonnet/unrun', '2.1.2/haiku/unrun']);
  assert.deepEqual(installed, ['2.1.1'], 'a version with no cell left to run is never installed');
  assert.equal((await calls(state)).length, 2);
  const ev = evaluateMatrix(res.cells, { versions: ['2.1.1', '2.1.2'], models: ['sonnet', 'haiku'], reference: { version: '2.1.1', model: 'sonnet' } });
  assert.equal(ev.verdicts.haiku, 'haiku: not run');
  assert.match(ev.cells.find((c) => c.model === 'haiku').reason, /budget \$1\.5 spent/);
});

test('runMatrix: --tag and --case narrow the suite through a copied view; auto falls back to the shim on an early-access release', async () => {
  const plugin = await makePlugin(), state = await tmp('matrix-state-'), outDir = await tmp('matrix-out-');
  const view = await suiteView(plugin, { tag: 'slow' });
  assert.deepEqual(view.cases, ['case-b']); assert.notEqual(view.dir, plugin);
  assert.deepEqual((await fs.readdir(path.join(view.dir, 'evals'))).sort(), ['case-b']);
  assert.ok(existsSync(path.join(view.dir, '.claude-plugin', 'plugin.json')));
  await view.cleanup(); assert.ok(!existsSync(view.dir));
  assert.deepEqual((await suiteView(plugin, { caseGlob: 'case-*' })).cases, ['case-a', 'case-b']);

  const { install } = fakeInstaller(state, { extraEnv: { FAKE_CLAUDE_EARLY_ACCESS: '1' } });
  const res = await runMatrix({ plugin, versions: ['2.1.1'], models: ['sonnet'], reference: { version: '2.1.1', model: 'sonnet' }, tag: 'demo', runner: 'auto', outDir, install, log: () => {} });
  assert.equal(res.cells[0].runner, 'shim');
  assert.deepEqual(res.cells[0].json.cases.map((c) => c.dir), ['case-a']);
  assert.equal((await calls(state)).length, 1);

  // a release whose official runner writes no usable result falls back too, and says why
  const state2 = await tmp('matrix-state-');
  const res2 = await runMatrix({ plugin, versions: ['2.1.1'], models: ['sonnet'], reference: { version: '2.1.1', model: 'sonnet' }, caseGlob: 'case-a', runner: 'official', outDir: await tmp('matrix-out-'), install: fakeInstaller(state2).install, log: () => {} });
  assert.equal(res2.cells[0].runner, 'shim'); assert.match(res2.cells[0].note, /official runner gave no usable result \(no result file\); fell back to the shim/);
  await assert.rejects(runMatrix({ plugin, versions: ['2.1.1'], models: ['m'], reference: { version: '2.1.1', model: 'm' }, tag: 'nope', outDir, install }), /no eval cases match --tag nope/);
});

test('CLI --dry-run: grid and cost estimate from history, installs nothing, spends nothing', async () => {
  const plugin = await makePlugin('model:\n  pinned: sonnet\nharness:\n  pinned: "2.1.2"\n');
  const hist = await tmp('matrix-hist-');
  await fs.writeFile(path.join(hist, 'old.json'), JSON.stringify({ schemaVersion: '1.1', ...result({ 'case-a': 1, 'case-b': 1 }, { model: 'claude-haiku-4-5', cost: 0.05 }) }));
  const r = spawnSync('node', [TOOL, plugin, '--models', 'sonnet,haiku', '--versions', '2.1.1,2.1.2', '--budget', '1', '--history', hist, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Grid: 2 versions × 2 models = 4 cells · 2 cases × 1 run = 2 agent runs per cell, 8 in all/);
  assert.match(r.stdout, /reference: sonnet on Claude Code 2\.1\.2/);
  assert.match(r.stdout, /Estimated cost: about \$0\.40 \(sonnet \$0\.05 per run, all-model average; haiku \$0\.05 per run from 2 past runs\)/);
  assert.match(r.stdout, /The \$1 budget covers every cell\./);
  assert.match(r.stdout, /Dry run: nothing installed, nothing run, \$0 spent\./);
  assert.ok(!existsSync(path.join(plugin, 'evals', 'results')), 'nothing written into the plugin');

  const bad = spawnSync('node', [TOOL, plugin, '--models', 'sonnet', '--dry-run'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /pass --versions a,b or --last N/);
  const notInGrid = spawnSync('node', [TOOL, plugin, '--versions', '2.1.1', '--reference', 'opus', '--dry-run'], { encoding: 'utf8' });
  assert.equal(notInGrid.status, 2); assert.match(notInGrid.stderr, /--reference 2\.1\.1:opus is not in the grid/);
});
