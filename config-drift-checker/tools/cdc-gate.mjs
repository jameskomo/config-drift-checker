#!/usr/bin/env node
// cdc-gate — the two things that keep a BYOK key from being drained: a monthly budget ledger and a
// minimum interval between scheduled canaries. Both live on the results branch, next to the baseline.
//
//   node tools/cdc-gate.mjs check --config <plugin-dir> --track pinned|canary --spend <spend.json>
//        [--streak <streak.json>] [--event schedule|push|pull_request|workflow_dispatch] [--force] [--now <iso>]
//     → run=true|false  reason=ok|budget|interval  spent_month=<usd>  cap_month=<usd>  remaining=<usd>  next_allowed=<iso|none>
//   node tools/cdc-gate.mjs record --spend <spend.json> --result <aggregate-result.json> [--track t] [--run-url u] [--now <iso>]
//     → spent_month=<usd>  runs_month=<n>
//
// A manual `workflow_dispatch` with --force skips both gates: the person clicking the button is the budget.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

export const monthOf = (iso) => iso.slice(0, 7);
export const emptyLedger = () => ({ months: {}, runs: [] });

export function decide({ track, spend, streak = null, event = 'workflow_dispatch', force = false, now = new Date().toISOString() }) {
  const month = monthOf(now);
  const spent = spend?.months?.[month]?.usd ?? 0;
  const cap = Number(track.budget.per_month_usd);
  const base = { spent_month: round(spent), cap_month: cap, remaining: round(Math.max(0, cap - spent)), next_allowed: 'none' };
  if (force && event === 'workflow_dispatch') return { run: true, reason: 'forced', ...base };
  if (cap > 0 && spent >= cap) return { run: false, reason: 'budget', ...base };
  if (track.track === 'canary' && event === 'schedule' && streak?.lastRunAt && track.minIntervalHours > 0) {
    const next = new Date(new Date(streak.lastRunAt).getTime() + track.minIntervalHours * 3_600_000);
    if (new Date(now) < next) return { run: false, reason: 'interval', ...base, next_allowed: next.toISOString() };
  }
  return { run: true, reason: 'ok', ...base };
}

export function record(ledger, result, { track = result.track ?? 'pinned', runUrl = null, now = new Date().toISOString() } = {}) {
  const l = ledger && typeof ledger === 'object' ? { months: { ...(ledger.months ?? {}) }, runs: [...(ledger.runs ?? [])] } : emptyLedger();
  const usd = Number(result.aggregates?.costUsd ?? 0);
  const month = monthOf(now);
  const m = l.months[month] ?? { usd: 0, runs: 0 };
  l.months[month] = { usd: round(m.usd + usd), runs: m.runs + 1 };
  l.runs.push({ at: now, track, usd: round(usd), harness: result.harness?.version ?? null, models: result.aggregates?.resolvedModels ?? [], overall: result.aggregates?.overallScore ?? null, errored: result.aggregates?.erroredRuns ?? 0, runUrl });
  l.runs = l.runs.slice(-200);
  return l;
}
const round = (x) => Math.round(x * 10000) / 10000;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const readJson = async (p) => (p && existsSync(p) ? JSON.parse(await fs.readFile(p, 'utf8')) : null);
  const emit = (o) => process.stdout.write(Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  if (cmd === 'check') {
    const track = resolveTrack(loadConfig(path.resolve(flag('--config') ?? '.')), flag('--track'));
    const r = decide({ track, spend: await readJson(flag('--spend')), streak: await readJson(flag('--streak')), event: flag('--event') ?? 'workflow_dispatch', force: rest.includes('--force'), now: flag('--now') });
    emit(r);
  } else if (cmd === 'record') {
    const spendPath = flag('--spend'); const result = await readJson(flag('--result'));
    if (!result) { console.error('cdc-gate record: --result file missing'); process.exit(2); }
    const l = record((await readJson(spendPath)) ?? emptyLedger(), result, { track: flag('--track') ?? result.track, runUrl: flag('--run-url') ?? null, now: flag('--now') });
    await fs.mkdir(path.dirname(spendPath), { recursive: true });
    await fs.writeFile(spendPath, JSON.stringify(l, null, 2) + '\n');
    const month = monthOf(flag('--now') ?? new Date().toISOString());
    emit({ spent_month: l.months[month].usd, runs_month: l.months[month].runs });
  } else { console.error('usage: cdc-gate.mjs check|record …'); process.exit(2); }
}
