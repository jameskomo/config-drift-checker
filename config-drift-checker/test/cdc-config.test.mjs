import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml, loadConfig, resolveTrack, setPins, starterConfig, DEFAULTS, mergeConfig } from '../tools/cdc-config.mjs';

const TOOL = new URL('../tools/cdc-config.mjs', import.meta.url).pathname;

test('parseYaml: nested maps, scalars, inline lists/maps, block lists, comments', () => {
  const y = parseYaml(`# top comment
track: canary   # trailing comment
model:
  pinned: claude-sonnet-5
  canary: "sonnet"
harness:
  pinned: 2.1.37
  canary: latest
fail_on: [score, turns]
thresholds: { score: 0.2, turns: 1 }
tags:
  - hook
  - 'guard #notacomment'
empty:
`);
  assert.equal(y.track, 'canary');
  assert.deepEqual(y.model, { pinned: 'claude-sonnet-5', canary: 'sonnet' });
  assert.equal(y.harness.pinned, '2.1.37'); // two dots → stays a string; a single-dot version like 2.1 would parse as a number, so the tool always String()s versions
  assert.deepEqual(y.fail_on, ['score', 'turns']);
  assert.deepEqual(y.thresholds, { score: 0.2, turns: 1 });
  assert.deepEqual(y.tags, ['hook', 'guard #notacomment']);
  assert.deepEqual(y.empty, {});
});

test('parseYaml: rejects malformed lines with a line number', () => {
  assert.throws(() => parseYaml('model:\n  pinned claude\n'), /line 2/);
});

test('mergeConfig: deep-merges maps, replaces lists', () => {
  const m = mergeConfig(DEFAULTS, { model: { pinned: 'x' }, fail_on: ['turns'] });
  assert.equal(m.model.pinned, 'x');
  assert.equal(m.model.canary, 'sonnet');
  assert.deepEqual(m.fail_on, ['turns']);
  assert.equal(m.budget.per_month_usd, 10);
});

test('resolveTrack: pinned without pins falls back to the canary alias and says so', () => {
  const r = resolveTrack(mergeConfig(DEFAULTS, {}), 'pinned');
  assert.equal(r.model, 'sonnet');
  assert.equal(r.modelIsPinned, false);
  assert.equal(r.harness, 'latest');
  assert.equal(r.expandOnDeviation, 0);
});

test('resolveTrack: canary uses aliases, sequential defaults, thresholds and budget', () => {
  const cfg = mergeConfig(DEFAULTS, { model: { pinned: 'claude-sonnet-5' }, harness: { pinned: '2.1.37' }, thresholds: { turns: 0.8 }, budget: { per_month_usd: 3 } });
  const p = resolveTrack(cfg, 'pinned');
  assert.equal(p.model, 'claude-sonnet-5'); assert.equal(p.modelIsPinned, true); assert.equal(p.harness, '2.1.37');
  const c = resolveTrack(cfg, 'canary');
  assert.equal(c.model, 'sonnet'); assert.equal(c.harness, 'latest');
  assert.equal(c.runs, 1); assert.equal(c.expandOnDeviation, 2); assert.equal(c.promoteAfter, 2); assert.equal(c.minIntervalHours, 72);
  assert.equal(c.thresholds.turns, 0.8); assert.equal(c.thresholds.score, 0.15);
  assert.equal(c.budget.per_month_usd, 3); assert.equal(c.budget.per_run_usd, 2);
  assert.throws(() => resolveTrack(cfg, 'nightly'), /pinned or canary/);
});

test('resolveTrack: noise and baseline defaults merge like budget', () => {
  assert.equal(DEFAULTS.noise.history_runs, 10);
  assert.equal(DEFAULTS.baseline.min_runs, 3);
  const r = resolveTrack(mergeConfig(DEFAULTS, { noise: { history_runs: 5 } }), 'pinned');
  assert.equal(r.noise.history_runs, 5);
  assert.equal(r.baseline.min_runs, 3);
});

test('setPins: rewrites in place, keeps comments and order, appends when missing', () => {
  const src = `track: pinned\nmodel:\n  pinned: old-model   # keep me\n  canary: sonnet\nharness:\n  canary: latest\nbudget:\n  per_month_usd: 10\n`;
  const out = setPins(src, { model: 'claude-sonnet-5-1', harness: '2.2.0' });
  assert.match(out, /^  pinned: claude-sonnet-5-1   # keep me$/m);
  assert.match(out, /^harness:\n  canary: latest\n  pinned: 2\.2\.0\n/m);
  assert.match(out, /^budget:\n  per_month_usd: 10\n$/m);
  assert.equal(setPins('', { model: 'm' }), 'model:\n  pinned: m\n');
  assert.equal(setPins(src, {}), src);
  // round-trips through the parser
  const y = parseYaml(out);
  assert.equal(y.model.pinned, 'claude-sonnet-5-1'); assert.equal(y.model.canary, 'sonnet'); assert.equal(String(y.harness.pinned), '2.2.0');
});

test('starterConfig parses and resolves with the documented defaults', () => {
  const y = parseYaml(starterConfig({ model: 'claude-sonnet-5', harness: '2.1.258' }));
  const r = resolveTrack(mergeConfig(DEFAULTS, y), 'pinned');
  assert.equal(r.model, 'claude-sonnet-5'); assert.equal(String(r.harness), '2.1.258');
  assert.deepEqual(r.failOn, ['score']);
  const bare = parseYaml(starterConfig());
  assert.equal(bare.model.pinned, null); assert.equal(bare.harness.pinned, null);
});

test('CLI: init → resolve --github-output → set-pins → get', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-config-'));
  execFileSync('node', [TOOL, dir, 'init'], { stdio: 'pipe' });
  const out = execFileSync('node', [TOOL, dir, 'resolve', 'canary', '--github-output'], { encoding: 'utf8' });
  assert.match(out, /^track=canary$/m); assert.match(out, /^model=sonnet$/m); assert.match(out, /^budget_per_month_usd=10$/m); assert.match(out, /^config_exists=true$/m);
  assert.match(out, /^noise_history_runs=10$/m); assert.match(out, /^baseline_min_runs=3$/m);
  execFileSync('node', [TOOL, dir, 'set-pins', '--model', 'claude-sonnet-5', '--harness', '2.1.258'], { stdio: 'pipe' });
  assert.equal(execFileSync('node', [TOOL, dir, 'get', 'model.pinned'], { encoding: 'utf8' }).trim(), 'claude-sonnet-5');
  assert.equal(execFileSync('node', [TOOL, dir, 'get', 'harness.pinned'], { encoding: 'utf8' }).trim(), '2.1.258');
  assert.equal(loadConfig(dir)._exists, true);
  const none = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-config-none-'));
  assert.equal(loadConfig(none)._exists, false);
  assert.match(execFileSync('node', [TOOL, none, 'resolve', '--github-output'], { encoding: 'utf8' }), /^model_is_pinned=false$/m);
});
