#!/usr/bin/env node
// baseline-check — refuse to promote a green-by-luck result to baseline.json.
//
//   node tools/baseline-check.mjs <aggregate-result.json> [--min-runs 3] [--config <plugin-dir>]
//
// Exit 1 (per-case reason on stderr) when any case has fewer scored with-arm runs than min-runs
// (--min-runs > .cdc.yml baseline.min_runs > 3) or any agent run errored — a baseline built on too
// little evidence makes every later diff a guess. Exit 0 otherwise.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

const argv = process.argv.slice(2);
const opt = { minRuns: null, config: null };
let file = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--min-runs') opt.minRuns = Number(argv[++i]);
  else if (a === '--config') opt.config = path.resolve(argv[++i]);
  else if (!a.startsWith('--')) file = a;
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (!file) { console.error('usage: baseline-check.mjs <aggregate-result.json> [--min-runs 3] [--config <plugin-dir>]'); process.exit(2); }
const result = JSON.parse(await fs.readFile(file, 'utf8'));
const cfg = opt.config ? resolveTrack(loadConfig(opt.config), result.track ?? 'pinned') : null;
const minRuns = opt.minRuns ?? cfg?.baseline?.min_runs ?? 3;

const problems = [];
for (const c of result.cases ?? []) {
  const n = (c.arms?.with ?? []).filter((r) => !r.isError && typeof r.score === 'number').length;
  if (n < minRuns) problems.push(`${c.dir ?? c.name}: ${n} scored with-arm run(s), baseline.min_runs is ${minRuns}`);
}
const errored = result.aggregates?.erroredRuns ?? 0;
if (errored > 0) problems.push(`${errored} of ${result.aggregates?.totalRuns ?? '?'} agent runs errored`);
if (problems.length) {
  console.error('baseline-check: this run is not baseline material —');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`baseline-check: ok (${(result.cases ?? []).length} case(s), ≥${minRuns} scored runs each, 0 errored)`);
