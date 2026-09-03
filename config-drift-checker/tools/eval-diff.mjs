#!/usr/bin/env node
// eval-diff — compare a new aggregate-result.json against a baseline and report drift.
//
//   node tools/eval-diff.mjs <baseline.json> <current.json> [--threshold 0.15] [--md <out.md>] [--json <out.json>]
//        [--config <plugin-dir>]          read thresholds and fail_on from <plugin-dir>/.cdc.yml
//        [--turns-threshold 0.5] [--cost-threshold 0.5] [--duration-threshold 0.5]   relative change that counts as drift
//        [--fail-on score,turns,cost,duration]   which drifts turn the exit code red (default: score)
//        [--history <dir>]   newest N (noise.history_runs, default 10) timestamped *.json results → per-case noise band
//
// Score drift: a case dropped by more than --threshold, or a baseline case is missing → "regressed".
// A drop past the threshold but inside the case's noise band (max−min of with-arm run scores across
// baseline + history runs) is "noisy" — a ⚠ warning, never red. Two escalations keep the band honest:
// an in-band drop where no current run reaches the baseline score (a consistent shift, not a flake),
// or one that was already down in the last two history runs (persisted), is red anyway — otherwise one
// old flake would widen the band and hide real breaks forever. A baseline with fewer scored runs than
// baseline.min_runs, or a run-score spread past half the threshold, gets a baseline-quality warning,
// never red. Low-scoring runs with ≤1 turn and no tool use, on a case whose baseline runs act, are
// flagged as likely refusals (a model guardrail change, not setup drift).
// Efficiency drift: median turns / cost / duration of the with-arm moved by more than its threshold →
// "slower" / "pricier" / "longer" — reported always, red only if listed in --fail-on.
// Exit 0: nothing red. Exit 1: red drift. Exit 2: every agent run errored (nothing to compare).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

const argv = process.argv.slice(2);
const files = [];
const opt = { threshold: null, turns: null, cost: null, duration: null, failOn: null, md: null, json: null, config: null, history: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--threshold') opt.threshold = Number(argv[++i]);
  else if (a === '--turns-threshold') opt.turns = Number(argv[++i]);
  else if (a === '--cost-threshold') opt.cost = Number(argv[++i]);
  else if (a === '--duration-threshold') opt.duration = Number(argv[++i]);
  else if (a === '--fail-on') opt.failOn = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--config') opt.config = path.resolve(argv[++i]);
  else if (a === '--md') opt.md = argv[++i];
  else if (a === '--json') opt.json = argv[++i];
  else if (a === '--history') opt.history = path.resolve(argv[++i]);
  else if (!a.startsWith('--')) files.push(a);
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (files.length !== 2) { console.error('usage: eval-diff.mjs <baseline.json> <current.json> [--threshold 0.15] [--config <plugin-dir>] [--fail-on score,turns] [--history dir] [--md out.md] [--json out.json]'); process.exit(2); }
const [base, cur] = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));

// thresholds: flag > .cdc.yml > default
const cfg = opt.config ? resolveTrack(loadConfig(opt.config), cur.track ?? 'pinned') : null;
const th = {
  score: opt.threshold ?? cfg?.thresholds.score ?? 0.15,
  turns: opt.turns ?? cfg?.thresholds.turns ?? 0.5,
  cost: opt.cost ?? cfg?.thresholds.cost ?? 0.5,
  duration: opt.duration ?? cfg?.thresholds.duration ?? 0.5,
};
const failOn = new Set(opt.failOn ?? cfg?.failOn ?? ['score']);
const minBaselineRuns = cfg?.baseline?.min_runs ?? 3;

// history: newest N files, same track only, the current result excluded — the evidence for the noise band
const history = [];
if (opt.history) {
  const curPath = path.resolve(files[1]);
  for (const n of (await fs.readdir(opt.history)).filter((x) => x.endsWith('.json')).sort().reverse()) {
    if (history.length >= (cfg?.noise?.history_runs ?? 10)) break;
    const p = path.join(opt.history, n);
    if (p === curPath) continue;
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf8'));
      if (j.track && cur.track && j.track !== cur.track) continue;
      history.push(j);
    } catch { /* an unreadable file is not evidence */ }
  }
}

const key = (c) => c.dir ?? c.name;
const score = (c) => c.summary?.score ?? null;
const baseline = (c) => c.summary?.baselineScore ?? null;
const withRuns = (c) => (c.arms?.with ?? []).filter((r) => !r.isError);
const withScores = (c) => withRuns(c).map((r) => r.score).filter((s) => typeof s === 'number');
const histCases = history.map((h) => new Map((h.cases ?? []).map((c) => [key(c), c])));
// noise band: spread of with-arm run scores across the baseline and history runs; null = not enough evidence
const noiseFor = (k, b) => {
  if (!opt.history) return { noise: null, effTh: th.score };
  const xs = [...withScores(b), ...histCases.flatMap((m) => (m.has(k) ? withScores(m.get(k)) : []))];
  const noise = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : null;
  return { noise, effTh: Math.max(th.score, noise ?? 0) };
};
const baselineWarnings = (b) => {
  const xs = withScores(b), out = [];
  if (xs.length < minBaselineRuns) out.push(`thin baseline (n=${xs.length})`);
  // some spread is the nature of an LLM judge; warn only past half the regression threshold
  const spread = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
  if (spread > th.score / 2) out.push(`unstable baseline (±${spread.toFixed(2)})`);
  return out;
};
const toolCount = (r) => (Array.isArray(r.toolUses) ? r.toolUses.length : r.toolUses ?? 0);
// runs that look like the model declined the task: ≤1 turn, no tool use, scored below the baseline —
// only meaningful on a case whose baseline runs do act (a negative-trigger case never "refuses")
const refusedRuns = (b, c, before) => {
  if (before === null || !(median(withRuns(b).map(toolCount)) > 0)) return 0;
  return withRuns(c).filter((r) => toolCount(r) === 0 && (r.numTurns ?? 99) <= 1 && typeof r.score === 'number' && r.score < before).length;
};
const runs = (c) => (c.arms?.with ?? []).length;
const failedGraders = (c) => {
  const counts = {};
  for (const r of c.arms?.with ?? []) for (const g of r.graders ?? []) if (g.scored !== false && g.verdict === 'fail') counts[g.name] = (counts[g.name] ?? 0) + 1;
  return Object.entries(counts).map(([n, k]) => `${n}×${k}`).join(', ');
};
const models = (r) => { const m = new Set(); for (const c of r.cases ?? []) for (const run of c.arms?.with ?? []) if (run.model) m.add(run.model); return [...m]; };
const median = (xs) => { const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const EFF = [['turns', 'numTurns', 'slower'], ['cost', 'costUsd', 'pricier'], ['duration', 'durationMs', 'longer']];
function efficiency(b, c) {
  const out = {};
  for (const [name, field] of EFF) {
    const before = median(withRuns(b).map((r) => r[field])), after = median(withRuns(c).map((r) => r[field]));
    const rel = before !== null && after !== null && before > 0 ? (after - before) / before : null;
    out[name] = { before, after, rel, drifted: rel !== null && rel > th[name] };
  }
  return out;
}

const rows = [];
const baseMap = new Map((base.cases ?? []).map((c) => [key(c), c]));
const curMap = new Map((cur.cases ?? []).map((c) => [key(c), c]));
for (const [k, b] of baseMap) {
  const c = curMap.get(k);
  const warnings = baselineWarnings(b);
  if (!c) { rows.push({ case: k, status: 'missing', before: score(b), after: null, delta: null, noise: null, effThreshold: th.score, historyRuns: history.length, warnings, flags: [] }); continue; }
  const before = score(b), after = score(c);
  const delta = before !== null && after !== null ? after - before : null;
  const { noise, effTh } = noiseFor(k, b);
  let status, escalated = null;
  if (delta === null) status = 'unknown';
  else if (delta < -th.score) {
    // "noisy" needs flake-shaped evidence, not just a wide band — see the escalations in the header
    const canStillSucceed = before !== null && withScores(c).some((s) => s >= before - 1e-9);
    const recent = histCases.map((m) => (m.has(k) ? score(m.get(k)) : null)).filter((s) => typeof s === 'number').slice(0, 2);
    const persisted = before !== null && recent.length >= 2 && recent.every((s) => s < before - th.score);
    if (delta < -effTh) status = 'regressed';
    else if (!canStillSucceed) { status = 'regressed'; escalated = 'no current run reached the baseline score — a consistent shift, not a flake'; }
    else if (persisted) { status = 'regressed'; escalated = 'the drop persisted across the last runs — no longer noise'; }
    else status = 'noisy';
  } else status = delta > th.score ? 'improved' : 'stable';
  const eff = efficiency(b, c);
  const flags = EFF.filter(([name]) => eff[name].drifted).map(([, , flag]) => flag);
  rows.push({ case: k, status, escalated, before, after, delta, noise, effThreshold: effTh, historyRuns: history.length, warnings, refusedRuns: status === 'regressed' || status === 'noisy' ? refusedRuns(b, c, before) : 0, runs: runs(c), baselineArm: baseline(c), failedGraders: failedGraders(c), eff, flags });
}
for (const [k, c] of curMap) if (!baseMap.has(k)) rows.push({ case: k, status: 'new', before: null, after: score(c), delta: null, noise: null, effThreshold: th.score, historyRuns: history.length, warnings: [], runs: runs(c), baselineArm: baseline(c), failedGraders: failedGraders(c), flags: [] });

const regressed = rows.filter((r) => r.status === 'regressed' || r.status === 'missing');
const flagged = rows.filter((r) => r.flags.length);
const red = rows.filter((r) => (failOn.has('score') && (r.status === 'regressed' || r.status === 'missing')) || r.flags.some((fl) => failOn.has(EFF.find(([, , f]) => f === fl)[0])));
const errored = cur.aggregates?.erroredRuns ?? 0;
const allErrored = errored > 0 && errored === (cur.aggregates?.totalRuns ?? -1);

// provenance: did the thing under test move, or the thing testing it?
const mb = models(base), mc = models(cur);
const moved = [];
if (mb.length && mc.length && (mb.join(',') !== mc.join(','))) moved.push(`⚙ model moved: ${mb.join(',')} → ${mc.join(',')}`);
if (base.harness?.version && cur.harness?.version && base.harness.version !== cur.harness.version) moved.push(`⚙ Claude Code moved: ${base.harness.version} → ${cur.harness.version}`);
const worth = (() => { const d = (cur.cases ?? []).map((c) => c.summary?.delta).filter((x) => typeof x === 'number'); return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null; })();

const f = (x) => (x === null || x === undefined ? '—' : x.toFixed(2));
const fd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));
const pct = (x) => (x === null || x === undefined ? '' : ` (${x >= 0 ? '+' : ''}${Math.round(x * 100)}%)`);
const fmtEff = (e, name, fmtv) => !e ? '—' : e[name].after === null ? '—' : e[name].drifted || (e[name].rel !== null && e[name].rel < -th[name]) ? `${fmtv(e[name].before)} → ${fmtv(e[name].after)}${pct(e[name].rel)}` : fmtv(e[name].after);
const t = (x) => (x === null ? '—' : String(Math.round(x)));
const usd = (x) => (x === null ? '—' : '$' + x.toFixed(2));
const icon = { regressed: '🔴', missing: '🔴', noisy: '⚠', improved: '🟢', stable: '⚪', new: '🆕', unknown: '❔' };
const noisy = rows.filter((r) => r.status === 'noisy');
const warned = rows.filter((r) => r.warnings?.length);
const warnBits = [flagged.length ? `${flagged.length} efficiency drift${flagged.length === 1 ? '' : 's'}` : null, noisy.length ? `${noisy.length} noisy` : null].filter(Boolean).join(' · ');
const headline = allErrored ? `**⚠ ${cur.aggregates.partialReason}**`
  : errored ? `**⚠ ${cur.aggregates.partialReason}**`
  : red.length ? `**${red.length} red (${regressed.length} regression${regressed.length === 1 ? '' : 's'}${flagged.length ? `, ${flagged.length} efficiency drift${flagged.length === 1 ? '' : 's'}` : ''})**`
  : regressed.length ? `**${regressed.length} regression(s)**`
  : warnBits ? `no regressions · ⚠ ${warnBits} (warning)`
  : 'no regressions';
const trackLabel = cur.track ? ` · track **${cur.track}**` : '';
const budget = cur.aggregates?.budget;
const md = [
  `## Agent-config eval: ${headline}`,
  '',
  `Suite \`${cur.suite?.name ?? '?'}\`${trackLabel} · model ${mc.join(',') || '?'} (baseline ${mb.join(',') || '?'}) · Claude Code ${cur.harness?.version ?? '?'}${base.harness?.version && base.harness.version !== cur.harness?.version ? ` (baseline ${base.harness.version})` : ''} · threshold ${th.score} · overall ${f(base.aggregates?.overallScore)} → ${f(cur.aggregates?.overallScore)} · cost $${(cur.aggregates?.costUsd ?? 0).toFixed(2)}`,
  ...(moved.length ? ['', moved.join(' · ')] : []),
  ...(worth !== null ? ['', `Setup worth **${fd(worth)}** on this suite (with − without plugin, mean over ${cur.cases.filter((c) => typeof c.summary?.delta === 'number').length} case${cur.cases.length === 1 ? '' : 's'})`] : []),
  ...(budget?.exceeded ? ['', `■ Budget cap $${budget.capUsd} reached after $${budget.spentUsd.toFixed(2)} — ${budget.skippedRuns} planned run(s) not started; cases without runs show as ❔, not as regressions`] : []),
  '',
  '| | case | before | after | Δ | noise | turns | cost | runs | failing graders (with-arm) |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${icon[r.status]}${r.flags.length ? ' ⚠' : ''} | ${r.case}${r.flags.length ? ` <sub>${r.flags.join(', ')}</sub>` : ''} | ${f(r.before)} | ${f(r.after)} | ${fd(r.delta)} | ${r.noise === null || r.noise === undefined ? '—' : `±${r.noise.toFixed(2)}`} | ${fmtEff(r.eff, 'turns', t)} | ${fmtEff(r.eff, 'cost', usd)} | ${r.runs ?? '—'} | ${r.failedGraders || ''} |`),
  ...(noisy.length ? ['', `_${noisy.length} case${noisy.length === 1 ? '' : 's'} dropped past ${th.score} but within historical noise (±${Math.max(...noisy.map((r) => r.noise ?? 0)).toFixed(2)} over the last ${history.length} run${history.length === 1 ? '' : 's'}) — warning, not a regression_`] : []),
  ...(rows.some((r) => r.escalated) ? ['', rows.filter((r) => r.escalated).map((r) => `_\`${r.case}\` is within its ±${(r.noise ?? 0).toFixed(2)} noise band but red anyway: ${r.escalated}_`).join('\n')] : []),
  ...(rows.some((r) => r.refusedRuns) ? ['', rows.filter((r) => r.refusedRuns).map((r) => `_\`${r.case}\`: ${r.refusedRuns} of ${r.runs} run(s) look like refusals (≤1 turn, no tool use) — likely a model guardrail change, not setup drift; read the run transcript before acting_`).join('\n')] : []),
  ...(warned.length ? ['', `**⚠ baseline quality (never red):** ${warned.map((r) => `\`${r.case}\` — ${r.warnings.join(', ')}`).join(' · ')}. More runs per case fix this; never loosen the threshold.`] : []),
  '',
  `<sub>baseline: ${base.generatedAt ?? files[0]} · current: ${cur.generatedAt ?? files[1]} · fail on: ${[...failOn].join(', ')} · efficiency thresholds: turns ${th.turns}, cost ${th.cost}, duration ${th.duration}</sub>`,
].join('\n');

console.log(md);
if (opt.md) await fs.writeFile(opt.md, md + '\n');
if (opt.json) await fs.writeFile(opt.json, JSON.stringify({ regressed: regressed.length, red: red.length, flagged: flagged.length, thresholds: th, failOn: [...failOn], moved, worth, rows, overall: { before: base.aggregates?.overallScore ?? null, after: cur.aggregates?.overallScore ?? null }, harness: { before: base.harness?.version ?? null, after: cur.harness?.version ?? null }, models: { before: mb, after: mc } }, null, 2));
process.exit(allErrored ? 2 : red.length ? 1 : 0);
