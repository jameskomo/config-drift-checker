import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/drift-digest.mjs', import.meta.url).pathname;
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

async function driftDir(newest) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  const verdicts = [
    newest,
    { claudeCode: '2.1.270', at: daysAgo(3), track: 'canary', runner: 'shim', verdict: 'held', overall: 1, casesMoved: [], report: null },
    { claudeCode: '2.1.260', at: daysAgo(40), track: 'pinned', runner: 'shim', verdict: 'held', overall: 1, casesMoved: [], report: null },
  ];
  await fs.writeFile(path.join(dir, 'verdicts.json'), JSON.stringify({ suite: 's', generatedAt: now.toISOString(), pageUrl: 'https://x.example/drift', streak: { runs: 7, versions: 3, days: 24 }, verdicts }));
  const month = now.toISOString().slice(0, 7);
  await fs.writeFile(path.join(dir, 'spend.json'), JSON.stringify({ months: { [month]: { usd: 4.2, runs: 6 } } }));
  return dir;
}
const run = (dir) => {
  const md = path.join(dir, 'digest.md'), post = path.join(dir, 'post.txt');
  const r = spawnSync('node', [TOOL, dir, '--md', md, '--post', post], { encoding: 'utf8' });
  return { r, md, post };
};

test('held: calm digest with window, streak and spend; post celebrates the streak', async () => {
  const dir = await driftDir({ claudeCode: '2.1.274', at: daysAgo(1), track: 'canary', runner: 'shim', verdict: 'held', overall: 1, casesMoved: [], report: null });
  const { r, md, post } = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const d = await fs.readFile(md, 'utf8');
  assert.match(d, /2\.1\.274.*behaviour held/);
  assert.match(d, /2\.1\.270/); assert.doesNotMatch(d, /2\.1\.260/, '40-day-old verdict outside the window');
  assert.match(d, /3 releases clean/); assert.match(d, /\$4\.20/);
  assert.match(d, /feed: https:\/\/x\.example\/drift\/feed\.xml/);
  const p = await fs.readFile(post, 'utf8');
  assert.match(p, /behaviour held/); assert.match(p, /3 releases clean/);
});

test('drift: the post turns urgent, names the cases, links the report', async () => {
  const dir = await driftDir({ claudeCode: '2.1.274', at: daysAgo(0), track: 'canary', runner: 'shim', verdict: 'drift', overall: 0.62, casesMoved: ['tripwire', 'controller'], report: 'history/x.html' });
  const { post } = run(dir);
  const p = await fs.readFile(post, 'utf8');
  assert.match(p, /changed agent behaviour/);
  assert.match(p, /tripwire, controller regressed/);
  assert.match(p, /https:\/\/x\.example\/drift\/history\/x\.html/);
  assert.match(p, /check yours before your developers do/);
});
