import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advance, emptyStreak, prText } from '../tools/canary-promote.mjs';
import { resolveTrack, mergeConfig, DEFAULTS } from '../tools/cdc-config.mjs';

const PROMOTE = new URL('../tools/canary-promote.mjs', import.meta.url).pathname;
const cfg = mergeConfig(DEFAULTS, { model: { pinned: 'claude-sonnet-5' }, harness: { pinned: '2.1.200' }, canary: { promote_after: 2 } });
const canary = resolveTrack(cfg, 'canary'), pinnedT = resolveTrack(cfg, 'pinned');
const pins = { model: 'claude-sonnet-5', harness: '2.1.200', modelIsPinned: true };
const run = (o) => ({ green: true, model: 'claude-sonnet-5-1', harness: '2.1.258', at: '2026-09-02T00:00:00Z', overall: 1, passed: 3, caseCount: 3, costUsd: 0.2, ...o });

test('bump: two consecutive greens on the same new model+harness open a PR; a red resets; a change of pair restarts', () => {
  let { streak, decision } = advance(emptyStreak(), run(), canary, pins);
  assert.equal(streak.greens, 1); assert.equal(decision.kind, 'none');
  ({ streak, decision } = advance(streak, run({ at: '2026-09-05T00:00:00Z' }), canary, pins));
  assert.equal(decision.kind, 'bump'); assert.equal(decision.model, 'claude-sonnet-5-1'); assert.equal(decision.harness, '2.1.258');
  assert.equal(decision.branch, 'cdc/bump-claude-sonnet-5-1-cc2.1.258');
  assert.equal(streak.greens, 0, 'reset after opening'); assert.equal(streak.openedAt, '2026-09-05T00:00:00Z');
  // red resets
  let s = advance(emptyStreak(), run(), canary, pins).streak;
  s = advance(s, run({ green: false, overall: 0.4 }), canary, pins).streak;
  assert.equal(s.greens, 0); assert.equal(s.lastResult, 'red');
  // a different harness restarts the count
  s = advance(emptyStreak(), run(), canary, pins).streak;
  const r = advance(s, run({ harness: '2.1.259' }), canary, pins);
  assert.equal(r.streak.greens, 1); assert.equal(r.decision.kind, 'none');
});

test('no bump when the canary already equals the pins, or the model is unknown', () => {
  let s = advance(emptyStreak(), run({ model: 'claude-sonnet-5', harness: '2.1.200' }), canary, pins).streak;
  const same = advance(s, run({ model: 'claude-sonnet-5', harness: '2.1.200' }), canary, pins);
  assert.equal(same.streak.greens, 2); assert.equal(same.decision.kind, 'none');
  s = advance(emptyStreak(), run({ model: null }), canary, pins).streak;
  assert.equal(advance(s, run({ model: null }), canary, pins).decision.kind, 'none');
});

test('pin: a green pinned run with no declared pin opens a pin PR once', () => {
  const unpinned = { model: 'sonnet', harness: null, modelIsPinned: false };
  const { decision, streak } = advance(emptyStreak(), run({ model: 'claude-sonnet-5', harness: '2.1.258' }), pinnedT, unpinned);
  assert.equal(decision.kind, 'pin'); assert.equal(decision.branch, 'cdc/pin-claude-sonnet-5-cc2.1.258');
  assert.equal(advance(emptyStreak(), run({ model: 'claude-sonnet-5' }), pinnedT, pins).decision.kind, 'none', 'already pinned → nothing');
  assert.equal(advance(emptyStreak(), run({ green: false, model: 'claude-sonnet-5' }), pinnedT, unpinned).decision.kind, 'none', 'red → nothing');
  assert.equal(streak.history.length, 1);
});

test('prText: bump and pin bodies carry the before/after pins and the run table', () => {
  let s = advance(emptyStreak(), run(), canary, pins).streak;
  const { streak, decision } = advance(s, run({ at: '2026-09-05T00:00:00Z' }), canary, pins);
  const bump = prText(decision, streak, canary, pins, { diffMd: '## diff here', repo: 'o/r' });
  assert.match(bump.title, /^Bump pins: claude-sonnet-5-1 on Claude Code 2\.1\.258 passed the canary 2× in a row$/);
  assert.match(bump.body, /\| `model\.pinned` \| `claude-sonnet-5` \| `claude-sonnet-5-1` \|/);
  assert.match(bump.body, /\| `harness\.pinned` \| `2\.1\.200` \| `2\.1\.258` \|/);
  assert.match(bump.body, /2026-09-05 00:00 \| 1\.00 ✅ \| 3\/3 \| \$0\.20/);
  assert.match(bump.body, /## diff here/); assert.match(bump.body, /for o\/r/); assert.match(bump.body, /Never auto-merged/);
  const p = advance(emptyStreak(), run({ model: 'claude-sonnet-5' }), pinnedT, { model: 'sonnet', harness: null, modelIsPinned: false });
  const pin = prText(p.decision, p.streak, pinnedT, { model: 'sonnet', harness: null, modelIsPinned: false });
  assert.match(pin.title, /^Pin the baseline to claude-sonnet-5 on Claude Code 2\.1\.258$/);
  assert.match(pin.body, /floats on the `sonnet` alias/);
});

test('CLI: reads result + streak, writes streak, decision and PR body; green needs zero regressed/errored/failed and no budget stop', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
  await fs.writeFile(path.join(dir, '.cdc.yml'), 'model:\n  pinned: claude-sonnet-5\n  canary: sonnet\nharness:\n  pinned: 2.1.200\ncanary:\n  promote_after: 2\n');
  const result = (over = {}) => ({ track: 'canary', harness: { version: '2.1.258' }, suite: { caseCount: 3 }, aggregates: { overallScore: 1, passed: 3, failed: 0, erroredRuns: 0, costUsd: 0.2, resolvedModels: ['claude-sonnet-5-1'], ...over } });
  const res = path.join(dir, 'r.json'), streak = path.join(dir, 'canary/streak.json'), out = path.join(dir, 'decision/decision.json');
  const go = (r, extra = []) => { return execFileSync('node', [PROMOTE, '--config', dir, '--result', res, '--streak', streak, '--out', out, '--regressed', '0', ...extra], { encoding: 'utf8' }); };
  await fs.writeFile(res, JSON.stringify(result()));
  assert.match(go(result(), ['--now', '2026-09-02T00:00:00Z']), /^kind=none[\s\S]*greens=1\ngreen=true/);
  const second = go(result(), ['--now', '2026-09-05T00:00:00Z']);
  assert.match(second, /^kind=bump\nbranch=cdc\/bump-claude-sonnet-5-1-cc2\.1\.258\nmodel=claude-sonnet-5-1\nharness=2\.1\.258\ngreens=0\ngreen=true\ntitle=Bump pins/);
  assert.match(second, /body_file=.*pr-body\.md/);
  const d = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(d.kind, 'bump'); assert.equal(d.model, 'claude-sonnet-5-1');
  assert.match(await fs.readFile(path.join(dir, 'decision/pr-body.md'), 'utf8'), /Recent canary runs/);
  const s = JSON.parse(await fs.readFile(streak, 'utf8'));
  assert.equal(s.history.length, 2); assert.equal(s.openedAt, '2026-09-05T00:00:00Z');
  // not green: budget stop, errored, failed case, regressed
  for (const over of [{ budget: { exceeded: true } }, { erroredRuns: 1 }, { failed: 1 }]) { await fs.writeFile(res, JSON.stringify(result(over))); assert.match(go(result(over)), /green=false/); }
  await fs.writeFile(res, JSON.stringify(result()));
  assert.match(execFileSync('node', [PROMOTE, '--config', dir, '--result', res, '--streak', streak, '--regressed', '1'], { encoding: 'utf8' }), /green=false/);
});
