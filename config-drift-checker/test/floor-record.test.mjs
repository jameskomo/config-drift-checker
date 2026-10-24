import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFloor, summarize, floorName, floorMarkdown, pickContextCost, loadFloors } from '../tools/floor-record.mjs';

const TOOL = new URL('../tools/floor-record.mjs', import.meta.url).pathname;
const kv = (s) => Object.fromEntries(s.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
// the shapes skill-lint --json, suite-doctor --json and context-cost --store write
const skills = { schemaVersion: 1, skills: 1, errors: 0, warnings: 0, findings: [] };
const suite = (live) => ({ cases: 6, findings: [], live, summary: { errors: 0, warnings: 0, fixed: 0, fixable: 0 } });
const liveOk = { status: 'ok', version: '2.1.310', loaded: 6, failedCount: 0, runsStarted: 0, costUsd: 0, loadErrors: [], notes: [] };
const cost = (v, alwaysOn, at = '2026-10-24T07:59:18.000Z') => ({ schemaVersion: 1, tool: 'context-cost', generatedAt: at, claudeVersion: v, source: 'official', totals: { alwaysOn, onInvoke: 440 }, components: [] });

test('summary: the exact sentence the job summary and the warning carry', () => {
  const rec = buildFloor({ version: '2.1.310', reason: 'budget', track: 'canary', spent: '25.1', cap: '25', skills, suite: suite(liveOk), contextCost: { alwaysOn: 123, onInvoke: 440, source: 'official' }, now: '2026-10-24T08:00:00.000Z' });
  assert.equal(rec.summary, 'Behaviour not tested on 2.1.310 (monthly budget reached). Free checks ran: suite loads 6 of 6, context cost 123 tokens.');
  assert.equal(rec.tool, 'floor'); assert.equal(rec.claudeCode, '2.1.310'); assert.equal(rec.track, 'canary');
  assert.deepEqual(rec.skip, { reason: 'budget', spentMonth: 25.1, capMonth: 25, nextAllowed: null });
  assert.deepEqual(rec.preflight.suite, suite(liveOk), 'the full preflight rides along for the Setup health strip');
  assert.equal(floorName(rec), '20261024T080000Z-cc2.1.310.json');
  assert.doesNotMatch(floorMarkdown(rec) + rec.summary, /[–—~]/, 'plain punctuation');
});

test('summary: interval skips, failed loads, lint problems and missing inputs are said plainly', () => {
  const s = (o) => summarize(buildFloor({ version: '2.1.311', ...o }));
  assert.equal(s({ reason: 'interval', suite: suite({ ...liveOk, loaded: 4, failedCount: 2 }) }), 'Behaviour not tested on 2.1.311 (too soon after the last scheduled canary). Free checks ran: suite loads 4 of 6.');
  assert.match(s({ reason: 'budget', suite: { ...suite({ status: 'skipped', reason: 'no claude' }), summary: { errors: 2 } } }), /suite format checked without the runner \(6 cases, loading not confirmed\), suite has 2 errors\.$/);
  assert.match(s({ reason: 'budget', skills: { ...skills, errors: 1 } }), /Free checks ran: skills have 1 error\.$/);
  assert.equal(s({ reason: 'budget' }), 'Behaviour not tested on 2.1.311 (monthly budget reached). The free checks produced no result.');
  const iv = buildFloor({ version: '2.1.311', reason: 'interval', nextAllowed: '2026-10-25T00:00:00.000Z' });
  assert.match(floorMarkdown(iv), /The next scheduled canary after 2026-10-25T00:00:00\.000Z tests it/);
  assert.equal(buildFloor({ version: '1.0.0', reason: 'interval', nextAllowed: 'none' }).skip.nextAllowed, null);
});

test('pickContextCost: the measurement for this version from a --store dir, newest wins', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'floor-cc-'));
  await fs.writeFile(path.join(d, '20261001T000000Z-cc2.1.300.json'), JSON.stringify(cost('2.1.300', 99)));
  await fs.writeFile(path.join(d, '20261024T000000Z-cc2.1.310.json'), JSON.stringify(cost('2.1.310', 120)));
  await fs.writeFile(path.join(d, '20261024T010000Z-cc2.1.310.json'), JSON.stringify(cost('2.1.310', 123)));
  await fs.writeFile(path.join(d, 'junk.json'), '{');
  assert.equal(pickContextCost(d, '2.1.310').alwaysOn, 123);
  assert.equal(pickContextCost(d, '2.1.300').alwaysOn, 99);
  assert.equal(pickContextCost(d, '2.1.999'), null);
  assert.equal(pickContextCost(path.join(d, 'nope'), '2.1.310'), null);
});

test('CLI: writes the record and the summary, prints name and summary for $GITHUB_OUTPUT; loadFloors reads it back', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'floor-cli-'));
  await fs.writeFile(path.join(d, 'skills.json'), JSON.stringify(skills));
  await fs.writeFile(path.join(d, 'suite.json'), JSON.stringify(suite(liveOk)));
  await fs.mkdir(path.join(d, 'cc'));
  await fs.writeFile(path.join(d, 'cc', 'm.json'), JSON.stringify(cost('2.1.310', 123)));
  const floor = path.join(d, 'floor'); await fs.mkdir(floor);
  const r = spawnSync('node', [TOOL, '--version', '2.1.310', '--reason', 'budget', '--track', 'canary', '--spent', '25', '--cap', '25', '--next-allowed', 'none',
    '--skills', path.join(d, 'skills.json'), '--suite', path.join(d, 'suite.json'), '--context-cost', path.join(d, 'cc'), '--out', path.join(floor, 'x.json'), '--md', path.join(d, 'f.md'), '--now', '2026-10-24T08:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = kv(r.stdout);
  assert.equal(o.name, '20261024T080000Z-cc2.1.310.json');
  assert.equal(o.summary, 'Behaviour not tested on 2.1.310 (monthly budget reached). Free checks ran: suite loads 6 of 6, context cost 123 tokens.');
  const md = await fs.readFile(path.join(d, 'f.md'), 'utf8');
  assert.match(md, /^## Agent-config eval: behaviour not tested on Claude Code 2\.1\.310\n\nBehaviour not tested on 2\.1\.310 \(monthly budget reached\)/);
  assert.match(md, /raise `budget\.per_month_usd` in \.cdc\.yml/);
  const [rec] = loadFloors(floor);
  assert.equal(rec.claudeCode, '2.1.310'); assert.equal(rec.contextCost.alwaysOn, 123);
  // missing inputs: still a record, nothing guessed
  const bare = spawnSync('node', [TOOL, '--version', '2.1.311', '--reason', 'interval', '--skills', path.join(d, 'nope.json'), '--context-cost', path.join(d, 'nope')], { encoding: 'utf8' });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(kv(bare.stdout).summary, /The free checks produced no result\.$/);
  assert.equal(spawnSync('node', [TOOL, '--reason', 'budget'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [TOOL, '--version'], { encoding: 'utf8' }).status, 2);
});
