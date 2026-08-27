#!/usr/bin/env node
// eval-dashboard — a static dashboard from a results history: score per case over runs (and Claude Code
// versions), the run list with cost, and links to each run's report. No server; one HTML file.
//
//   node tools/eval-dashboard.mjs <history-dir> [--baseline baseline.json] [--reports <dir>] [--out dashboard.html] [--title <name>]
//
// <history-dir> holds aggregate-result.json files (any names; the Action names them <stamp>-cc<version>-<runner>.json)
// or subdirectories each containing aggregate-result.json (local evals/results/). If --reports is given, a run's
// report is linked as <reports>/<basename>.html when that file exists.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2); let dir = null, baselinePath = null, reportsDir = null, out = null, title = null;
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--baseline') baselinePath = argv[++i]; else if (a === '--reports') reportsDir = argv[++i]; else if (a === '--out') out = argv[++i]; else if (a === '--title') title = argv[++i]; else if (!a.startsWith('--')) dir = a; }
if (!dir) { console.error('usage: eval-dashboard.mjs <history-dir> [--baseline b.json] [--reports dir] [--out dashboard.html]'); process.exit(2); }

const outPath = out ?? path.join(path.resolve(dir), 'dashboard.html');
const relReports = reportsDir ? path.relative(path.dirname(path.resolve(outPath)), path.resolve(reportsDir)) : '';
const runs = [];
for (const e of await fs.readdir(dir, { withFileTypes: true })) {
  let f = null, id = e.name;
  if (e.isFile() && e.name.endsWith('.json')) f = path.join(dir, e.name), id = e.name.replace(/\.json$/, '');
  else if (e.isDirectory() && existsSync(path.join(dir, e.name, 'aggregate-result.json'))) f = path.join(dir, e.name, 'aggregate-result.json');
  if (!f) continue;
  try { const j = JSON.parse(await fs.readFile(f, 'utf8')); if (!j.cases) continue; const m = id.match(/cc([\d.]+)/); runs.push({ id, at: j.generatedAt ?? id, ccVersion: m ? m[1] : null, runner: j.shim ? 'shim' : 'official', json: j, report: reportsDir && existsSync(path.join(reportsDir, id + '.html')) ? (relReports ? relReports + '/' : '') + id + '.html' : null }); } catch {}
}
runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const base = baselinePath && existsSync(baselinePath) ? JSON.parse(await fs.readFile(baselinePath, 'utf8')) : null;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const key = (c) => c.dir ?? c.name;
const caseNames = [...new Set(runs.flatMap((r) => r.json.cases.map(key)))];
const series = caseNames.map((n) => ({ name: n, points: runs.map((r, i) => { const c = r.json.cases.find((x) => key(x) === n); return { i, score: c?.summary?.score ?? null }; }) }));
const latest = runs.at(-1);
const suite = title ?? latest?.json.suite?.name ?? path.basename(path.resolve(dir));
const totalCost = runs.reduce((s, r) => s + (r.json.aggregates?.costUsd ?? 0), 0);
const statusOf = (r) => { const a = r.json.aggregates ?? {}; if (a.erroredRuns) return 'errored'; if (base) { const reg = r.json.cases.some((c) => { const b = base.cases.find((x) => key(x) === key(c)); return b && c.summary?.score !== null && (c.summary.score - (b.summary?.score ?? 0)) < -0.15; }); if (reg) return 'regressed'; } return a.overallScore === 1 ? 'pass' : a.overallScore === null || a.overallScore === undefined ? 'none' : 'below'; };
const latestStatus = latest ? statusOf(latest) : 'none';
const f2 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));

// ---- chart (SVG, one line per case, fixed categorical order, direct labels + legend) ----
const PAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#4a3aa7', '#e87ba4', '#008300', '#e34948'];
const PALD = ['#3987e5', '#d95926', '#199e70', '#c98500', '#9085e9', '#d55181', '#008300', '#e66767'];
const W = 900, H = 300, L = 44, R = 150, T = 18, B = 44, n = Math.max(runs.length, 1);
const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
const y = (v) => T + (1 - v) * (H - T - B);
const versionTicks = runs.map((r, i) => ({ i, label: r.ccVersion ? r.ccVersion : String(r.at).slice(5, 10) })).filter((t, i, arr) => i === 0 || t.label !== arr[i - 1].label || n <= 8);
const paths = series.map((s, si) => { const pts = s.points.filter((p) => p.score !== null); const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' '); const last = pts.at(-1); return { si, d, pts, last, name: s.name }; });
// stack end labels so they don't collide
const labels = paths.filter((p) => p.last).map((p) => ({ p, yy: y(p.last.score) })).sort((a, b) => a.yy - b.yy);
for (let k = 1; k < labels.length; k++) if (labels[k].yy - labels[k - 1].yy < 14) labels[k].yy = labels[k - 1].yy + 14;
const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score per case over runs">
  ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v.toFixed(2)}</text>`).join('')}
  ${versionTicks.map((t) => `<text x="${x(t.i)}" y="${H - B + 18}" class="tick" text-anchor="middle">${esc(t.label)}</text>`).join('')}
  <text x="${L}" y="${H - 6}" class="tick">${runs.length} run${runs.length === 1 ? '' : 's'} · x = Claude Code version${runs.some((r) => !r.ccVersion) ? ' or date' : ''}</text>
  ${paths.map((p) => `<path d="${p.d}" class="line s${p.si}" fill="none"/>${p.pts.map((pt) => `<circle cx="${x(pt.i)}" cy="${y(pt.score)}" r="4" class="pt s${p.si}"><title>${esc(p.name)} · ${esc(runs[pt.i].ccVersion ?? runs[pt.i].at)} · ${pt.score.toFixed(2)}</title></circle>`).join('')}`).join('')}
  ${labels.map(({ p, yy }) => `<text x="${W - R + 10}" y="${yy + 4}" class="lbl s${p.si}">${esc(p.name.length > 22 ? p.name.slice(0, 21) + '…' : p.name)}</text>`).join('')}
</svg>`;
const legend = `<div class="legend">${series.map((s, si) => `<span><i class="sw s${si}"></i>${esc(s.name)}</span>`).join('')}</div>`;

// ---- tables ----
const runRows = [...runs].reverse().map((r) => { const st = statusOf(r); const a = r.json.aggregates ?? {}; return `<tr class="st-${st}"><td><span class="dot ${st}"></span>${st}</td><td class="mono">${esc(String(r.at).slice(0, 16).replace('T', ' '))}</td><td class="mono">${esc(r.ccVersion ?? '—')}</td><td>${esc(r.runner)}</td><td class="num">${f2(a.overallScore)}</td>${caseNames.map((nm) => { const c = r.json.cases.find((x) => key(x) === nm); return `<td class="num">${f2(c?.summary?.score)}</td>`; }).join('')}<td class="num">$${(a.costUsd ?? 0).toFixed(2)}</td><td>${r.report ? `<a href="${esc(r.report)}">report</a>` : ''}</td></tr>`; }).join('');
const caseCards = caseNames.map((nm, si) => { const c = latest?.json.cases.find((x) => key(x) === nm); const b = base?.cases.find((x) => key(x) === nm); const s = c?.summary?.score ?? null; const d = b && s !== null ? s - (b.summary?.score ?? 0) : null; const pts = series[si].points.filter((p) => p.score !== null); const spark = pts.length > 1 ? `<svg viewBox="0 0 120 28" class="spark"><path d="${pts.map((p, k) => `${k ? 'L' : 'M'}${(k * 116 / (pts.length - 1) + 2).toFixed(1)},${(26 - p.score * 24).toFixed(1)}`).join(' ')}" class="s${si}" fill="none"/></svg>` : ''; return `<div class="card"><div class="card-h"><i class="sw s${si}"></i>${esc(nm)}</div><div class="card-v">${f2(s)}${d !== null ? `<small class="${d < -0.15 ? 'bad' : d > 0.15 ? 'good' : ''}">${d >= 0 ? '+' : ''}${d.toFixed(2)} vs baseline</small>` : ''}</div>${spark}${c?.description ? `<p class="card-d">${esc(c.description)}</p>` : ''}</div>`; }).join('');

const css = `
:root{--bg:#F4F6F8;--surface:#FFFFFF;--ink:#1A222D;--muted:#5B6672;--rule:#D6DCE3;--accent:#B85C1E;--pass:#2E7D4F;--fail:#B3362B;--warn:#8A6D1F;--pass-bg:#E6F2EA;--fail-bg:#F8E5E2;--code:#EDF0F3;--c0:${PAL[0]};--c1:${PAL[1]};--c2:${PAL[2]};--c3:${PAL[3]};--c4:${PAL[4]};--c5:${PAL[5]};--c6:${PAL[6]};--c7:${PAL[7]}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141922;--surface:#1B222D;--ink:#E6EAEF;--muted:#98A3B0;--rule:#2C3541;--accent:#E0823C;--pass:#5DBB84;--fail:#E06A5E;--warn:#D9B45A;--pass-bg:#1B2E23;--fail-bg:#3A1F1C;--code:#0F141B;--c0:${PALD[0]};--c1:${PALD[1]};--c2:${PALD[2]};--c3:${PALD[3]};--c4:${PALD[4]};--c5:${PALD[5]};--c6:${PALD[6]};--c7:${PALD[7]}}}
:root[data-theme="dark"]{--bg:#141922;--surface:#1B222D;--ink:#E6EAEF;--muted:#98A3B0;--rule:#2C3541;--accent:#E0823C;--pass:#5DBB84;--fail:#E06A5E;--warn:#D9B45A;--pass-bg:#1B2E23;--fail-bg:#3A1F1C;--code:#0F141B;--c0:${PALD[0]};--c1:${PALD[1]};--c2:${PALD[2]};--c3:${PALD[3]};--c4:${PALD[4]};--c5:${PALD[5]};--c6:${PALD[6]};--c7:${PALD[7]}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Familjen Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:24px 28px 80px}
.top{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin-bottom:6px}h1{font-size:24px;margin:0;letter-spacing:-.01em}h1 small{font-weight:500;color:var(--muted);font-size:12.5px;margin-left:10px;letter-spacing:.05em;text-transform:uppercase}
.status{display:inline-flex;align-items:center;gap:8px;font-weight:600;padding:4px 10px;border-radius:4px;font-size:14px}.status.pass{background:var(--pass-bg);color:var(--pass)}.status.regressed,.status.errored,.status.below{background:var(--fail-bg);color:var(--fail)}.status.none{background:var(--code);color:var(--muted)}
.strip{display:flex;gap:26px;flex-wrap:wrap;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--muted);margin:8px 0 22px}.strip b{color:var(--ink);font-weight:500}
h2{font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.card{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:12px 14px}.card-h{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:7px}.card-v{font-family:"JetBrains Mono",monospace;font-size:26px;font-weight:600;margin:4px 0 2px}.card-v small{font-family:"Familjen Grotesk",sans-serif;font-size:12px;color:var(--muted);margin-left:8px;font-weight:500}.card-v small.bad{color:var(--fail)}.card-v small.good{color:var(--pass)}.card-d{font-size:12.5px;color:var(--muted);margin:6px 0 0;line-height:1.4}
.spark{width:120px;height:28px;display:block}.spark path{stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.panel{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:14px 16px}
.chart{width:100%;height:auto;display:block}.grid{stroke:var(--rule);stroke-width:1}.tick{fill:var(--muted);font-size:11px;font-family:"JetBrains Mono",monospace}.line{stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.pt{stroke:var(--surface);stroke-width:2}.lbl{font-size:12px;font-weight:600}
.s0{stroke:var(--c0);fill:var(--c0)}.s1{stroke:var(--c1);fill:var(--c1)}.s2{stroke:var(--c2);fill:var(--c2)}.s3{stroke:var(--c3);fill:var(--c3)}.s4{stroke:var(--c4);fill:var(--c4)}.s5{stroke:var(--c5);fill:var(--c5)}.s6{stroke:var(--c6);fill:var(--c6)}.s7{stroke:var(--c7);fill:var(--c7)}
.line.s0,.line.s1,.line.s2,.line.s3,.line.s4,.line.s5,.line.s6,.line.s7{fill:none}.lbl.s0,.lbl.s1,.lbl.s2,.lbl.s3,.lbl.s4,.lbl.s5,.lbl.s6,.lbl.s7{stroke:none;fill:var(--ink)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink);margin-top:10px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface)}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13.5px}th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left;padding:9px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}td{padding:8px 10px;border-bottom:1px solid var(--rule)}tr:last-child td{border-bottom:0}td.num{text-align:right;font-family:"JetBrains Mono",monospace}td.mono{font-family:"JetBrains Mono",monospace;font-size:12.5px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.pass{background:var(--pass)}.dot.regressed,.dot.errored,.dot.below{background:var(--fail)}tr.st-regressed td,tr.st-errored td{background:var(--fail-bg)}
.foot{color:var(--muted);font-size:12px;margin-top:20px}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(suite)} · config drift dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"><style>${css}</style></head><body><div class="wrap">
<div class="top"><h1>${esc(suite)}<small>config drift dashboard</small></h1><span class="status ${latestStatus}"><span class="dot ${latestStatus}"></span>${latestStatus === 'pass' ? 'all cases at baseline' : latestStatus === 'regressed' ? 'regression in latest run' : latestStatus === 'errored' ? 'latest run errored' : latestStatus === 'below' ? 'below 1.00' : 'no runs yet'}</span></div>
<div class="strip"><span>latest <b>${esc(latest ? String(latest.at).slice(0, 16).replace('T', ' ') : '—')}</b></span><span>claude code <b>${esc(latest?.ccVersion ?? '—')}</b></span><span>runs <b>${runs.length}</b></span><span>versions seen <b>${new Set(runs.map((r) => r.ccVersion).filter(Boolean)).size}</b></span><span>total cost <b>$${totalCost.toFixed(2)}</b></span>${base ? `<span>baseline <b>${esc(String(base.generatedAt ?? '').slice(0, 10))}</b></span>` : ''}</div>
<h2>Cases, latest run</h2><div class="cards">${caseCards}</div>
<h2>Score per case over runs</h2><div class="panel">${svg}${series.length > 1 ? legend : ''}</div>
<h2>Runs</h2><div class="tablewrap"><table><thead><tr><th>status</th><th>when</th><th>claude code</th><th>runner</th><th>overall</th>${caseNames.map((nm) => `<th>${esc(nm)}</th>`).join('')}<th>cost</th><th></th></tr></thead><tbody>${runRows}</tbody></table></div>
<p class="foot">Scores are the mean over a case's runs with the setup loaded; a drop of more than 0.15 against the baseline counts as a regression. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a> from the results history; every run's full report lists each grader's reason.</p>
</div></body></html>`;
await fs.writeFile(outPath, html); console.log(outPath);
