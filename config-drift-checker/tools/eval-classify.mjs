// eval-classify — the shared per-case verdict: a flat threshold, or the case's noise band when
// history says the case flakes. eval-diff (markdown + exit code), eval-report (HTML) and
// eval-dashboard (drift index) all classify through here so every surface agrees on the same run.
//
//   resolveThresholds(configDir, track, overrides)   th / failOn / minBaselineRuns / historyRuns (flag > .cdc.yml > default)
//   loadHistory(dir, { exclude, track, limit, before })   past aggregate results, newest first
//   classifyCase(k, baselineCase, currentCase, histCases|null, thScore)
//     → { status: regressed|noisy|improved|stable|unknown, escalated, before, after, delta, noise, effThreshold }
//     histCases: case-maps of past runs, newest first; null = no history → flat threshold.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

export const key = (c) => c.dir ?? c.name;
export const caseScore = (c) => c.summary?.score ?? null;
export const withRuns = (c) => (c.arms?.with ?? []).filter((r) => !r.isError);
export const withScores = (c) => withRuns(c).map((r) => r.score).filter((s) => typeof s === 'number');
export const median = (xs) => { const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
export const caseMap = (r) => new Map((r.cases ?? []).map((c) => [key(c), c]));

// thresholds: flag > .cdc.yml > default
export function resolveThresholds(configDir, track, over = {}) {
  const cfg = configDir ? resolveTrack(loadConfig(configDir), track ?? 'pinned') : null;
  return {
    cfg,
    th: {
      score: over.threshold ?? cfg?.thresholds.score ?? 0.15,
      turns: over.turns ?? cfg?.thresholds.turns ?? 0.5,
      cost: over.cost ?? cfg?.thresholds.cost ?? 0.5,
      duration: over.duration ?? cfg?.thresholds.duration ?? 0.5,
    },
    failOn: new Set(over.failOn ?? cfg?.failOn ?? ['score']),
    minBaselineRuns: cfg?.baseline?.min_runs ?? 3,
    historyRuns: cfg?.noise?.history_runs ?? 10,
  };
}

// history: newest N files, same track only, optionally only those older than `before` (a generatedAt) —
// the evidence for the noise band. An unreadable file is not evidence.
export async function loadHistory(dir, { exclude = null, track = null, limit = 10, before = null } = {}) {
  const out = [];
  for (const n of (await fs.readdir(dir)).filter((x) => x.endsWith('.json')).sort().reverse()) {
    if (out.length >= limit) break;
    const p = path.join(dir, n);
    if (exclude && p === exclude) continue;
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf8'));
      if (track && j.track && j.track !== track) continue;
      if (before && j.generatedAt && j.generatedAt >= before) continue;
      out.push(j);
    } catch { /* not evidence */ }
  }
  return out;
}

// noise band: spread of with-arm run scores across the baseline and history runs; null = not enough evidence
export function noiseFor(k, b, histCases, thScore) {
  if (!histCases) return { noise: null, effTh: thScore };
  const xs = [...withScores(b), ...histCases.flatMap((m) => (m.has(k) ? withScores(m.get(k)) : []))];
  const noise = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : null;
  return { noise, effTh: Math.max(thScore, noise ?? 0) };
}

export function baselineWarnings(b, minBaselineRuns, thScore) {
  const xs = withScores(b), out = [];
  if (xs.length < minBaselineRuns) out.push(`thin baseline (n=${xs.length})`);
  // some spread is the nature of an LLM judge; warn only past half the regression threshold
  const spread = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
  if (spread > thScore / 2) out.push(`unstable baseline (±${spread.toFixed(2)})`);
  return out;
}

// Per-case score verdict. "noisy" needs flake-shaped evidence, not just a wide band: an in-band drop
// where no current run reaches the baseline score (a consistent shift, not a flake), or one that was
// already down in the last two history runs (persisted), is red anyway — otherwise one old flake
// would widen the band and hide real breaks forever.
export function classifyCase(k, b, c, histCases, thScore) {
  const before = caseScore(b), after = caseScore(c);
  const delta = before !== null && after !== null ? after - before : null;
  const { noise, effTh } = noiseFor(k, b, histCases, thScore);
  let status, escalated = null;
  if (delta === null) status = 'unknown';
  else if (delta < -thScore) {
    const canStillSucceed = before !== null && withScores(c).some((s) => s >= before - 1e-9);
    const recent = (histCases ?? []).map((m) => (m.has(k) ? caseScore(m.get(k)) : null)).filter((s) => typeof s === 'number').slice(0, 2);
    const persisted = before !== null && recent.length >= 2 && recent.every((s) => s < before - thScore);
    if (delta < -effTh) status = 'regressed';
    else if (!canStillSucceed) { status = 'regressed'; escalated = 'no current run reached the baseline score — a consistent shift, not a flake'; }
    else if (persisted) { status = 'regressed'; escalated = 'the drop persisted across the last runs — no longer noise'; }
    else status = 'noisy';
  } else status = delta > thScore ? 'improved' : 'stable';
  return { status, escalated, before, after, delta, noise, effThreshold: effTh };
}
