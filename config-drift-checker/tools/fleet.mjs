#!/usr/bin/env node
// fleet — one dashboard and one pin policy across many repos running config-drift-checker.
//
//   node tools/fleet.mjs --config fleet.yml [--out fleet.html] [--md fleet.md]
//   node tools/fleet.mjs --repos org/a,org/b --policy-model claude-sonnet-5 --policy-harness 2.1.258
//
// Each repo's data comes from its own eval-results branch (docs/latest.json, baseline.json,
// spend.json, coverage.json) over raw.githubusercontent.com, so the fleet view needs no access
// beyond public reads (private repos: run where `gh` is authenticated and pass --gh).
// fleet.yml:
//   policy:
//     model: claude-sonnet-5      # the pin every repo should be on (optional)
//     harness: "2.1.258"
//   repos:
//     - org/service-a
//     - org/service-b
// A repo whose pins differ from the policy is flagged as skew: that is the fleet-wide bump
// conversation, made visible. --from-dir <dir> reads <dir>/<owner__repo>/<file> instead of the
// network (tests, air-gapped mirrors).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function parseFleetConfig(text) {
  const repos = [...text.matchAll(/^\s*-\s*([\w.-]+\/[\w.-]+)\s*$/gm)].map((m) => m[1]);
  const pol = (k) => (text.match(new RegExp(`^\\s*${k}:\\s*"?([^"\\n#]+)"?\\s*(#.*)?$`, 'm')) ?? [])[1]?.trim() ?? null;
  return { repos, policy: { model: pol('model'), harness: pol('harness') } };
}

const FILES = ['latest.json', 'baseline.json', 'spend.json', 'coverage.json'];

export async function collectFleet(repos, load) {
  const out = [];
  for (const repo of repos) {
    const d = {};
    for (const f of FILES) d[f.replace('.json', '')] = await load(repo, f);
    const latest = d.latest, base = d.baseline;
    const agg = latest?.aggregates ?? {};
    const status = !latest ? 'no data'
      : (agg.erroredRuns ?? 0) > 0 ? 'errored'
      : agg.overallScore === null || agg.overallScore === undefined ? 'unknown'
      : agg.overallScore >= 1 ? 'green'
      : 'below 1.00';
    const month = new Date().toISOString().slice(0, 7);
    out.push({
      repo, status,
      overall: agg.overallScore ?? null,
      track: latest?.track ?? null,
      at: latest?.generatedAt ?? null,
      model: base?.config?.model ?? null, modelIsPinned: base?.config?.modelIsPinned ?? null,
      harness: base?.config?.harness ?? null,
      spentMonth: d.spend?.months?.[month]?.usd ?? null,
      coveragePct: d.coverage?.pct ?? null,
    });
  }
  return out;
}

export function skew(row, policy) {
  const s = [];
  if (policy?.model && row.model && row.model !== policy.model) s.push(`model ${row.model}`);
  if (policy?.harness && row.harness && String(row.harness) !== String(policy.harness)) s.push(`Claude Code ${row.harness}`);
  return s;
}

const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');

export function renderFleetMd(rows, policy) {
  const lines = [
    `## Fleet: ${rows.length} repo${rows.length === 1 ? '' : 's'} · ${rows.filter((r) => r.status === 'green').length} green · ${rows.filter((r) => skew(r, policy).length).length} off the pin policy${policy?.model || policy?.harness ? ` (${[policy.model, policy.harness && `cc ${policy.harness}`].filter(Boolean).join(', ')})` : ''}`,
    '', '| repo | status | overall | pins | policy skew | month spend | coverage | last run |', '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const sk = skew(r, policy);
    lines.push(`| ${r.repo} | ${r.status} | ${f2(r.overall)} | ${r.model ?? '—'}${r.modelIsPinned === false ? ' (alias)' : ''} · cc ${r.harness ?? '—'} | ${sk.length ? '⚠ ' + sk.join(', ') : '—'} | ${r.spentMonth === null ? '—' : '$' + r.spentMonth.toFixed(2)} | ${r.coveragePct === null ? '—' : r.coveragePct + '%'} | ${when(r.at)} |`);
  }
  return lines.join('\n');
}

export function renderFleetHtml(rows, policy, title = 'agent-config fleet') {
  const green = rows.filter((r) => r.status === 'green').length;
  const skewed = rows.filter((r) => skew(r, policy).length);
  const bad = rows.filter((r) => ['errored', 'no data'].includes(r.status)).length;
  const dot = (s) => s === 'green' ? 'pass' : s === 'below 1.00' ? 'warn' : 'fail';
  const trs = rows.map((r) => { const sk = skew(r, policy); return `<tr>
    <td><a href="https://github.com/${esc(r.repo)}">${esc(r.repo)}</a></td>
    <td class="${dot(r.status)}">● ${esc(r.status)}</td><td>${f2(r.overall)}${r.track ? ` <small>${esc(r.track)}</small>` : ''}</td>
    <td>${esc(r.model ?? '—')}${r.modelIsPinned === false ? ' <small>alias</small>' : ''} · cc ${esc(r.harness ?? '—')}</td>
    <td class="${sk.length ? 'warn' : ''}">${sk.length ? '⚠ ' + esc(sk.join(', ')) : '—'}</td>
    <td>${r.spentMonth === null ? '—' : '$' + r.spentMonth.toFixed(2)}</td>
    <td>${r.coveragePct === null ? '—' : r.coveragePct + '%'}</td>
    <td>${esc(when(r.at))}</td></tr>`; }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--paper:#F3F5F8;--surface:#FFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--pass:#1E7A4D;--fail:#C1382C;--warn:#A8701A}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--pass:#4CC286;--fail:#EE7A6C;--warn:#E0B052}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--pass:#4CC286;--fail:#EE7A6C;--warn:#E0B052}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:28px 16px}
.wrap{max-width:1100px;margin:0 auto}h1{font-size:26px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--rule);border-radius:8px;font-size:13.5px}
th,td{text-align:left;padding:8px 12px;border-top:1px solid var(--rule)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;border-top:0}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}small{color:var(--muted)}a{color:inherit}
@media (max-width:820px){body{padding:16px}} .tw{overflow-x:auto}
</style></head><body><div class="wrap">
<h1>${esc(title)}</h1>
<p class="sub">${rows.length} repo${rows.length === 1 ? '' : 's'} · <span class="pass">${green} green</span>${bad ? ` · <span class="fail">${bad} errored / no data</span>` : ''} · ${skewed.length ? `<span class="warn">${skewed.length} off the pin policy</span>` : 'all on the pin policy'}${policy?.model || policy?.harness ? ` (${esc([policy.model, policy.harness && `cc ${policy.harness}`].filter(Boolean).join(', '))})` : ''} · updated ${esc(when(new Date().toISOString()))}</p>
<div class="tw"><table><thead><tr><th>repo</th><th>status</th><th>overall</th><th>pins</th><th>policy skew</th><th>month spend</th><th>coverage</th><th>last run</th></tr></thead><tbody>
${trs}
</tbody></table></div>
</div></body></html>`;
}

// ---- loaders ----
const httpsLoader = (branch, useGh) => async (repo, file) => {
  try {
    if (useGh) {
      const r = spawnSync('gh', ['api', `repos/${repo}/contents/docs/${file}?ref=${branch}`, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8' });
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    }
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/docs/${file}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
};
const dirLoader = (root) => async (repo, file) => {
  try { return JSON.parse(await fs.readFile(path.join(root, repo.replace('/', '__'), file), 'utf8')); } catch { return null; }
};

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { config: null, repos: null, out: null, md: null, branch: 'eval-results', fromDir: null, gh: false, policyModel: null, policyHarness: null, title: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') opt.config = argv[++i]; else if (a === '--repos') opt.repos = argv[++i];
    else if (a === '--out') opt.out = argv[++i]; else if (a === '--md') opt.md = argv[++i];
    else if (a === '--branch') opt.branch = argv[++i]; else if (a === '--from-dir') opt.fromDir = argv[++i];
    else if (a === '--gh') opt.gh = true; else if (a === '--policy-model') opt.policyModel = argv[++i];
    else if (a === '--policy-harness') opt.policyHarness = argv[++i]; else if (a === '--title') opt.title = argv[++i];
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  let repos = [], policy = { model: opt.policyModel, harness: opt.policyHarness };
  if (opt.config) { const c = parseFleetConfig(await fs.readFile(opt.config, 'utf8')); repos = c.repos; policy = { model: opt.policyModel ?? c.policy.model, harness: opt.policyHarness ?? c.policy.harness }; }
  if (opt.repos) repos = opt.repos.split(',').map((s) => s.trim()).filter(Boolean);
  if (!repos.length) { console.error('usage: fleet.mjs --config fleet.yml | --repos org/a,org/b [--policy-model id] [--policy-harness v] [--out fleet.html] [--md fleet.md] [--from-dir d] [--gh]'); process.exit(2); }
  const rows = await collectFleet(repos, opt.fromDir ? dirLoader(path.resolve(opt.fromDir)) : httpsLoader(opt.branch, opt.gh));
  const md = renderFleetMd(rows, policy);
  console.log(md);
  if (opt.md) await fs.writeFile(opt.md, md + '\n');
  if (opt.out) { await fs.writeFile(opt.out, renderFleetHtml(rows, policy, opt.title ?? 'agent-config fleet')); console.error(`→ ${opt.out}`); }
  process.exit(rows.some((r) => ['errored', 'no data'].includes(r.status)) ? 1 : 0);
}
