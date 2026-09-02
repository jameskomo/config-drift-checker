import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide, record, emptyLedger } from '../tools/cdc-gate.mjs';
import { resolveTrack, mergeConfig, DEFAULTS } from '../tools/cdc-config.mjs';

const GATE = new URL('../tools/cdc-gate.mjs', import.meta.url).pathname;
const cfg = mergeConfig(DEFAULTS, { budget: { per_month_usd: 5 }, canary: { min_interval_hours: 72 } });
const pinned = resolveTrack(cfg, 'pinned'), canary = resolveTrack(cfg, 'canary');
const NOW = '2026-09-02T12:00:00.000Z';
const ledger = (usd) => ({ months: { '2026-09': { usd, runs: 3 } }, runs: [] });

test('budget: under the cap runs, at or over the cap refuses, force on dispatch overrides', () => {
  assert.equal(decide({ track: pinned, spend: ledger(4.99), now: NOW }).run, true);
  const over = decide({ track: pinned, spend: ledger(5), now: NOW, event: 'push' });
  assert.equal(over.run, false); assert.equal(over.reason, 'budget'); assert.equal(over.remaining, 0);
  assert.equal(decide({ track: pinned, spend: ledger(9), now: NOW, event: 'workflow_dispatch', force: true }).reason, 'forced');
  assert.equal(decide({ track: pinned, spend: ledger(9), now: NOW, event: 'push', force: true }).run, false, 'force only counts on a manual dispatch');
  assert.equal(decide({ track: pinned, spend: null, now: NOW }).spent_month, 0, 'no ledger yet');
  assert.equal(decide({ track: pinned, spend: ledger(3), now: '2026-10-01T00:00:00Z' }).spent_month, 0, 'a new month starts clean');
  const uncapped = resolveTrack(mergeConfig(DEFAULTS, { budget: { per_month_usd: 0 } }), 'pinned');
  assert.equal(decide({ track: uncapped, spend: ledger(999), now: NOW }).run, true, 'cap 0 = no cap');
});

test('interval: only a scheduled canary is throttled; push/PR/dispatch and the pinned track are not', () => {
  const streak = { lastRunAt: '2026-09-01T00:00:00Z' };
  const throttled = decide({ track: canary, spend: null, streak, event: 'schedule', now: NOW });
  assert.equal(throttled.run, false); assert.equal(throttled.reason, 'interval'); assert.equal(throttled.next_allowed, '2026-09-04T00:00:00.000Z');
  assert.equal(decide({ track: canary, spend: null, streak, event: 'schedule', now: '2026-09-04T00:00:01Z' }).run, true);
  assert.equal(decide({ track: canary, spend: null, streak, event: 'push', now: NOW }).run, true);
  assert.equal(decide({ track: canary, spend: null, streak, event: 'workflow_dispatch', now: NOW }).run, true);
  assert.equal(decide({ track: pinned, spend: null, streak, event: 'schedule', now: NOW }).run, true);
  assert.equal(decide({ track: canary, spend: null, streak: null, event: 'schedule', now: NOW }).run, true, 'first canary ever');
  assert.equal(decide({ track: canary, spend: ledger(5), streak, event: 'schedule', now: NOW }).reason, 'budget', 'budget is checked before interval');
});

test('record: accumulates per month, keeps a bounded run log with provenance', () => {
  const result = { track: 'canary', harness: { version: '2.1.258' }, aggregates: { costUsd: 0.4321, resolvedModels: ['claude-sonnet-5'], overallScore: 1, erroredRuns: 0 } };
  let l = record(emptyLedger(), result, { now: NOW, runUrl: 'https://x/1' });
  l = record(l, { ...result, aggregates: { ...result.aggregates, costUsd: 0.1 } }, { now: '2026-09-03T00:00:00Z' });
  assert.deepEqual(l.months['2026-09'], { usd: 0.5321, runs: 2 });
  assert.equal(l.runs.length, 2); assert.equal(l.runs[0].runUrl, 'https://x/1'); assert.equal(l.runs[0].harness, '2.1.258'); assert.deepEqual(l.runs[0].models, ['claude-sonnet-5']);
  for (let i = 0; i < 250; i++) l = record(l, result, { now: NOW });
  assert.equal(l.runs.length, 200);
  assert.equal(record(null, { aggregates: {} }, { now: NOW }).months['2026-09'].usd, 0, 'a result without cost still counts as a run');
});

test('CLI: check → record → check flips to budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-'));
  await fs.writeFile(path.join(dir, '.cdc.yml'), 'budget:\n  per_month_usd: 0.5\n');
  const spend = path.join(dir, 'spend.json'), result = path.join(dir, 'r.json');
  await fs.writeFile(result, JSON.stringify({ track: 'pinned', aggregates: { costUsd: 0.3 } }));
  const check = () => execFileSync('node', [GATE, 'check', '--config', dir, '--track', 'pinned', '--spend', spend, '--event', 'push', '--now', NOW], { encoding: 'utf8' });
  assert.match(check(), /^run=true\nreason=ok\nspent_month=0\ncap_month=0\.5\nremaining=0\.5/);
  execFileSync('node', [GATE, 'record', '--spend', spend, '--result', result, '--now', NOW]);
  assert.match(execFileSync('node', [GATE, 'record', '--spend', spend, '--result', result, '--now', NOW], { encoding: 'utf8' }), /^spent_month=0\.6\nruns_month=2$/m);
  assert.match(check(), /^run=false\nreason=budget/);
});
