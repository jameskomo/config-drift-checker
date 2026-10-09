#!/usr/bin/env node
// drift-bisect — git bisect for agent behaviour: find the exact Claude Code release that broke you.
//
//   node tools/drift-bisect.mjs <plugin> --case <glob> --good 2.1.258 --bad 2.1.274
//        [--runs 1] [--budget 3] [--pass-score 1]
//
// Given a case that passed on --good and fails on --bad, this binary-searches the published
// @anthropic-ai/claude-code versions between them: each step installs the midpoint version into
// a throwaway prefix (never touching your global install), runs the case through the shim, and
// narrows the range. log2(N) runs instead of N: 20 releases cost 4 or 5 case runs. The answer is
// the first bad version, the sentence for your bug report: "our setup regressed at X, last good Y".
//
// Spend: each step is one case × --runs agent runs, capped by --budget overall; $0 API on a
// subscription token, same as any local run.
import path from 'node:path';
import { versionsBetween, publishedVersions, installRelease, runSuite } from './cc-release.mjs';

export { versionsBetween }; // lives in cc-release.mjs, shared with drift-matrix

// classic first-bad binary search. isGood(version) → boolean. candidates ascending; the last one
// (bad) is assumed bad and never re-tested; returns { firstBad, steps: [{version, good}] }.
export async function bisect(candidates, isGood) {
  const steps = [];
  let lo = 0, hi = candidates.length - 1; // hi = known bad
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const ok = await isGood(candidates[mid]);
    steps.push({ version: candidates[mid], good: ok });
    if (ok) lo = mid + 1; else hi = mid;
  }
  return { firstBad: candidates[hi] ?? null, steps };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { plugin: null, case: null, good: null, bad: null, runs: 1, budget: 3, passScore: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') opt.case = argv[++i]; else if (a === '--good') opt.good = argv[++i];
    else if (a === '--bad') opt.bad = argv[++i]; else if (a === '--runs') opt.runs = Number(argv[++i]);
    else if (a === '--budget') opt.budget = Number(argv[++i]); else if (a === '--pass-score') opt.passScore = Number(argv[++i]);
    else if (!a.startsWith('--')) opt.plugin = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  if (!opt.plugin || !opt.case || !opt.good || !opt.bad) {
    console.error('usage: drift-bisect.mjs <plugin> --case <glob> --good <version> --bad <version> [--runs 1] [--budget 3] [--pass-score 1]');
    process.exit(2);
  }
  for (const v of [opt.good, opt.bad]) if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error(`'${v}' is not a version`); process.exit(2); }

  let all;
  try { all = publishedVersions(); } catch { console.error('npm view failed — network?'); process.exit(1); }
  const candidates = versionsBetween(all, opt.good, opt.bad);
  if (!candidates.length) { console.error(`no published versions in (${opt.good}, ${opt.bad}]`); process.exit(1); }
  console.log(`${candidates.length} candidate version(s) in (${opt.good} … ${opt.bad}] — about ${Math.ceil(Math.log2(Math.max(candidates.length, 2)))} test run(s)\n`);

  let spent = 0;
  const isGood = async (version) => {
    if (spent >= opt.budget) { console.error(`budget $${opt.budget} reached — narrow the range or raise --budget`); process.exit(3); }
    process.stdout.write(`· installing Claude Code ${version} … `);
    const inst = await installRelease(version);
    if (!inst) { console.log('install failed, treating as untestable (bad)'); return false; }
    process.stdout.write('running the case … ');
    const { json: j } = await runSuite({ plugin: opt.plugin, binDir: inst.binDir, runner: 'shim', caseGlob: opt.case, runs: opt.runs, budget: Math.max(0.1, opt.budget - spent) });
    let good = false, scoreTxt = '?';
    try {
      spent += j.aggregates?.costUsd ?? 0;
      const scores = (j.cases ?? []).map((c) => c.summary?.score).filter((s) => typeof s === 'number');
      good = scores.length > 0 && scores.every((s) => s >= opt.passScore) && !(j.aggregates?.erroredRuns > 0);
      scoreTxt = scores.map((s) => s.toFixed(2)).join(',') || 'none';
    } catch { good = false; }
    console.log(`${good ? 'GOOD' : 'BAD'} (score ${scoreTxt})`);
    await inst.cleanup();
    return good;
  };

  const { firstBad, steps } = await bisect(candidates, isGood);
  console.log(`\nFirst bad Claude Code version: ${firstBad}`);
  const lastGoodIdx = candidates.indexOf(firstBad) - 1;
  console.log(`Last good: ${lastGoodIdx >= 0 ? candidates[lastGoodIdx] : opt.good}`);
  console.log(`Steps: ${steps.length} · spend about $${spent.toFixed(2)} (notional; $0 API on a subscription token)`);
  console.log(`\nFor the bug report: "our agent setup's case '${opt.case}' regressed at Claude Code ${firstBad}; last good ${lastGoodIdx >= 0 ? candidates[lastGoodIdx] : opt.good}. Pin harness.pinned until adapted."`);
}
