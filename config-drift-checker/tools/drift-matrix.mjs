#!/usr/bin/env node
// drift-matrix: which model and Claude Code version can my setup safely use?
//
//   node tools/drift-matrix.mjs <plugin> --models sonnet,haiku --versions 2.1.290,2.1.295 | --last 5
//        [--runs 1] [--case <glob>] [--tag <tag>] [--budget 5] [--reference <version>:<model>]
//        [--pass-score 1] [--runner auto|official|shim] [--out-dir <dir>] [--out matrix.html]
//        [--json matrix.json] [--md <file>|-] [--history <dir>] [--dry-run]
//   node tools/drift-matrix.mjs --from <dir> [--reference ...] [--out ...] [--json ...] [--md ...]
//
// Runs one suite on every cell of a grid, models × Claude Code versions. Each version is installed
// into a throwaway npm prefix (cc-release.mjs, shared with drift-bisect); each cell is a normal
// aggregate result (official runner when the release has one, the shim otherwise), stored as
// <out-dir>/cc<version>-<model>.json next to its report, a matrix.json and one self-contained page:
// rows are cases, column groups are versions, each cell colored against a reference cell (default:
// the pinned model on the pinned Claude Code from .cdc.yml), with a plain-English verdict per model.
//
// --last N takes the newest N releases and adds your pinned version as the reference column.
// --budget is the ceiling for the whole grid: no cell starts once it is spent, and those cells show
// as not run. --dry-run prints the grid and a cost estimate from past results, installs nothing and
// spends $0. --from re-renders a stored matrix dir (or any dir of results) without running anything.
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cmpV, SEMVER, lastVersions, publishedVersions, installRelease, runSuite, suiteView } from './cc-release.mjs';
import { key, classifyCase, normalizeResult } from './eval-classify.mjs';
import { loadConfig, resolveTrack } from './cdc-config.mjs';
import { renderReport } from './eval-report.mjs';

export const cellId = (version, model) => `cc${version}-${String(model).replace(/[^\w.-]+/g, '_')}`;
const mean = (xs) => { const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(2)}` : 'n/a');

// reference cell: an explicit "<version>:<model>" (either half alone is fine), else the .cdc.yml pins
// when they are in the grid, else the first model on the oldest version
export function pickReference(versions, models, { spec = null, pinnedVersion = null, pinnedModel = null } = {}) {
  let version = null, model = null;
  for (const part of String(spec ?? '').split(':').filter(Boolean)) if (SEMVER.test(part)) version = part; else model = part;
  version ??= versions.includes(pinnedVersion) ? pinnedVersion : versions[0];
  model ??= models.includes(pinnedModel) ? pinnedModel : models[0];
  return { version, model };
}

// consecutive members of `subset` within the ordered tested list, as "a to b" ranges
export function versionRanges(subset, ordered) {
  const out = []; let start = null, prev = null;
  for (const v of [...ordered, null]) {
    if (v !== null && subset.includes(v)) { start ??= v; prev = v; continue; }
    if (start !== null) out.push(start === prev ? start : `${start} to ${prev}`);
    start = null;
  }
  return out.join(', ');
}

const FAILING = new Set(['regressed', 'fail', 'errored', 'missing']);

// one case in one cell, against the reference cell's score for that case
function caseCell(nm, c, refCase, isRef, passScore, threshold) {
  if (!c) return { score: null, status: 'missing' };
  const runs = c.arms?.with ?? [];
  if (runs.length && runs.every((r) => r.isError)) return { score: null, status: 'errored' };
  const score = c.summary?.score ?? null;
  if (score === null) return { score, status: 'unknown' };
  const meets = score >= passScore - 1e-9;
  if (!isRef && typeof refCase?.summary?.score === 'number') {
    const { status, delta } = classifyCase(nm, refCase, c, null, threshold);
    if (status === 'regressed') return { score, delta, status };
    return { score, delta, status: meets ? (status === 'improved' ? 'improved' : 'pass') : 'below' };
  }
  // the reference itself, or no reference score to compare with: the pass score decides
  return { score, delta: null, status: meets ? 'pass' : isRef ? 'below' : 'fail' };
}

// cells: [{ version, model, state: ran|unrun|errored, reason?, runner?, json?, file?, report? }]
// → every grid cell classified, with its summary and verdict, plus one sentence per model
export function evaluateMatrix(cells, { versions, models, reference, passScore = 1, threshold = 0.15 }) {
  const at = (v, m) => cells.find((c) => c.version === v && c.model === m) ?? { version: v, model: m, state: 'unrun', reason: 'not run' };
  const grid = versions.flatMap((v) => models.map((m) => at(v, m)));
  const caseNames = [...new Set(grid.flatMap((c) => (c.state === 'ran' ? c.json?.cases ?? [] : []).map(key)))];
  const ref = at(reference.version, reference.model);
  const refUsable = ref.state === 'ran' && !((ref.json.aggregates?.totalRuns ?? 0) > 0 && ref.json.aggregates.erroredRuns === ref.json.aggregates.totalRuns);
  const refCases = refUsable ? new Map(ref.json.cases.map((c) => [key(c), c])) : new Map();
  const out = grid.map((c) => {
    const isRef = c.version === reference.version && c.model === reference.model;
    const base = { version: c.version, model: c.model, isRef, state: c.state, reason: c.reason ?? null, runner: c.runner ?? null, note: c.note ?? null, file: c.file ?? null, report: c.report ?? null };
    if (c.state !== 'ran') return { ...base, state: c.state === 'unrun' ? 'unrun' : 'errored', verdict: c.state === 'unrun' ? 'unrun' : 'errored', cases: {}, failing: [], passed: null, total: caseNames.length, costUsd: null, meanTurns: null, resolvedModels: [] };
    const j = c.json, a = j.aggregates ?? {};
    const withRuns = (j.cases ?? []).flatMap((x) => x.arms?.with ?? []);
    const stats = { costUsd: a.costUsd ?? null, meanTurns: mean(withRuns.filter((r) => !r.isError).map((r) => r.numTurns)), resolvedModels: [...new Set(withRuns.map((r) => r.model).filter(Boolean))] };
    if (a.totalRuns > 0 && a.erroredRuns === a.totalRuns) return { ...base, ...stats, state: 'errored', verdict: 'errored', reason: c.reason ?? a.partialReason ?? 'every run errored', cases: {}, failing: [], passed: 0, total: caseNames.length };
    const cmap = new Map((j.cases ?? []).map((x) => [key(x), x]));
    const cases = Object.fromEntries(caseNames.map((nm) => [nm, caseCell(nm, cmap.get(nm), refCases.get(nm), isRef, passScore, threshold)]));
    const failing = caseNames.filter((nm) => FAILING.has(cases[nm].status));
    const incomplete = caseNames.filter((nm) => cases[nm].status === 'unknown');
    return { ...base, ...stats, cases, failing, passed: caseNames.filter((nm) => ['pass', 'improved'].includes(cases[nm].status)).length, total: caseNames.length,
      verdict: failing.length ? 'fails' : incomplete.length ? 'incomplete' : 'safe' };
  });
  const verdicts = Object.fromEntries(models.map((m) => [m, verdictLine(m, out.filter((c) => c.model === m), versions)]));
  const refBelow = refUsable ? caseNames.filter((nm) => out.find((c) => c.isRef)?.cases[nm]?.status === 'below') : [];
  return { versions, models, reference, refUsable, refBelow, passScore, threshold, cases: caseNames, cells: out, verdicts };
}

// "haiku: safe on 2.1.290 to 2.1.295; fails spring-service-owns-rules-and-errors on 2.1.288"
export function verdictLine(model, cells, versions) {
  const on = (verdict) => versions.filter((v) => cells.find((c) => c.version === v)?.verdict === verdict);
  if (cells.every((c) => c.verdict === 'unrun')) return `${model}: not run`;
  const safe = on('safe'), parts = [safe.length ? `safe on ${versionRanges(safe, versions)}` : 'not safe on any tested version'];
  const byFail = new Map();
  for (const c of cells.filter((x) => x.verdict === 'fails')) { const k = andList(c.failing); byFail.set(k, [...(byFail.get(k) ?? []), c.version]); }
  for (const [what, vs] of byFail) parts.push(`fails ${what} on ${vs.join(', ')}`);
  if (on('errored').length) parts.push(`errored on ${on('errored').join(', ')}`);
  if (on('incomplete').length) parts.push(`incomplete on ${on('incomplete').join(', ')} (budget ran out mid-cell)`);
  if (on('unrun').length) parts.push(`not run on ${on('unrun').join(', ')}`);
  return `${model}: ${parts.join('; ')}`;
}

// ---------- running the grid ----------
// install(version) → { binDir, env?, cleanup } | null is injectable so tests drive a fake claude.
export async function runMatrix({ plugin, versions, models, reference, runs = 1, budget = 5, caseGlob = null, tag = null, runner = 'auto', judgeModel = null, outDir, install = installRelease, log = console.log }) {
  const view = await suiteView(plugin, { caseGlob, tag });
  if (!view.cases.length) { await view.cleanup(); throw new Error(`no eval cases match${caseGlob ? ` --case ${caseGlob}` : ''}${tag ? ` --tag ${tag}` : ''}`); }
  await fs.mkdir(outDir, { recursive: true });
  // the reference cell runs first, so every later cell has something to be compared with
  const vOrder = [reference.version, ...versions.filter((v) => v !== reference.version)];
  const mOrder = [reference.model, ...models.filter((m) => m !== reference.model)];
  const cells = []; let spent = 0;
  const unrun = (v, m) => cells.push({ version: v, model: m, state: 'unrun', reason: `budget $${budget} spent before this cell` });
  try {
    for (const v of vOrder) {
      if (spent >= budget) { mOrder.forEach((m) => unrun(v, m)); continue; }
      log(`· installing Claude Code ${v}`);
      const inst = await install(v);
      if (!inst) { mOrder.forEach((m) => cells.push({ version: v, model: m, state: 'errored', reason: `npm install of Claude Code ${v} failed` })); log('  install failed'); continue; }
      try {
        for (const m of mOrder) {
          if (spent >= budget) { unrun(v, m); continue; }
          const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-matrix-cell-'));
          const r = await runSuite({ plugin: view.dir, binDir: inst.binDir, env: inst.env ?? process.env, runner, model: m, judgeModel, runs,
            budget: Math.max(0.01, Number((budget - spent).toFixed(2))), expectCases: view.cases.length, outDir: tmp, version: v });
          const stem = cellId(v, m);
          if (!r.raw) cells.push({ version: v, model: m, state: 'errored', runner: r.runner, reason: r.note ?? 'the runner wrote no result' });
          else {
            spent += r.json.aggregates?.costUsd ?? 0;
            r.raw.matrix = { version: v, model: m, runner: r.runner, note: r.note };
            await fs.writeFile(path.join(outDir, `${stem}.json`), JSON.stringify(r.raw, null, 2));
            let report = null;
            try { await fs.writeFile(path.join(outDir, `${stem}.html`), renderReport(normalizeResult(r.raw))); report = `${stem}.html`; } catch { /* the page still links the json */ }
            cells.push({ version: v, model: m, state: 'ran', runner: r.runner, note: r.note, json: normalizeResult(r.raw), file: `${stem}.json`, report });
          }
          await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
          const a = r.json?.aggregates ?? {};
          log(`  ${m}: ${r.raw ? `overall ${a.overallScore == null ? 'n/a' : a.overallScore.toFixed(2)}, ${usd(a.costUsd ?? 0)}, ${r.runner} runner` : 'no result'}${r.note ? ` (${r.note})` : ''} · spent ${usd(spent)} of $${budget}`);
        }
      } finally { await inst.cleanup?.(); }
    }
  } finally { await view.cleanup(); }
  return { cells, spent, cases: view.cases };
}

// ---------- reading stored results ----------
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };
const SKIP = new Set(['matrix.json', 'verdicts.json', 'spend.json', 'streak.json', 'coverage.json']);

// every result in a dir: *.json files and <sub>/aggregate-result.json, two levels deep
export async function readResults(dir, depth = 2) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await readResults(p, depth - 1));
    else if (e.isFile() && e.name.endsWith('.json') && !SKIP.has(e.name)) {
      const raw = await readJson(p); if (!raw || !Array.isArray(raw.cases)) continue;
      out.push({ path: p, raw, json: normalizeResult(raw) });
    }
  }
  return out;
}

// a stored matrix dir (or any results dir) back into cells; matrix.json, when there, restores the grid,
// the reference and the cells that never ran
export async function loadMatrixDir(dir) {
  const manifest = await readJson(path.join(dir, 'matrix.json'));
  const byCell = new Map();
  for (const { path: p, raw, json } of await readResults(dir, 1)) {
    const version = raw.matrix?.version ?? json.harness?.version ?? path.basename(p).match(/cc(\d+\.\d+\.\d+)/)?.[1] ?? null;
    const resolved = [...new Set((json.cases ?? []).flatMap((c) => (c.arms?.with ?? []).map((r) => r.model)).filter(Boolean))];
    const model = raw.matrix?.model ?? (raw.config?.model && raw.config.model !== 'per-case' ? raw.config.model : resolved[0]) ?? null;
    if (!version || !model) continue;
    const rel = path.relative(dir, p);
    // a matrix cell's report sits next to it as <stem>.html; a results dir's as <run>/report.html
    const report = [rel.replace(/\.json$/, '.html'), path.join(path.dirname(rel), 'report.html')].find((r) => existsSync(path.join(dir, r))) ?? null;
    const cell = { version, model, state: 'ran', runner: raw.matrix?.runner ?? (raw.shim ? 'shim' : 'official'), note: raw.matrix?.note ?? null, json, file: rel, report, at: json.generatedAt ?? '' };
    const k = `${version}\u0000${model}`, prev = byCell.get(k);
    if (!prev || String(cell.at) > String(prev.at)) byCell.set(k, cell); // newest result per cell wins
  }
  const cells = [...byCell.values()];
  for (const c of manifest?.cells ?? []) if (c.state !== 'ran' && !byCell.has(`${c.version}\u0000${c.model}`)) cells.push({ version: c.version, model: c.model, state: c.state, reason: c.reason });
  return { cells, manifest };
}

// ---------- cost estimate (dry run) ----------
// mean cost of one with-arm agent run, per model where history has it (an alias matches the ids it
// resolved to, e.g. haiku → claude-haiku-4-5), else across all models
export function estimateCost(results, models) {
  const runs = results.flatMap(({ json }) => (json.cases ?? []).flatMap((c) => c.arms?.with ?? [])).filter((r) => !r.isError && typeof r.costUsd === 'number');
  const overall = mean(runs.map((r) => r.costUsd));
  const perModel = Object.fromEntries(models.map((m) => {
    const mine = runs.filter((r) => r.model && (r.model === m || String(r.model).includes(m)));
    return [m, mine.length ? { usd: mean(mine.map((r) => r.costUsd)), from: mine.length, exact: true } : { usd: overall, from: runs.length, exact: false }];
  }));
  return { overall, samples: runs.length, perModel };
}

// ---------- rendering ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : 'n/a');
const LABEL = { pass: 'passes', improved: 'improved on the reference', below: 'below the pass score, same as the reference', regressed: 'regressed against the reference', fail: 'below the pass score', errored: 'every run errored', missing: 'case missing from this result', unknown: 'no score (budget ran out)', unrun: 'not run' };

function headline(ev) {
  const ran = ev.cells.filter((c) => c.verdict !== 'unrun'), safe = ev.cells.filter((c) => c.verdict === 'safe');
  if (!ran.length) return { tone: 'muted', mark: '○', text: 'No cells ran yet' };
  if (safe.length === ev.cells.length) return { tone: 'pass', mark: '●', text: `Safe on all ${safe.length} cells` };
  return { tone: safe.length ? 'warn' : 'fail', mark: safe.length ? '◆' : '▼', text: `Safe on ${safe.length} of ${ev.cells.length} cells` };
}

export function renderMatrixHtml(ev, meta = {}) {
  const { versions, models, reference: ref } = ev;
  const suite = meta.suite ?? 'suite', h = headline(ev);
  const cellAt = (v, m) => ev.cells.find((c) => c.version === v && c.model === m);
  const grid = versions.flatMap((v) => models.map((m) => cellAt(v, m)));
  const vg = (c, i) => (i % models.length === 0 ? ' vg' : '') + (c.isRef ? ' ref' : '');
  const lede = `Every cell is one run of the suite on that model and Claude Code version, compared with the reference cell: ${ref.model} on Claude Code ${ref.version}${ev.refUsable ? '' : ' (which did not run, so cells are held to the pass score alone)'}. A case regresses when it drops more than ${ev.threshold} below the reference.${ev.refBelow.length ? ` The reference itself scores below ${f2(ev.passScore)} on ${andList(ev.refBelow)}; cells that match it there still count as safe.` : ''}`;
  const verdictList = models.map((m) => { const cs = ev.cells.filter((c) => c.model === m); const tone = cs.every((c) => c.verdict === 'safe') ? 'pass' : cs.some((c) => c.verdict === 'safe') ? 'warn' : cs.every((c) => c.verdict === 'unrun') ? 'muted' : 'fail';
    return `<li class="${tone}"><span class="dot ${tone}"></span>${esc(ev.verdicts[m])}</li>`; }).join('');
  const stamp = [
    ['reference', `<b>${esc(ref.model)}</b> <span class="from">on Claude Code ${esc(ref.version)}</span>`],
    ['grid', `<b>${versions.length} × ${models.length}</b> <span class="from">versions × models, ${ev.cases.length} case${ev.cases.length === 1 ? '' : 's'}${meta.runs ? `, ${meta.runs} run${meta.runs === 1 ? '' : 's'} each` : ''}</span>`],
    ['spend', `<b>${usd(meta.spent ?? ev.cells.reduce((s, c) => s + (c.costUsd ?? 0), 0))}</b>${meta.budget != null ? ` <span class="from">of $${meta.budget} budget</span>` : ''}`],
    ['pass score', `<b>${f2(ev.passScore)}</b> <span class="from">regression past ${ev.threshold}</span>`],
    ...(meta.filters ? [['filter', `<span class="from">${esc(meta.filters)}</span>`]] : []),
    ['generated', `<span class="from">${esc(String(meta.generatedAt ?? new Date().toISOString()).replace('T', ' ').slice(0, 16))} UTC</span>`],
  ];
  const head1 = versions.map((v) => `<th colspan="${models.length}" class="vh vg">Claude Code ${esc(v)}</th>`).join('');
  const head2 = grid.map((c, i) => `<th class="mh${vg(c, i)}" title="${esc(c.resolvedModels?.join(', ') || c.model)}">${c.report ? `<a href="${esc(c.report)}">${esc(c.model)}</a>` : esc(c.model)}${c.isRef ? ' <i class="tag">ref</i>' : ''}</th>`).join('');
  const sumCell = (c, i, body) => `<td class="sum v-${c.verdict}${vg(c, i)}">${body}</td>`;
  const sumRows = [
    ['passing', (c) => (c.verdict === 'unrun' ? '<span class="muted">not run</span>' : c.verdict === 'errored' ? `<span title="${esc(c.reason ?? '')}">errored</span>` : `<b>${c.passed}/${c.total}</b>`)],
    ['cost', (c) => (c.costUsd == null ? '' : usd(c.costUsd))],
    ['mean turns', (c) => (c.meanTurns == null ? '' : c.meanTurns.toFixed(1))],
    ['runner', (c) => `<span class="muted" title="${esc(c.note ?? c.reason ?? '')}">${esc(c.runner ?? '')}</span>`],
  ].map(([label, f]) => `<tr class="sr"><th class="cn">${label}</th>${grid.map((c, i) => sumCell(c, i, f(c))).join('')}</tr>`).join('');
  const caseRows = ev.cases.map((nm) => `<tr><th class="cn" title="${esc(nm)}">${esc(nm)}</th>${grid.map((c, i) => {
    if (c.verdict === 'unrun' || c.verdict === 'errored') return `<td class="sc st-${c.verdict}${vg(c, i)}" title="${esc(c.reason ?? LABEL[c.verdict] ?? '')}">${c.verdict === 'unrun' ? 'not run' : 'error'}</td>`;
    const x = c.cases[nm] ?? { status: 'missing', score: null };
    const tip = `${nm} · Claude Code ${c.version} · ${c.model} · score ${f2(x.score)}${typeof x.delta === 'number' ? ` (${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(2)} vs reference)` : ''} · ${LABEL[x.status] ?? x.status}`;
    return `<td class="sc st-${x.status}${vg(c, i)}" title="${esc(tip)}">${x.status === 'missing' ? 'missing' : x.status === 'errored' ? 'error' : f2(x.score)}</td>`;
  }).join('')}</tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(suite)} model matrix</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"><style>${CSS}</style></head><body><div class="wrap">
<header class="verdict">
  <div><p class="eyebrow">config-drift-checker · <b>${esc(suite)}</b> · model × Claude Code matrix</p>
    <h1 class="${h.tone}"><span class="mark">${h.mark}</span><span>${esc(h.text)}</span></h1>
    <p class="lede">${esc(lede)}</p>
    <ul class="verdicts">${verdictList}</ul></div>
  <dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
<h2>Every case on every cell</h2>
<div class="tablewrap"><table class="mx"><thead><tr><th class="cn" rowspan="2">case</th>${head1}</tr><tr>${head2}</tr></thead>
<tbody>${sumRows}${caseRows}</tbody></table></div>
<p class="legend"><span><i class="sw st-pass"></i>passes</span><span><i class="sw st-improved"></i>improved</span><span><i class="sw st-below"></i>below ${f2(ev.passScore)}, same as the reference</span><span><i class="sw st-regressed"></i>regressed or failing</span><span><i class="sw st-unrun"></i>not run</span><span><i class="sw ref"></i>reference cell</span></p>
<p class="foot">Scores are the mean over a case's runs with the setup loaded. Hover a cell for its delta against the reference; a model name opens that cell's full report. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a> drift-matrix.</p>
</div></body></html>`;
}

export function renderMatrixMd(ev, meta = {}) {
  const ref = ev.reference;
  const rows = ev.cells.map((c) => `| ${c.version} | ${c.model}${c.isRef ? ' (reference)' : ''} | ${c.passed == null ? '' : `${c.passed}/${c.total}`} | ${c.costUsd == null ? '' : usd(c.costUsd)} | ${c.meanTurns == null ? '' : c.meanTurns.toFixed(1)} | ${c.verdict === 'fails' ? `fails ${andList(c.failing)}` : c.verdict === 'unrun' ? 'not run' : c.verdict} |`);
  return [`### Model × Claude Code matrix: ${meta.suite ?? 'suite'}`, '',
    `Reference: **${ref.model}** on Claude Code **${ref.version}** · pass score ${f2(ev.passScore)} · spent ${usd(meta.spent ?? 0)}${meta.budget != null ? ` of $${meta.budget}` : ''}`, '',
    ...ev.models.map((m) => `- ${ev.verdicts[m]}`), '',
    '| Claude Code | model | passing | cost | mean turns | verdict |', '|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

export function matrixJson(ev, meta = {}) {
  return { schemaVersion: 1, tool: 'drift-matrix', suite: meta.suite ?? null, generatedAt: meta.generatedAt ?? new Date().toISOString(),
    versions: ev.versions, models: ev.models, reference: ev.reference, passScore: ev.passScore, threshold: ev.threshold,
    runs: meta.runs ?? null, budget: meta.budget ?? null, spent: meta.spent ?? null, filters: meta.filters ?? null, cases: ev.cases,
    cells: ev.cells.map(({ version, model, isRef, state, verdict, reason, runner, note, file, report, passed, total, costUsd, meanTurns, resolvedModels, failing, cases }) =>
      ({ version, model, isRef, state, verdict, reason, runner, note, file, report, passed, total, costUsd, meanTurns, resolvedModels, failing, cases })),
    verdicts: ev.verdicts };
}

const CSS = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
a{color:inherit;text-decoration:none}a:hover{color:var(--track)}.wrap{max-width:1180px;margin:0 auto;padding:28px 28px 90px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.verdict{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;display:flex;gap:14px;align-items:baseline}h1 .mark{font-size:26px}h1.pass .mark{color:var(--pass)}h1.fail .mark{color:var(--fail)}h1.warn .mark{color:var(--warn)}h1.muted .mark{color:var(--muted)}
.lede{font-size:15px;color:var(--muted);margin:0;max-width:66ch}
.verdicts{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:6px}.verdicts li{font-size:14.5px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--muted);border-radius:6px;padding:7px 12px;overflow-wrap:anywhere}
.verdicts li.pass{border-left-color:var(--pass)}.verdicts li.warn{border-left-color:var(--warn)}.verdicts li.fail{border-left-color:var(--fail)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--muted)}.dot.pass{background:var(--pass)}.dot.warn{background:var(--warn)}.dot.fail{background:var(--fail)}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:12.5px;box-shadow:var(--shadow)}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0}.stamp b{font-weight:600}.from{color:var(--muted)}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}
table.mx{border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%}
.mx th,.mx td{padding:7px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}.mx tr:last-child td,.mx tr:last-child th{border-bottom:0}
.mx thead th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;text-align:center}
.mx .cn{position:sticky;left:0;z-index:1;background:var(--surface);text-align:left;font-weight:500;max-width:300px;overflow:hidden;text-overflow:ellipsis;font-size:13px;letter-spacing:0;text-transform:none;color:var(--ink)}
.mx thead .cn{color:var(--muted);text-transform:uppercase;font-size:11px}.mx .vg{border-left:2px solid var(--rule)}
.mx .tag{font-style:normal;font-size:10px;padding:0 5px;border-radius:4px;background:var(--track-bg);color:var(--track);margin-left:4px}
.mx td{text-align:center;font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.mx tr.sr td,.mx tr.sr th{background:var(--code);font-size:12px}.mx tr.sr th.cn{background:var(--code);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px}
.mx td.v-safe b{color:var(--pass)}.mx td.v-fails b,.mx td.v-errored{color:var(--fail)}.mx td.v-incomplete b{color:var(--warn)}
.st-pass,.st-improved{background:var(--pass-bg);color:var(--pass)}.st-improved{font-weight:600}.st-below{background:var(--warn-bg);color:var(--warn)}
.st-regressed,.st-fail,.st-errored,.st-missing{background:var(--fail-bg);color:var(--fail);font-weight:600}.st-unknown,.st-unrun{color:var(--muted);background:repeating-linear-gradient(135deg,transparent 0 6px,var(--code) 6px 12px)}
.mx td.ref,.mx th.ref{box-shadow:inset 2px 0 0 var(--track),inset -2px 0 0 var(--track)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted);margin:10px 0 0}.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:14px;height:12px;border-radius:3px;display:inline-block;border:1px solid var(--rule)}.sw.ref{box-shadow:inset 2px 0 0 var(--track),inset -2px 0 0 var(--track);background:var(--surface)}
.foot{color:var(--muted);font-size:12px;margin-top:22px}:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.wrap{padding:20px 16px 60px}.mx .cn{max-width:160px}}`;

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { plugin: null, models: null, versions: null, last: null, runs: 1, case: null, tag: null, budget: 5, reference: null, passScore: 1, runner: 'auto', outDir: null, out: null, json: null, md: null, history: null, dryRun: false, from: null };
  const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--models') opt.models = list(next()); else if (a === '--versions') opt.versions = list(next());
    else if (a === '--last') opt.last = Number(next()); else if (a === '--runs') opt.runs = Number(next());
    else if (a === '--case') opt.case = next(); else if (a === '--tag') opt.tag = next();
    else if (a === '--budget') opt.budget = Number(next()); else if (a === '--reference') opt.reference = next();
    else if (a === '--pass-score') opt.passScore = Number(next()); else if (a === '--runner') opt.runner = next();
    else if (a === '--out-dir') opt.outDir = path.resolve(next()); else if (a === '--out') opt.out = path.resolve(next());
    else if (a === '--json') opt.json = path.resolve(next()); else if (a === '--md') { const v = next(); opt.md = v === '-' ? '-' : path.resolve(v); }
    else if (a === '--history') opt.history = path.resolve(next()); else if (a === '--from') opt.from = path.resolve(next());
    else if (a === '--dry-run') opt.dryRun = true;
    else if (!a.startsWith('--')) opt.plugin = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  const usage = 'usage: drift-matrix.mjs <plugin> --models a,b (--versions x,y | --last N) [--runs 1] [--case glob] [--tag t] [--budget 5] [--reference version:model] [--dry-run]\n       drift-matrix.mjs --from <dir> [--reference version:model] [--out page.html] [--json m.json] [--md file|-]';
  const die = (m, code = 2) => { console.error(m); process.exit(code); };
  if (!opt.plugin && !opt.from) die(usage);
  if (!['auto', 'official', 'shim'].includes(opt.runner)) die(`--runner must be auto, official or shim`);
  if (!(opt.runs >= 1) || !(opt.budget > 0) || !(opt.passScore >= 0 && opt.passScore <= 1)) die('--runs must be at least 1, --budget above 0, --pass-score between 0 and 1');

  const cfg = opt.plugin ? loadConfig(opt.plugin) : null;
  const track = cfg ? resolveTrack(cfg, 'pinned') : null;
  const pinnedModel = cfg?.model?.pinned ?? null, pinnedVersion = cfg?.harness?.pinned != null ? String(cfg.harness.pinned) : null;
  const filters = [opt.case && `case ${opt.case}`, opt.tag && `tag ${opt.tag}`].filter(Boolean).join(', ') || null;
  const finish = async (ev, meta, outDir) => {
    const page = opt.out ?? path.join(outDir, 'matrix.html');
    await fs.mkdir(path.dirname(page), { recursive: true });
    await fs.writeFile(page, renderMatrixHtml(ev, meta));
    const mj = JSON.stringify(matrixJson(ev, meta), null, 2) + '\n';
    await fs.writeFile(path.join(outDir, 'matrix.json'), mj);
    if (opt.json) await fs.writeFile(opt.json, mj);
    const md = renderMatrixMd(ev, meta);
    if (opt.md === '-') process.stdout.write(md); else if (opt.md) await fs.writeFile(opt.md, md);
    console.log(`\nReference: ${ev.reference.model} on Claude Code ${ev.reference.version}`);
    for (const m of ev.models) console.log(`  ${ev.verdicts[m]}`);
    console.log(`\n${page}\n${path.join(outDir, 'matrix.json')}${opt.json ? `\n${opt.json}` : ''}`);
  };

  if (opt.from) { // render only: nothing installed, nothing run
    if (!existsSync(opt.from)) die(`no such dir ${opt.from}`, 1);
    const { cells, manifest } = await loadMatrixDir(opt.from);
    if (!cells.length) die(`no results in ${opt.from}`, 1);
    const versions = (opt.versions ?? manifest?.versions ?? [...new Set(cells.map((c) => c.version))]).slice().sort(cmpV);
    const models = opt.models ?? manifest?.models ?? [...new Set(cells.map((c) => c.model))];
    const reference = pickReference(versions, models, { spec: opt.reference ?? (manifest?.reference ? `${manifest.reference.version}:${manifest.reference.model}` : null), pinnedVersion, pinnedModel });
    const ev = evaluateMatrix(cells, { versions, models, reference, passScore: opt.passScore, threshold: track?.thresholds.score ?? manifest?.threshold ?? 0.15 });
    const suite = manifest?.suite ?? cells.find((c) => c.json)?.json.suite?.name ?? path.basename(opt.from);
    await finish(ev, { suite, generatedAt: manifest?.generatedAt, runs: manifest?.runs, budget: manifest?.budget, spent: manifest?.spent, filters: manifest?.filters }, opt.outDir ?? opt.from);
    process.exit(0);
  }

  // the grid
  const models = opt.models ?? [track.model];
  let versions = opt.versions;
  if (!versions && opt.last) {
    let all; try { all = publishedVersions(); } catch (e) { die(e.message, 1); }
    versions = lastVersions(all, opt.last);
    if (pinnedVersion && SEMVER.test(pinnedVersion) && !versions.includes(pinnedVersion)) versions.push(pinnedVersion);
  }
  if (!versions?.length) die(`pass --versions a,b or --last N\n${usage}`);
  for (const v of versions) if (!SEMVER.test(v)) die(`'${v}' is not a Claude Code version (expected x.y.z)`);
  versions = [...new Set(versions)].sort(cmpV);
  const reference = pickReference(versions, models, { spec: opt.reference, pinnedVersion, pinnedModel });
  if (!versions.includes(reference.version) || !models.includes(reference.model)) die(`--reference ${reference.version}:${reference.model} is not in the grid`);
  const manifest = JSON.parse(await fs.readFile(path.join(opt.plugin, '.claude-plugin', 'plugin.json'), 'utf8').catch(() => '{}'));
  const evalRoot = path.join(opt.plugin, manifest.experimental?.evals ?? 'evals');
  const view = await suiteView(opt.plugin, { caseGlob: opt.case, tag: opt.tag });
  await view.cleanup();
  if (!view.cases.length) die(`no eval cases match${filters ? ` (${filters})` : ''}`, 1);
  const nCells = versions.length * models.length, perCell = view.cases.length * opt.runs;
  console.log(`Grid: ${versions.length} version${versions.length === 1 ? '' : 's'} × ${models.length} model${models.length === 1 ? '' : 's'} = ${nCells} cell${nCells === 1 ? '' : 's'} · ${view.cases.length} case${view.cases.length === 1 ? '' : 's'} × ${opt.runs} run${opt.runs === 1 ? '' : 's'} = ${perCell} agent run${perCell === 1 ? '' : 's'} per cell, ${nCells * perCell} in all`);
  console.log(`  versions:  ${versions.join(', ')}\n  models:    ${models.join(', ')}\n  reference: ${reference.model} on Claude Code ${reference.version}${filters ? `\n  filter:    ${filters}` : ''}\n  budget:    $${opt.budget} for the whole grid`);

  if (opt.dryRun) {
    const history = [...await readResults(path.join(evalRoot, 'results')), ...await readResults(opt.history)];
    const est = estimateCost(history, models);
    if (!est.samples) console.log(`\nNo past results to estimate from (looked in ${path.join(evalRoot, 'results')}${opt.history ? ` and ${opt.history}` : ''}). Run one cell first, or pass --history <dir>.`);
    else {
      const cellCost = (m) => perCell * est.perModel[m].usd;
      const order = [reference.version, ...versions.filter((v) => v !== reference.version)].flatMap((v) => [reference.model, ...models.filter((m) => m !== reference.model)].map((m) => ({ v, m })));
      let cum = 0, fits = 0; for (const { m } of order) { if (cum >= opt.budget) break; cum += cellCost(m); fits++; }
      const total = versions.length * models.reduce((s, m) => s + cellCost(m), 0);
      console.log(`\nEstimated cost: about ${usd(total)} (${models.map((m) => `${m} ${usd(est.perModel[m].usd)} per run${est.perModel[m].exact ? ` from ${est.perModel[m].from} past runs` : ', all-model average'}`).join('; ')}).`);
      console.log(fits >= nCells ? `The $${opt.budget} budget covers every cell.` : `The $${opt.budget} budget starts about ${fits} of ${nCells} cells; the rest would show as not run.`);
    }
    console.log('\nDry run: nothing installed, nothing run, $0 spent.');
    process.exit(0);
  }

  const generatedAt = new Date().toISOString();
  const outDir = opt.outDir ?? path.join(evalRoot, 'results', `matrix-${generatedAt.replace(/[:.]/g, '-')}`);
  let res;
  try { res = await runMatrix({ plugin: opt.plugin, versions, models, reference, runs: opt.runs, budget: opt.budget, caseGlob: opt.case, tag: opt.tag, runner: opt.runner, judgeModel: track.judgeModel, outDir }); }
  catch (e) { die(e.message, 1); }
  const ev = evaluateMatrix(res.cells, { versions, models, reference, passScore: opt.passScore, threshold: track.thresholds.score });
  const suite = res.cells.find((c) => c.json)?.json.suite?.name ?? path.basename(opt.plugin);
  await finish(ev, { suite, generatedAt, runs: opt.runs, budget: opt.budget, spent: res.spent, filters }, outDir);
  console.log(`Spent about ${usd(res.spent)} of $${opt.budget} (notional; $0 API on a subscription token)`);
  if (!res.cells.some((c) => c.state === 'ran')) process.exitCode = 1;
}
