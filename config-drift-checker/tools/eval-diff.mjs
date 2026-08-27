#!/usr/bin/env node
// eval-diff — compare a new aggregate-result.json against a baseline and report regressions.
//
//   node tools/eval-diff.mjs <baseline.json> <current.json> [--threshold 0.15] [--md <out.md>] [--json <out.json>]
//
// Exit 0: no regression. Exit 1: at least one case dropped by more than --threshold (default 0.15)
// or a case present in the baseline is missing. Works on the official runner's output and the shim's.
import { promises as fs } from 'node:fs';

const argv = process.argv.slice(2);
const files = [];
const opt = { threshold: 0.15, md: null, json: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--threshold') opt.threshold = Number(argv[++i]);
  else if (argv[i] === '--md') opt.md = argv[++i];
  else if (argv[i] === '--json') opt.json = argv[++i];
  else if (!argv[i].startsWith('--')) files.push(argv[i]);
}
if (files.length !== 2) { console.error('usage: eval-diff.mjs <baseline.json> <current.json> [--threshold 0.15] [--md out.md] [--json out.json]'); process.exit(2); }
const [base, cur] = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));

const key = (c) => c.dir ?? c.name;
const score = (c) => c.summary?.score ?? null;
const baseline = (c) => c.summary?.baselineScore ?? null;
const runs = (c) => (c.arms?.with ?? []).length;
const failedGraders = (c) => {
  const counts = {};
  for (const r of c.arms?.with ?? []) for (const g of r.graders ?? []) if (g.scored !== false && g.verdict === 'fail') counts[g.name] = (counts[g.name] ?? 0) + 1;
  return Object.entries(counts).map(([n, k]) => `${n}×${k}`).join(', ');
};
const model = (r) => { const m = new Set(); for (const c of r.cases ?? []) for (const run of c.arms?.with ?? []) if (run.model) m.add(run.model); return [...m].join(',') || '?'; };

const rows = [];
const baseMap = new Map((base.cases ?? []).map((c) => [key(c), c]));
const curMap = new Map((cur.cases ?? []).map((c) => [key(c), c]));
for (const [k, b] of baseMap) {
  const c = curMap.get(k);
  if (!c) { rows.push({ case: k, status: 'missing', before: score(b), after: null, delta: null }); continue; }
  const before = score(b), after = score(c);
  const delta = before !== null && after !== null ? after - before : null;
  const status = delta === null ? 'unknown' : delta < -opt.threshold ? 'regressed' : delta > opt.threshold ? 'improved' : 'stable';
  rows.push({ case: k, status, before, after, delta, runs: runs(c), baselineArm: baseline(c), failedGraders: failedGraders(c) });
}
for (const [k, c] of curMap) if (!baseMap.has(k)) rows.push({ case: k, status: 'new', before: null, after: score(c), delta: null, runs: runs(c), failedGraders: failedGraders(c) });

const regressed = rows.filter((r) => r.status === 'regressed' || r.status === 'missing');
const errored = cur.aggregates?.erroredRuns ?? 0;
const f = (x) => (x === null || x === undefined ? '—' : x.toFixed(2));
const fd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));
const icon = { regressed: '🔴', missing: '🔴', improved: '🟢', stable: '⚪', new: '🆕', unknown: '❔' };
const md = [
  `## Agent-config eval: ${errored ? `**⚠ ${cur.aggregates.partialReason}**` : regressed.length ? `**${regressed.length} regression(s)**` : 'no regressions'}`,
  '',
  `Suite \`${cur.suite?.name ?? '?'}\` · model ${model(cur)} (baseline ${model(base)}) · threshold ${opt.threshold} · overall ${f(base.aggregates?.overallScore)} → ${f(cur.aggregates?.overallScore)} · cost $${(cur.aggregates?.costUsd ?? 0).toFixed(2)}`,
  '',
  '| | case | before | after | Δ | runs | failing graders (with-arm) |',
  '|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${icon[r.status]} | ${r.case} | ${f(r.before)} | ${f(r.after)} | ${fd(r.delta)} | ${r.runs ?? '—'} | ${r.failedGraders || ''} |`),
  '',
  `<sub>baseline: ${base.generatedAt ?? files[0]} · current: ${cur.generatedAt ?? files[1]}</sub>`,
].join('\n');

console.log(md);
if (opt.md) await fs.writeFile(opt.md, md + '\n');
if (opt.json) await fs.writeFile(opt.json, JSON.stringify({ regressed: regressed.length, threshold: opt.threshold, rows, overall: { before: base.aggregates?.overallScore ?? null, after: cur.aggregates?.overallScore ?? null } }, null, 2));
process.exit(errored && errored === (cur.aggregates?.totalRuns ?? -1) ? 2 : regressed.length ? 1 : 0);
