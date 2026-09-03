#!/usr/bin/env node
// eval-dashboard — the drift index for one suite: every run over every Claude Code version and model,
// the pinned baseline against the canary, spend against budget, coverage. One static HTML file.
//
//   node tools/eval-dashboard.mjs <history-dir> [--baseline baseline.json] [--reports <dir>] [--out dashboard.html]
//        [--title <name>] [--spend spend.json] [--streak streak.json] [--coverage coverage.json] [--config <plugin-dir>]
//
// <history-dir> holds aggregate-result.json files (the Action names them <stamp>-cc<version>-<runner>[-<track>].json)
// or subdirectories each containing aggregate-result.json (local evals/results/). If --reports is given, a run's
// report is linked as <reports>/<basename>.html when that file exists. Cases are classified by eval-classify.mjs
// (noise band from the baseline + preceding same-track runs) — the same verdicts as eval-diff.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { key, caseMap, classifyCase } from './eval-classify.mjs';

const argv = process.argv.slice(2); const opt = { dir: null, baseline: null, reports: null, out: null, title: null, spend: null, streak: null, coverage: null, config: null };
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--baseline') opt.baseline = argv[++i]; else if (a === '--reports') opt.reports = argv[++i]; else if (a === '--out') opt.out = argv[++i]; else if (a === '--title') opt.title = argv[++i]; else if (a === '--spend') opt.spend = argv[++i]; else if (a === '--streak') opt.streak = argv[++i]; else if (a === '--coverage') opt.coverage = argv[++i]; else if (a === '--config') opt.config = argv[++i]; else if (!a.startsWith('--')) opt.dir = a; }
if (!opt.dir) { console.error('usage: eval-dashboard.mjs <history-dir> [--baseline b.json] [--reports dir] [--out dashboard.html] [--spend s.json] [--streak s.json] [--coverage c.json] [--config <plugin-dir>]'); process.exit(2); }
const readJson = async (p) => (p && existsSync(p) ? JSON.parse(await fs.readFile(p, 'utf8')) : null);

const outPath = opt.out ?? path.join(path.resolve(opt.dir), 'dashboard.html');
const relReports = opt.reports ? path.relative(path.dirname(path.resolve(outPath)), path.resolve(opt.reports)) : '';
const runs = [];
for (const e of await fs.readdir(opt.dir, { withFileTypes: true })) {
  let f = null, id = e.name;
  if (e.isFile() && e.name.endsWith('.json')) f = path.join(opt.dir, e.name), id = e.name.replace(/\.json$/, '');
  else if (e.isDirectory() && existsSync(path.join(opt.dir, e.name, 'aggregate-result.json'))) f = path.join(opt.dir, e.name, 'aggregate-result.json');
  if (!f) continue;
  try {
    const j = JSON.parse(await fs.readFile(f, 'utf8')); if (!j.cases) continue;
    const m = id.match(/cc([\d.]+)/);
    runs.push({ id, at: j.generatedAt ?? id, cc: j.harness?.version ?? (m ? m[1] : null), track: j.track ?? (/-canary$/.test(id) ? 'canary' : /-pinned$/.test(id) ? 'pinned' : null), runner: j.shim ? 'shim' : 'official', models: j.aggregates?.resolvedModels ?? [...new Set(j.cases.flatMap((c) => (c.arms?.with ?? []).map((r) => r.model)).filter(Boolean))], json: j, report: opt.reports && existsSync(path.join(opt.reports, id + '.html')) ? (relReports ? relReports + '/' : '') + id + '.html' : null });
  } catch {}
}
runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const base = await readJson(opt.baseline), spend = await readJson(opt.spend), streak = await readJson(opt.streak), coverage = await readJson(opt.coverage);
let cfg = null; if (opt.config) { try { const { loadConfig, resolveTrack } = await import('./cdc-config.mjs'); const c = loadConfig(path.resolve(opt.config)); cfg = { pinnedModel: c.model?.pinned ?? null, pinnedHarness: c.harness?.pinned != null ? String(c.harness.pinned) : null, canaryAlias: c.model?.canary ?? 'sonnet', promoteAfter: resolveTrack(c, 'canary').promoteAfter, threshold: resolveTrack(c, 'pinned').thresholds.score, historyRuns: resolveTrack(c, 'pinned').noise.history_runs, capMonth: resolveTrack(c, 'pinned').budget.per_month_usd }; } catch {} }
const TH = cfg?.threshold ?? 0.15;
const HIST_N = cfg?.historyRuns ?? 10;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
const when = (s) => String(s ?? '').replace('T', ' ').slice(0, 16);
const caseNames = [...new Set(runs.flatMap((r) => r.json.cases.map(key)))];
const latest = runs.at(-1);
const latestPinned = [...runs].reverse().find((r) => r.track !== 'canary') ?? null;
const latestCanary = [...runs].reverse().find((r) => r.track === 'canary') ?? null;
const suite = opt.title ?? latest?.json.suite?.name ?? path.basename(path.resolve(opt.dir));
const totalCost = runs.reduce((s, r) => s + (r.json.aggregates?.costUsd ?? 0), 0);
// each run's noise band comes from the baseline + the newest preceding same-track runs (eval-classify)
for (let i = 0; i < runs.length; i++) {
  const r = runs[i], preceding = [];
  for (let j = i - 1; j >= 0 && preceding.length < HIST_N; j--) if (!r.track || !runs[j].track || runs[j].track === r.track) preceding.push(runs[j].json);
  r.histCases = preceding.map(caseMap);
}
const caseStatus = (c, r) => { const s = c?.summary?.score; if (!c) return 'none'; if ((c.arms?.with ?? []).length && (c.arms.with.every((x) => x.isError))) return 'errored'; if (s === null || s === undefined) return 'none'; const b = base?.cases.find((x) => key(x) === key(c)); if (b && b.summary?.score !== null && b.summary?.score !== undefined) { const st = classifyCase(key(c), b, c, r.histCases, TH).status; if (st === 'regressed') return 'regressed'; if (st === 'noisy') return 'noisy'; } if (s < 1) return 'below'; return (c.arms?.with ?? []).some((x) => x.truncated) ? 'warn' : 'pass'; };
const runStatus = (r) => { const a = r.json.aggregates ?? {}; if (a.erroredRuns) return 'errored'; const st = r.json.cases.map((c) => caseStatus(c, r)); if (st.includes('regressed')) return 'regressed'; if (st.includes('below')) return 'below'; if (st.includes('noisy')) return 'noisy'; if (a.overallScore === null || a.overallScore === undefined) return 'none'; return st.includes('warn') ? 'warn' : 'pass'; };
const latestStatus = latest ? runStatus(latest) : 'none';
const versions = [...new Set(runs.map((r) => r.cc).filter(Boolean))];
const modelsSeen = [...new Set(runs.flatMap((r) => r.models))];

// ---- verdict ----
let tone, mark, headline, lede;
if (!latest) { tone = 'muted'; mark = '○'; headline = 'No runs yet'; lede = 'Push a change to the setup, or run the workflow manually, to record the first baseline.'; }
else if (latestStatus === 'errored') { tone = 'fail'; mark = '■'; headline = 'Latest run errored'; lede = `${latest.json.aggregates?.partialReason ?? 'Agent runs errored.'} Usually an exhausted API key. Nothing was stored.`; }
else if (latestStatus === 'regressed') { tone = 'fail'; mark = '▼'; headline = `${latest.track === 'canary' ? 'Canary' : 'Latest run'} regressed`; lede = `${latest.track === 'canary' ? `On ${latest.models.join(', ') || 'the alias'} with Claude Code ${latest.cc ?? '?'}, ` : ''}${latest.json.cases.filter((c) => caseStatus(c, latest) === 'regressed').map(key).join(', ')} dropped below the baseline by more than ${TH}. ${latest.track === 'canary' ? 'The pinned baseline is untouched; do not bump the pins.' : 'Open the report for each failing run.'}`; }
else if (latestStatus === 'below') { tone = 'warn'; mark = '◆'; headline = 'Below 1.00, within threshold'; lede = 'Some cases are not at 1.00 but none dropped by more than the threshold. Watch the ribbon for a trend.'; }
else if (latestStatus === 'noisy') { tone = 'warn'; mark = '◆'; headline = `${latest.track === 'canary' ? 'Canary' : 'Latest run'} noisy — within the historical band`; lede = `${latest.json.cases.filter((c) => caseStatus(c, latest) === 'noisy').map(key).join(', ')} dropped past ${TH} but stayed inside its noise band (the spread of its own past runs) — a warning, not a regression. More runs per case shrink the band.`; }
else if (latest.track !== 'canary' && latestCanary && ['regressed', 'errored'].includes(runStatus(latestCanary))) { tone = 'warn'; mark = '◆'; headline = 'Baseline holding · canary red'; lede = `The pinned track passes, but the latest canary (${latestCanary.models.join(', ') || 'alias'} on Claude Code ${latestCanary.cc ?? '?'}, ${when(latestCanary.at)}) ${runStatus(latestCanary) === 'errored' ? 'errored' : `regressed on ${latestCanary.json.cases.filter((c) => caseStatus(c, latestCanary) === 'regressed').map(key).join(', ')}`}. That is what your developers get on the alias today — do not bump the pins; read the canary report.`; }
else { tone = 'pass'; mark = '●'; headline = latest.track === 'canary' ? 'Canary green · baseline holding' : 'Holding at baseline'; lede = `${caseNames.length} case${caseNames.length === 1 ? '' : 's'} across ${runs.length} run${runs.length === 1 ? '' : 's'} and ${versions.length} Claude Code version${versions.length === 1 ? '' : 's'}${modelsSeen.length > 1 ? ` and ${modelsSeen.length} models` : ''}. ${streak?.greens ? `The canary is ${streak.greens} green${streak.greens === 1 ? '' : 's'} into a streak of ${cfg?.promoteAfter ?? 2}.` : latestCanary ? 'Latest canary agrees with the pinned baseline.' : 'No canary run yet.'}`; }

// ---- stamp ----
const month = new Date().toISOString().slice(0, 7);
const spentMonth = spend?.months?.[month]?.usd ?? null, runsMonth = spend?.months?.[month]?.runs ?? null;
const cap = cfg?.capMonth ?? null;
const stamp = [
  ['latest', latest ? `<b>${esc(when(latest.at))}</b> <span class="from">${esc(latest.track ?? '')}</span>` : '—'],
  ['baseline', base ? `<b>${esc([...new Set((base.cases ?? []).flatMap((c) => (c.arms?.with ?? []).map((r) => r.model)).filter(Boolean))].join(', ') || '?')}</b> <span class="from">cc ${esc(base.harness?.version ?? cfg?.pinnedHarness ?? '?')} · ${esc(String(base.generatedAt ?? '').slice(0, 10))}</span>` : '<span class="from">none yet</span>'],
  ['canary', latestCanary ? `<b>${esc(latestCanary.models.join(', ') || cfg?.canaryAlias || 'alias')}</b> <span class="from">cc ${esc(latestCanary.cc ?? '?')} · ${esc(when(latestCanary.at))}</span>${streak ? ` <span class="from">· ${streak.greens} / ${cfg?.promoteAfter ?? 2} greens</span>` : ''}` : `<span class="from">${cfg ? `${esc(cfg.canaryAlias)} on latest, no run yet` : 'no run yet'}</span>`],
  ['claude code', `<b>${esc(latest?.cc ?? '—')}</b> <span class="from">${versions.length} seen</span>`],
  ['budget', spentMonth !== null || cap ? `<b>$${(spentMonth ?? 0).toFixed(2)}</b>${cap ? ` <span class="from">of $${cap} this month</span>` : ''}${runsMonth !== null ? ` <span class="from">· ${runsMonth} run${runsMonth === 1 ? '' : 's'}</span>` : ''}${cap ? `<span class="meter"><i style="width:${Math.min(100, Math.round(((spentMonth ?? 0) / cap) * 100))}%" class="${(spentMonth ?? 0) / cap > 0.85 ? 'fail' : (spentMonth ?? 0) / cap > 0.6 ? 'warn' : ''}"></i></span>` : ''}` : `<span class="from">no ledger</span>`],
  ['coverage', coverage ? `<b class="${coverage.pct === null ? '' : coverage.pct >= 80 ? 'pass' : coverage.pct >= 50 ? 'warn' : 'fail'}">${coverage.pct === null ? '—' : coverage.pct + '%'}</b> <span class="from">${coverage.covered} of ${coverage.total} rules have a case</span>` : '<span class="from">—</span>'],
  ['total cost', `<b>$${totalCost.toFixed(2)}</b> <span class="from">${runs.length} run${runs.length === 1 ? '' : 's'}</span>`],
];

// ---- ribbon: one row per case, one cell per run ----
const ribbon = caseNames.map((nm) => {
  const cells = runs.map((r) => { const c = r.json.cases.find((x) => key(x) === nm); const st = caseStatus(c, r); const s = c?.summary?.score; return `<a class="cell ${st} ${r.track === 'canary' ? 'canary' : ''}" href="${r.report ? esc(r.report) : '#'}" title="${esc(nm)} · ${esc(when(r.at))} · ${r.track ?? 'run'} · cc ${esc(r.cc ?? '?')} · ${esc(r.models.join(', '))} · ${f2(s)}"></a>`; }).join('');
  const c = latest?.json.cases.find((x) => key(x) === nm); const b = base?.cases.find((x) => key(x) === nm); const s = c?.summary?.score ?? null; const d = b && s !== null ? s - (b.summary?.score ?? 0) : null;
  return `<div class="rrow"><div class="rname"><a href="#" title="${esc(c?.description ?? '')}">${esc(nm)}</a></div><div class="cells">${cells}</div><div class="rval ${d !== null && d < -TH ? 'fail' : d !== null && d > TH ? 'pass' : ''}">${f2(s)}${d !== null && Math.abs(d) > 0.005 ? `<small>${d >= 0 ? '+' : ''}${d.toFixed(2)}</small>` : ''}</div></div>`;
}).join('');
const ribbonAxis = runs.length ? `<div class="raxis"><span>${esc(when(runs[0].at).slice(0, 10))}</span><span>${runs.length} run${runs.length === 1 ? '' : 's'} · ■ pinned · ▢ canary</span><span>${esc(when(latest.at).slice(0, 10))}</span></div>` : '';

// ---- chart (SVG, one line per case; legend wraps below so long names are never clipped) ----
const PAL = ['#2E5BD7', '#D9622B', '#1E9A6A', '#C58A00', '#6B4FD8', '#C9407A', '#0E8A8A', '#8A5A1A'];
const W = 900, H = 280, L = 44, R = 16, T = 16, B = 42, n = Math.max(runs.length, 1);
const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
const y = (v) => T + (1 - v) * (H - T - B);
const series = caseNames.map((nm) => ({ name: nm, points: runs.map((r, i) => { const c = r.json.cases.find((c) => key(c) === nm); return { i, score: c?.summary?.score ?? null }; }) }));
const ticks = runs.map((r, i) => ({ i, label: r.cc ?? String(r.at).slice(5, 10) })).filter((t, i, arr) => i === 0 || t.label !== arr[i - 1].label || n <= 8);
// thin the x labels so neighbours never overlap: keep a label only ≥56px from the previous kept one;
// the newest version always stays labelled (its colliding predecessor is dropped instead)
const minTickPx = 56;
const shownTicks = [];
for (const t of ticks) if (!shownTicks.length || x(t.i) - x(shownTicks.at(-1).i) >= minTickPx) shownTicks.push(t);
const lastTick = ticks.at(-1);
if (lastTick && shownTicks.at(-1) !== lastTick) {
  if (shownTicks.length > 1 && x(lastTick.i) - x(shownTicks.at(-1).i) < minTickPx) shownTicks.pop();
  shownTicks.push(lastTick);
}
const paths = series.map((s, si) => ({ si, name: s.name, pts: s.points.filter((p) => p.score !== null) }));
for (const p of paths) p.d = p.pts.map((p2, k) => `${k ? 'L' : 'M'}${x(p2.i).toFixed(1)},${y(p2.score).toFixed(1)}`).join(' ');
const canaryBands = runs.map((r, i) => (r.track === 'canary' ? `<rect x="${(x(i) - 6).toFixed(1)}" y="${T}" width="12" height="${H - T - B}" class="band"/>` : '')).join('');
const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score per case over runs">
  ${canaryBands}
  ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v.toFixed(2)}</text>`).join('')}
  ${shownTicks.map((t, ti) => ti === shownTicks.length - 1 ? `<text x="${x(t.i)}" y="${H - B + 18}" class="tick" text-anchor="end">${esc(t.label)}</text>` : `<text x="${x(t.i)}" y="${H - B + 18}" class="tick" text-anchor="middle">${esc(t.label)}</text>`).join('')}
  <text x="${L}" y="${H - 6}" class="tick">x = Claude Code version${runs.some((r) => !r.cc) ? ' or date' : ''} · shaded = canary</text>
  ${paths.map((p) => `<path d="${p.d}" class="line" style="stroke:${PAL[p.si % 8]}"/>${p.pts.map((pt) => `<circle cx="${x(pt.i)}" cy="${y(pt.score)}" r="4" class="pt" style="fill:${PAL[p.si % 8]}"><title>${esc(p.name)} · ${esc(runs[pt.i].cc ?? runs[pt.i].at)} · ${pt.score.toFixed(2)}</title></circle>`).join('')}`).join('')}
</svg>`;
const legend = `<div class="legend">${paths.map((p) => `<span class="lg"><i style="background:${PAL[p.si % 8]}"></i>${esc(p.name)}</span>`).join('')}</div>`;

// ---- runs table ----
const runRows = [...runs].reverse().map((r) => { const st = runStatus(r); const a = r.json.aggregates ?? {}; return `<tr class="st-${st}"><td><span class="dot ${st}"></span>${st}</td><td class="mono">${esc(when(r.at))}</td><td><span class="trk ${r.track ?? ''}">${esc(r.track ?? '—')}</span></td><td class="mono">${esc(r.cc ?? '—')}</td><td class="mono small">${esc(r.models.join(', ') || '—')}</td><td class="num">${f2(a.overallScore)}</td>${caseNames.map((nm) => { const c = r.json.cases.find((x) => key(x) === nm); return `<td class="num case ${caseStatus(c, r)}">${f2(c?.summary?.score)}</td>`; }).join('')}<td class="num">$${(a.costUsd ?? 0).toFixed(2)}</td><td>${r.report ? `<a href="${esc(r.report)}">report</a>` : ''}</td></tr>`; }).join('');

const css = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
.mono,.num,.tick,.stamp,.rval,.raxis{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:inherit;text-decoration:none}a:hover{color:var(--track)}.wrap{max-width:1140px;margin:0 auto;padding:28px 28px 90px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.track{color:var(--track)}.muted{color:var(--muted)}
.verdict{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(320px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;display:flex;gap:14px;align-items:baseline}h1 .mark{font-size:26px}h1.pass .mark{color:var(--pass)}h1.fail .mark{color:var(--fail)}h1.warn .mark{color:var(--warn)}h1.muted .mark{color:var(--muted)}
.lede{font-size:16px;color:var(--muted);margin:0;max-width:58ch}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:12.5px;box-shadow:var(--shadow);position:relative}.stamp::before{content:"";position:absolute;inset:6px;border:1px dashed var(--rule);border-radius:5px;pointer-events:none}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0}.stamp b{font-weight:600}.from{color:var(--muted)}
.meter{display:block;width:100%;max-width:220px;height:6px;background:var(--code);border-radius:3px;margin-top:5px;overflow:hidden}.meter i{display:block;height:100%;background:var(--pass)}.meter i.warn{background:var(--warn)}.meter i.fail{background:var(--fail)}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.panel{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;box-shadow:var(--shadow)}
.rrow{display:grid;grid-template-columns:minmax(160px,260px) 1fr 72px;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--rule)}.rrow:last-of-type{border-bottom:0}.rname{font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cells{display:flex;gap:4px;flex-wrap:wrap}.cell{width:18px;height:26px;border-radius:4px;background:var(--code);display:block;border:2px solid transparent}.cell.pass{background:var(--pass)}.cell.warn{background:var(--warn)}.cell.noisy{background:var(--warn);opacity:.75}.cell.regressed,.cell.errored{background:var(--fail)}.cell.below{background:var(--warn);opacity:.7}.cell.none{background:var(--code)}
.cell.canary{background:transparent;border-color:var(--code)}.cell.canary.pass{border-color:var(--pass)}.cell.canary.warn,.cell.canary.below,.cell.canary.noisy{border-color:var(--warn)}.cell.canary.regressed,.cell.canary.errored{border-color:var(--fail)}.cell:hover{outline:2px solid var(--track);outline-offset:1px}
.rval{text-align:right;font-size:14px;font-weight:600}.rval small{display:block;font-weight:400;font-size:11px;color:var(--muted)}.rval.fail small{color:var(--fail)}.rval.pass small{color:var(--pass)}
.raxis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:8px}
.chart{width:100%;height:auto;display:block}.grid{stroke:var(--rule)}.band{fill:var(--track-bg)}.tick{fill:var(--muted);font-size:11px}.line{stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}.pt{stroke:var(--surface);stroke-width:2}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px}.lg{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600}.lg i{width:10px;height:10px;border-radius:3px;flex:none}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}table{border-collapse:collapse;width:100%;font-size:13.5px}th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;padding:9px 10px;border-bottom:1px solid var(--rule);white-space:nowrap;font-weight:600}td{padding:8px 10px;border-bottom:1px solid var(--rule)}tr:last-child td{border-bottom:0}td.num{text-align:right}td.mono{font-size:12.5px;white-space:nowrap}td.small{font-size:11.5px;color:var(--muted);white-space:nowrap}td.num{white-space:nowrap}td.num.regressed,td.num.errored{color:var(--fail);font-weight:600}td.num.below,td.num.warn,td.num.noisy{color:var(--warn)}
th.case{writing-mode:vertical-rl;transform:rotate(180deg);text-align:left;vertical-align:bottom;max-height:140px;overflow:hidden;text-overflow:ellipsis;padding:10px 4px;white-space:nowrap}td.case{text-align:center}
.trk{font-size:11px;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:4px;background:var(--code);color:var(--muted)}.trk.canary{background:var(--track-bg);color:var(--track)}.trk.pinned{background:var(--code);color:var(--ink)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.pass{background:var(--pass)}.dot.warn,.dot.below,.dot.noisy{background:var(--warn)}.dot.regressed,.dot.errored{background:var(--fail)}tr.st-regressed td,tr.st-errored td{background:var(--fail-bg)}
.foot{color:var(--muted);font-size:12px;margin-top:22px}:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.rrow{grid-template-columns:1fr}.rval{text-align:left}.wrap{padding:20px 16px 60px}}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(suite)} · drift index</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"><style>${css}</style></head><body><div class="wrap">
<header class="verdict">
  <div><p class="eyebrow">config-drift-checker · <b>${esc(suite)}</b> · drift index</p>
    <h1 class="${tone}"><span class="mark">${mark}</span><span>${esc(headline)}</span></h1>
    <p class="lede">${esc(lede)}</p></div>
  <dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
<h2>Every case, every run</h2>
<div class="panel">${ribbon || '<p class="muted">No runs yet.</p>'}${ribbonAxis}</div>
${runs.length > 1 ? `<h2>Score per case over Claude Code versions</h2><div class="panel">${svg}${legend}</div>` : ''}
<h2>Runs</h2>
<div class="tablewrap"><table><thead><tr><th>status</th><th>when</th><th>track</th><th>claude code</th><th>model</th><th>overall</th>${caseNames.map((nm) => `<th class="case" title="${esc(nm)}">${esc(nm)}</th>`).join('')}<th>cost</th><th></th></tr></thead><tbody>${runRows}</tbody></table></div>
<p class="foot">Scores are the mean over a case's runs with the setup loaded; a drop of more than ${TH} against the pinned baseline is a regression — a drop inside the case's own noise band (the spread of its past runs) is a ⚠ noisy warning, shown amber. Filled cells are pinned-track runs, outlined cells are canaries on the alias model and latest Claude Code. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a>; every run's report lists each grader's reason.</p>
</div></body></html>`;
await fs.writeFile(outPath, html); console.log(outPath);
