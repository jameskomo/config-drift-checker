// eval-stats: how sure a case's numbers are, and how many runs it takes to trust them.
// Information only. Verdicts stay with eval-classify (noise bands + escalations), so adding these
// numbers never changes what is red; it says when a green is too thin to mean much.
//
//   passRange(c)              Wilson 95% interval on the share of with-arm runs that passed
//   scoreRange(c)             95% interval on the mean with-arm score (seeded bootstrap, 3+ runs)
//   spread(groups)            standard deviation of one case's run scores, pooled within each result
//   runsNeeded(sd, drop)      runs per side to catch `drop` 8 times in 10 (normal approximation)
//   caseStats(k, c, sources, { drop })   all of the above for one case
import { withRuns } from './eval-classify.mjs';

export const PASS_SCORE = 1; // a run passes at a perfect score, the official runner's default --threshold
export const RUNS_CAP = 20;
export const RUNS_FLOOR = 3; // baseline.min_runs default: fewer is never baseline material
export const LEGEND = '95% range: where the true value most likely sits, given how much the runs varied (right 95 times in 100). More runs give a narrower range.';

const Z95 = 1.959964;      // two-sided 95%
const Z_ALPHA = 1.644854;  // one-sided 5%: we only care about drops
const Z_POWER = 0.841621;  // 80% power

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const scoreOf = (r) => (typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null);

// A run passes when the runner said so (native results carry `passed`), else at PASS_SCORE.
export function runPassed(r, passScore = PASS_SCORE) {
  if (typeof r.passed === 'boolean') return r.passed;
  const s = scoreOf(r);
  return s === null ? null : s >= passScore - 1e-9;
}

// Wilson score interval: honest at small n and at 0 or n passes, where the plain p ± z·se collapses.
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { low: clamp01(center - half), high: clamp01(center + half) };
}

// Small, seeded PRNG so the same runs always print the same range (stored reports stay stable).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (xs) => xs.reduce((h, x) => Math.imul(h ^ Math.round(x * 1e6), 16777619) >>> 0, 2166136261);

// Percentile bootstrap of the mean: no normal or t assumption, stays inside [0, 1] like the scores.
export function bootstrapMean(xs, { resamples = 2000, minRuns = 3 } = {}) {
  const n = xs.length;
  if (n < minRuns) return null;
  const rand = mulberry32(seedOf(xs));
  const means = new Float64Array(resamples);
  for (let i = 0; i < resamples; i++) { let s = 0; for (let j = 0; j < n; j++) s += xs[Math.floor(rand() * n)]; means[i] = s / n; }
  means.sort();
  const at = (q) => means[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))];
  return { low: at(0.025), high: at(0.975) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreRange(c) {
  const xs = withRuns(c).map(scoreOf).filter((s) => s !== null);
  return { mean: mean(xs), runs: xs.length, ...(bootstrapMean(xs) ?? { low: null, high: null }) };
}

export function passRange(c, passScore = PASS_SCORE) {
  const v = withRuns(c).map((r) => runPassed(r, passScore)).filter((p) => p !== null);
  const k = v.filter(Boolean).length;
  return { passed: k, runs: v.length, rate: v.length ? k / v.length : null, ...(wilson(k, v.length) ?? { low: null, high: null }) };
}

// Run-to-run spread of one case. Each result file is one group: differences between files can be real
// drift, so the variance is pooled within groups. Single-run groups (a canary at runs: 1) have nothing
// within, so then every score counts as one sample, which overstates noise rather than hiding it.
export function spread(groups) {
  const gs = groups.filter((g) => g.length);
  let ss = 0, df = 0;
  for (const g of gs) { const m = mean(g); ss += g.reduce((a, x) => a + (x - m) ** 2, 0); df += g.length - 1; }
  if (df >= 2) return { sd: Math.sqrt(ss / df), samples: gs.reduce((a, g) => a + g.length, 0), pooled: true };
  const all = gs.flat();
  if (all.length < 2) return { sd: null, samples: all.length, pooled: false };
  const m = mean(all);
  return { sd: Math.sqrt(all.reduce((a, x) => a + (x - m) ** 2, 0) / (all.length - 1)), samples: all.length, pooled: false };
}

// Runs per side (baseline and current, each a mean of n runs) for a one-sided 5% test to catch a drop
// of `drop` with 80% power: n = 2 (z_a + z_b)^2 sd^2 / drop^2. Floored at the baseline minimum, capped.
export function runsNeeded(sd, drop, { floor = RUNS_FLOOR, cap = RUNS_CAP } = {}) {
  if (sd === null || sd === undefined || !(drop > 0)) return null;
  const raw = Math.max(0, Math.ceil((2 * (Z_ALPHA + Z_POWER) ** 2 * sd * sd) / (drop * drop) - 1e-9));
  return { needed: Math.min(cap, Math.max(floor, raw)), raw, capped: raw > cap };
}

// Everything for one case. `sources` are the case objects of every result that is evidence for its
// spread (history, baseline, current); `current` is the result whose ranges are shown.
export function caseStats(current, sources, { drop, runs = null, floor = RUNS_FLOOR, cap = RUNS_CAP } = {}) {
  const groups = sources.filter(Boolean).map((c) => withRuns(c).map(scoreOf).filter((s) => s !== null));
  const sp = spread(groups);
  const need = runsNeeded(sp.sd, drop, { floor, cap });
  const have = runs ?? (current ? withRuns(current).length : null);
  return {
    score: current ? scoreRange(current) : null,
    pass: current ? passRange(current) : null,
    spread: sp,
    runsNeeded: need ? { ...need, current: have, short: have !== null && have < need.needed } : null,
  };
}

// ---------- plain-words formatting, shared by eval-diff, eval-report and runs-needed ----------
const f2 = (x) => Number(x).toFixed(2);
export const fmtRange = (x, r) => (x === null || x === undefined ? 'n/a' : r && r.low !== null && r.low !== undefined ? `${f2(x)} (${f2(r.low)} to ${f2(r.high)})` : `${f2(x)} (a range needs 3+ runs)`);
export const fmtPass = (p) => (!p || !p.runs ? 'n/a' : `${p.passed} of ${p.runs} (${f2(p.low)} to ${f2(p.high)})`);
export function shortLine(name, rn, drop) {
  const runs = `${rn.current} run${rn.current === 1 ? '' : 's'}`;
  return rn.capped
    ? `${name}: ${runs} can't tell a ${drop} drop from noise; this case would need more than ${RUNS_CAP} (capped at ${RUNS_CAP}), so steady its graders or prompt first`
    : `${name}: ${runs} can't tell a ${drop} drop from noise; this case needs ${rn.needed}${rn.raw < rn.needed ? ', the fewest a baseline accepts' : ''}`;
}
