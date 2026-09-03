#!/usr/bin/env node
// eval-report — self-contained HTML report from aggregate-result.json (official runner or shim).
//
//   node tools/eval-report.mjs <current.json> [--baseline <baseline.json>] [--out report.html] [--threshold 0.15]
//        [--config <plugin-dir>]   thresholds (score/turns/cost/duration) from <plugin-dir>/.cdc.yml
//        [--history <dir>]   newest N past results → per-case noise band (drops inside it are ⚠ noisy, not red)
//
// Verdict first (what happened, what to do), then provenance (track, model, Claude Code, judge, cost),
// what moved vs the baseline, the full table, and a per-case / per-run drill-down (grader verdicts and
// reasons, tool calls, response, changed files). No server, no login, no external scripts. Also exported
// as renderReport(). Cases are classified by eval-classify.mjs — the same verdicts as eval-diff.
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { key, median, caseMap, classifyCase, baselineWarnings, resolveThresholds, loadHistory } from './eval-classify.mjs';

export function renderReport(cur, base = null, opt = {}) {
  const th = { score: opt.threshold ?? opt.thresholds?.score ?? 0.15, turns: opt.thresholds?.turns ?? 0.5, cost: opt.thresholds?.cost ?? 0.5, duration: opt.thresholds?.duration ?? 0.5 };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
  const fd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2));
  const money = (x) => (x === null || x === undefined ? '—' : '$' + Number(x).toFixed(2));
  const pct = (x) => (x === null || x === undefined ? '' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
  const runsOf = (c, arm) => c.arms?.[arm] ?? [];
  const okRuns = (c) => runsOf(c, 'with').filter((r) => !r.isError);
  const a = cur.aggregates ?? {};
  const cases = cur.cases ?? [];
  const models = a.resolvedModels?.length ? a.resolvedModels : [...new Set(cases.flatMap((c) => runsOf(c, 'with').map((r) => r.model)).filter(Boolean))];
  const ablating = cases.some((c) => runsOf(c, 'without').length);
  const baseMap = new Map((base?.cases ?? []).map((c) => [key(c), c]));
  const baseModels = base ? [...new Set((base.cases ?? []).flatMap((c) => runsOf(c, 'with').map((r) => r.model)).filter(Boolean))] : [];
  const histCases = opt.history ? opt.history.map(caseMap) : null;

  // ---- per-case analysis (via eval-classify — the same verdicts as eval-diff) ----
  const analyse = (c) => {
    const b = baseMap.get(key(c));
    let status, before = null, delta = null, noise = null, effThreshold = th.score, escalated = null, warnings = [];
    const score = c.summary?.score ?? null;
    if (!base) status = score === 1 ? 'pass' : score === null ? 'none' : 'fail';
    else if (!b) status = 'new';
    else {
      const cls = classifyCase(key(c), b, c, histCases, th.score);
      ({ status, escalated, before, delta, noise, effThreshold } = cls);
      warnings = baselineWarnings(b, opt.minBaselineRuns ?? 3, th.score);
    }
    const eff = {};
    for (const [name, field] of [['turns', 'numTurns'], ['cost', 'costUsd'], ['duration', 'durationMs']]) {
      const after = median(okRuns(c).map((r) => r[field])), bef = b ? median(okRuns(b).map((r) => r[field])) : null;
      const rel = bef !== null && after !== null && bef > 0 ? (after - bef) / bef : null;
      eff[name] = { before: bef, after, rel, drifted: rel !== null && rel > th[name] };
    }
    const flags = [['turns', 'slower'], ['cost', 'pricier'], ['duration', 'longer']].filter(([n]) => eff[n].drifted).map(([, fl]) => fl);
    const issues = runsOf(c, 'with').filter((r) => r.isError || r.truncated).length;
    return { c, b, score, before, delta, noise, effThreshold, escalated, warnings, status, eff, flags, issues, open: status === 'regressed' || status === 'noisy' || status === 'fail' || status === 'missing' || issues > 0 || flags.length > 0 };
  };
  const rows = cases.map(analyse);
  const missing = base ? [...baseMap.keys()].filter((k) => !cases.some((c) => key(c) === k)) : [];
  const regressed = rows.filter((r) => r.status === 'regressed').length + missing.length;
  const improved = rows.filter((r) => r.status === 'improved').length;
  const flagged = rows.filter((r) => r.flags.length).length;
  const noisyN = rows.filter((r) => r.status === 'noisy').length;
  const failing = rows.filter((r) => r.status === 'fail').length;
  const worth = (() => { const d = cases.map((c) => c.summary?.delta).filter((x) => typeof x === 'number'); return d.length ? d.reduce((s, x) => s + x, 0) / d.length : null; })();
  const errored = a.erroredRuns ?? 0;
  const budget = a.budget;

  // ---- verdict ----
  let tone, mark, headline, lede;
  if (errored && errored === a.totalRuns) { tone = 'fail'; mark = '■'; headline = 'Nothing ran'; lede = `Every agent run errored: ${a.partialReason ?? 'see the run cards'}. Usually no prepaid API credit on the key, or a Claude Code startup failure. Nothing was stored.`; }
  else if (errored) { tone = 'fail'; mark = '■'; headline = `${errored} of ${a.totalRuns} runs errored`; lede = `${a.partialReason ?? ''} Scores below are partial; nothing was stored as a baseline.`; }
  else if (base && regressed) { tone = 'fail'; mark = '▼'; headline = `${regressed} case${regressed === 1 ? '' : 's'} regressed vs baseline`; lede = 'Open the red cases below: each failing run shows which check failed and why. Classify before you fix — refused before acting, skill/hook did not fire, wrong thing, or grader wrong.'; }
  else if (!base && failing) { tone = 'fail'; mark = '▼'; headline = `${failing} case${failing === 1 ? '' : 's'} below 1.00`; lede = 'No baseline to compare with yet. Read the failing runs, fix the setup or the grader, then re-run with promote-baseline to record the first baseline.'; }
  else if (base && (flagged || noisyN)) { tone = 'warn'; mark = '◆'; headline = `No regressions · ${[noisyN ? `${noisyN} noisy` : null, flagged ? `${flagged} efficiency drift${flagged === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}`; lede = [noisyN ? 'A case dropped past the threshold but stayed within its historical noise band — a warning, not a regression; more runs per case shrink the band.' : null, flagged ? 'Every case still passes, but the agent needed noticeably more turns, cost or time than the baseline. Worth a look before it becomes a habit.' : null].filter(Boolean).join(' '); }
  else if (base) { tone = 'pass'; mark = '●'; headline = improved ? `No drift · ${improved} improved` : 'No drift'; lede = `${a.passed ?? rows.filter((r) => r.score === 1).length} of ${cases.length} cases hold against the baseline. Nothing to do.`; }
  else { tone = a.overallScore === 1 ? 'pass' : 'warn'; mark = '●'; headline = a.overallScore === 1 ? 'Baseline recorded · all cases pass' : 'Baseline recorded'; lede = 'This run is the reference. From now on every run is diffed against it; a drop of more than the threshold turns the check red.'; }
  if (budget?.exceeded) lede += ` The per-run budget cap ($${budget.capUsd}) stopped this run early; ${budget.skippedRuns} planned run${budget.skippedRuns === 1 ? '' : 's'} did not start.`;

  const trackLabel = cur.track ? cur.track : null;
  const stamp = [
    ['overall', `<b class="${tone}">${f(a.overallScore)}</b>${base ? ` <span class="from">from ${f(base.aggregates?.overallScore)}</span>` : ''}`],
    ['cases', `<b>${a.passed ?? rows.filter((r) => r.score === 1).length}</b> / ${cases.length} at 1.00`],
    ['model', `<b>${esc(models.join(', ') || '?')}</b>${cur.config ? ` <span class="from">${cur.config.modelIsPinned ? 'pinned' : `alias ${esc(cur.config.model)}`}</span>` : ''}${baseModels.length && baseModels.join() !== models.join() ? ` <span class="moved">moved from ${esc(baseModels.join(', '))}</span>` : ''}`],
    ['claude code', `<b>${esc(cur.harness?.version ?? '?')}</b>${base?.harness?.version && base.harness.version !== cur.harness?.version ? ` <span class="moved">moved from ${esc(base.harness.version)}</span>` : ''}`],
    ['track', trackLabel ? `<b class="track">${esc(trackLabel)}</b>` : '<span class="from">—</span>'],
    ['runner', `<b>${cur.shim ? 'shim' : 'official'}</b>${cur.judge?.model ? ` <span class="from">judge ${esc(cur.judge.model)}</span>` : ''}`],
    ['cost', `<b>${money(a.costUsd)}</b>${budget ? ` <span class="from">of $${budget.capUsd} cap</span>` : ''}`],
    ['when', `<b>${esc(String(cur.generatedAt ?? '').replace('T', ' ').slice(0, 16))}</b>${cur.regradeOf ? ' <span class="from">regrade</span>' : ''}`],
  ];
  if (worth !== null) stamp.push(['setup worth', `<b class="${worth > 0 ? 'pass' : 'warn'}">${fd(worth)}</b> <span class="from">with − without plugin</span>`]);

  // ---- what moved ----
  const moves = rows.filter((r) => ['regressed', 'improved', 'new', 'noisy'].includes(r.status) || r.flags.length).map((r) => `<a class="move ${r.status === 'regressed' ? 'fail' : r.status === 'improved' ? 'pass' : r.status === 'noisy' || r.flags.length ? 'warn' : 'new'}" href="#case-${esc(key(r.c))}">
      <span class="move-case">${esc(key(r.c))}</span>
      <span class="move-num">${r.status === 'new' ? `new · ${f(r.score)}` : `${f(r.before)} → ${f(r.score)}`}</span>
      <span class="move-why">${r.status === 'regressed' ? 'regressed' : r.status === 'noisy' ? `noisy · within ±${(r.noise ?? 0).toFixed(2)} band` : r.status === 'improved' ? 'improved' : r.status === 'new' ? 'not in baseline' : 'passes'}${r.flags.length ? ` · ${r.flags.map((fl) => { const n = { slower: 'turns', pricier: 'cost', longer: 'time' }[fl]; const e = r.eff[{ slower: 'turns', pricier: 'cost', longer: 'duration' }[fl]]; return `${n} ${pct(e.rel)}`; }).join(', ')}` : ''}</span></a>`)
    .concat(missing.map((k) => `<span class="move fail"><span class="move-case">${esc(k)}</span><span class="move-num">missing</span><span class="move-why">in baseline, not in this run</span></span>`)).join('');

  // ---- table ----
  const effCell = (e, fmt) => e.after === null ? '—' : (e.drifted || (e.rel !== null && e.rel < -th.turns)) ? `<span class="${e.drifted ? 'warn' : 'pass'}">${fmt(e.before)} → ${fmt(e.after)}</span> <small>${pct(e.rel)}</small>` : fmt(e.after);
  const tableRows = rows.map((r) => `<tr class="st-${r.status}"><td><span class="dot ${r.status}"></span>${esc(r.status)}${r.flags.length ? ` <small class="warn">${r.flags.join(', ')}</small>` : ''}</td><td><a href="#case-${esc(key(r.c))}">${esc(key(r.c))}</a></td>
      ${base ? `<td class="num">${f(r.before)}</td>` : ''}<td class="num"><b>${f(r.score)}</b></td>${base ? `<td class="num ${r.delta !== null && r.delta < -r.effThreshold ? 'fail' : r.delta !== null && r.delta > th.score ? 'pass' : r.status === 'noisy' ? 'warn' : ''}">${fd(r.delta)}</td><td class="num">${r.noise === null || r.noise === undefined ? '—' : `±${r.noise.toFixed(2)}`}</td>` : ''}
      ${ablating ? `<td class="num">${f(r.c.summary?.baselineScore)}</td><td class="num">${fd(r.c.summary?.delta)}</td>` : ''}<td class="num">${effCell(r.eff.turns, (x) => String(Math.round(x)))}</td><td class="num">${effCell(r.eff.cost, (x) => '$' + Number(x).toFixed(2))}</td><td class="num">${runsOf(r.c, 'with').length}${ablating ? '+' + runsOf(r.c, 'without').length : ''}${r.issues ? ` <small class="warn" title="runs that errored or hit max_turns">${r.issues}⚠</small>` : ''}</td></tr>`)
    .concat(missing.map((k) => `<tr class="st-missing"><td><span class="dot missing"></span>missing</td><td>${esc(k)}</td><td class="num">${f(baseMap.get(k)?.summary?.score)}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>${ablating ? '<td></td><td></td>' : ''}<td></td><td></td><td></td></tr>`)).join('');

  // ---- noise / baseline-quality notes (mirror the PR-comment markdown) ----
  const noisyRows = rows.filter((r) => r.status === 'noisy');
  const warnedRows = rows.filter((r) => r.warnings?.length);
  const notes = [
    noisyRows.length ? `<p class="note"><b class="warn">⚠ ${noisyRows.length} noisy:</b> dropped past ${th.score} but within historical noise (±${Math.max(...noisyRows.map((r) => r.noise ?? 0)).toFixed(2)} over the last ${(opt.history ?? []).length} run${(opt.history ?? []).length === 1 ? '' : 's'}) — warning, not a regression.</p>` : '',
    rows.filter((r) => r.escalated).map((r) => `<p class="note"><b class="fail">▼ ${esc(key(r.c))}:</b> within its ±${(r.noise ?? 0).toFixed(2)} noise band but red anyway — ${esc(r.escalated)}.</p>`).join(''),
    warnedRows.length ? `<p class="note"><b class="warn">⚠ baseline quality (never red):</b> ${warnedRows.map((r) => `<code>${esc(key(r.c))}</code> — ${esc(r.warnings.join(', '))}`).join(' · ')}. More runs per case fix this; never loosen the threshold.</p>` : '',
  ].filter(Boolean).join('');

  // ---- cases ----
  const chip = (g) => {
    const cls = !g.scored ? 'ind' : g.verdict === 'pass' ? 'pass' : g.verdict === 'fail' ? 'fail' : 'skip';
    const m = g.verdict === 'pass' ? '✓' : g.verdict === 'fail' ? '✗' : '·';
    const title = [g.type, g.reason, !g.scored ? (g.armOnly ? `scored in ${g.armOnly} arm only` : 'indicator (unscored)') : ''].filter(Boolean).join(' — ');
    return `<span class="chip ${cls}" title="${esc(title)}">${m} ${esc(g.name)}${!g.scored ? '<i>ind</i>' : ''}</span>`;
  };
  const runCard = (r, arm) => {
    const state = r.isError ? 'na' : r.score === null ? 'na' : r.score < 1 ? 'bad' : r.truncated ? 'warn' : 'ok';
    const tools = (r.toolUses ?? []).map((t) => `<li><code>${esc(t.tool)}</code> <span class="in">${esc(typeof t.input === 'string' ? t.input.slice(0, 220) : JSON.stringify(t.input).slice(0, 220))}</span></li>`).join('');
    const reasons = (r.graders ?? []).filter((g) => g.reason).map((g) => `<li><b>${esc(g.name)}</b> — ${esc(g.reason)}</li>`).join('');
    const files = (r.filesChanged ?? r.filesCreated ?? []).map((x) => `<li><code>${esc(x)}</code></li>`).join('');
    const flagsTxt = [r.isError ? '<em class="fail">error</em>' : '', r.truncated ? '<em class="warn">max_turns</em>' : '', r.timedOut ? '<em class="fail">timeout</em>' : ''].filter(Boolean).join(' ');
    return `<article class="run ${state}">
      <header><span class="arm ${arm}">${arm}</span><b>run ${(r.runIndex ?? 0) + 1}</b><span class="score ${state}">${f(r.score)}</span>
        <span class="meta">${r.numTurns ?? '—'} turns · ${money(r.costUsd)}${r.durationMs ? ` · ${r.durationMs < 10_000 ? (r.durationMs / 1000).toFixed(1) : Math.round(r.durationMs / 1000)} s` : ''}${r.model ? ` · ${esc(r.model)}` : ''} ${flagsTxt}</span></header>
      <div class="chips">${(r.graders ?? []).map(chip).join('')}</div>
      ${r.isError && r.stderrTail ? `<pre class="err">${esc(r.stderrTail)}</pre>` : ''}
      ${reasons ? `<details${state === 'bad' ? ' open' : ''}><summary>Judge reasons</summary><ul class="reasons">${reasons}</ul></details>` : ''}
      <details><summary>Tool calls (${(r.toolUses ?? []).length})</summary>${tools ? `<ol class="tools">${tools}</ol>` : '<p class="muted">none</p>'}</details>
      ${files ? `<details><summary>Files changed (${(r.filesChanged ?? r.filesCreated).length})</summary><ul class="files">${files}</ul></details>` : ''}
      <details><summary>Response</summary><pre class="resp">${esc(r.response ?? '')}</pre></details>
    </article>`;
  };
  const graderWhat = (g) => {
    const t = g.type;
    if (t === 'regex') return `${g.match === 'not_contains' ? 'must NOT contain' : g.match?.startsWith('count') ? 'must contain ' + g.match.slice(6) + '× ' : 'must contain'} <code>${esc(g.pattern ?? '')}</code> in ${esc(g.target ?? 'last_message')}`;
    if (t === 'tool_used') return `tool <code>${esc(g.tool ?? '')}</code>${g.input_match ? ' matching <code>' + esc(g.input_match) + '</code>' : ''} used ${g.max === 0 ? '0 times' : (g.min ?? 1) + '+ times' + (g.max != null ? ', at most ' + g.max : '')}${g.arm ? ' (' + esc(g.arm) + ' arm)' : ''}`;
    if (t === 'file_exists') return `a file matching <code>${esc(g.path ?? '')}</code> exists`;
    if (t === 'llm') return `judge model: ${esc(g.criteria ?? '')}`;
    return esc(t);
  };
  const spark = (c) => { // one bar per with-arm run, score 0..1 — the flake shape behind the noise band
    const rs = runsOf(c, 'with');
    if (!rs.length) return '';
    const w = rs.length * 7 + 2, h = 22;
    const bars = rs.map((x, i) => {
      const s = typeof x.score === 'number' && !x.isError ? x.score : null;
      const bh = s === null ? 3 : Math.max(2, Math.round(s * (h - 4)));
      const col = s === null ? 'var(--muted)' : s >= 1 ? 'var(--pass)' : 'var(--fail)';
      return `<rect x="${1 + i * 7}" y="${h - 2 - bh}" width="5" height="${bh}" rx="1" fill="${col}"><title>run ${i + 1}${x.isError ? ' (errored)' : ''}: ${s === null ? '—' : s.toFixed(2)}</title></rect>`;
    }).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="with-arm run scores">${bars}</svg>`;
  };
  const sections = rows.map((r) => { const c = r.c; return `<section class="case st-${r.status}" id="case-${esc(key(c))}">
    <header class="case-h"><div><h2>${esc(key(c))}</h2>${c.name && c.name !== key(c) ? `<p class="case-name">${esc(c.name)}</p>` : ''}</div>
      <div class="case-num">${spark(c)}<span class="dot ${r.status}"></span>${esc(r.status)} · <b>${f(r.score)}</b>${base && r.before !== null ? ` <span class="from">from ${f(r.before)}</span>` : ''}${r.noise !== null && r.noise !== undefined ? ` <span class="from">· noise ±${r.noise.toFixed(2)}</span>` : ''}${ablating && typeof c.summary?.delta === 'number' ? ` <span class="from">· plugin ${fd(c.summary.delta)}</span>` : ''}</div></header>
    <p class="tags">${(c.tags ?? []).map((t) => `<span>${esc(t)}</span>`).join('')}${(c.covers ?? []).map((t) => `<span class="covers" title="rule this case covers">${esc(t)}</span>`).join('')}</p>
    <details class="about"${r.open ? '' : ''}><summary>What this case evaluates${c.description ? ` — <span class="desc">${esc(c.description)}</span>` : ''}</summary>
      ${c.prompt ? `<div class="about-b"><div class="about-h">The request given to the agent</div><pre class="prompt">${esc(c.prompt)}</pre></div>` : ''}
      ${(c.graders ?? []).length ? `<div class="about-b"><div class="about-h">The checks (${c.graders.length})</div><table class="checks"><tbody>${c.graders.map((g) => `<tr><td><code>${esc(g.name)}</code></td><td class="t">${esc(g.type)}</td><td>${esc(g.rubric ?? '')}<div class="how">${graderWhat(g)}</div></td></tr>`).join('')}</tbody></table></div>` : ''}
      ${c.scaffold ? `<div class="about-b"><div class="about-h">Workspace setup before each run</div><pre class="prompt">${esc(c.scaffold)}</pre></div>` : ''}
    </details>
    <div class="runs">${['with', 'without'].flatMap((arm) => runsOf(c, arm).map((x) => runCard(x, arm))).join('')}</div></section>`; }).join('');

  const css = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
.mono,.stamp,.num,.arm,.score,.meta,.tick,code,pre{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:inherit}a:hover{color:var(--track)}.wrap{max-width:1140px;margin:0 auto;padding:28px 28px 90px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.track{color:var(--track)}.muted{color:var(--muted)}
/* verdict */
.verdict{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;display:flex;gap:14px;align-items:baseline}h1 .mark{font-size:26px;line-height:1}h1.pass .mark{color:var(--pass)}h1.fail .mark{color:var(--fail)}h1.warn .mark{color:var(--warn)}
.lede{font-size:16px;color:var(--muted);margin:0;max-width:56ch}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12.5px;box-shadow:var(--shadow);position:relative}
.stamp::before{content:"";position:absolute;inset:6px;border:1px dashed var(--rule);border-radius:5px;pointer-events:none}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0;color:var(--ink)}.stamp b{font-weight:600}.from{color:var(--muted)}.moved{color:var(--warn);font-weight:500}
/* moves */
.moves{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}.move{display:grid;gap:2px;padding:10px 14px;border-radius:8px;border:1px solid var(--rule);border-left-width:4px;background:var(--surface);text-decoration:none;min-width:200px;box-shadow:var(--shadow)}
.move.fail{border-left-color:var(--fail)}.move.pass{border-left-color:var(--pass)}.move.warn{border-left-color:var(--warn)}.move.new{border-left-color:var(--track)}
.move-case{font-weight:600;font-size:13.5px}.move-num{font-family:"IBM Plex Mono",monospace;font-size:15px}.move.fail .move-num{color:var(--fail)}.move.pass .move-num{color:var(--pass)}.move.warn .move-num{color:var(--warn)}.move-why{font-size:12px;color:var(--muted)}
/* table */
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);margin:0 0 26px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%}th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);white-space:nowrap;font-weight:600}
td{padding:9px 12px;border-bottom:1px solid var(--rule);font-size:14px}tr:last-child td{border-bottom:0}td.num{text-align:right;font-size:13px;white-space:nowrap}td.num small{color:var(--muted);font-size:11px}td small.warn{font-size:11px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted);vertical-align:1px}.dot.pass,.dot.stable,.dot.improved{background:var(--pass)}.dot.fail,.dot.regressed,.dot.missing{background:var(--fail)}.dot.noisy{background:var(--warn)}.dot.new{background:var(--track)}
tr.st-regressed td,tr.st-fail td,tr.st-missing td{background:var(--fail-bg)}tr.st-noisy td{background:var(--warn-bg)}
.note{font-size:13px;color:var(--muted);margin:0 0 10px}.note b{font-weight:600}
.spark{vertical-align:middle;margin-right:10px}
/* cases */
.filter{font-size:13px;color:var(--muted);display:inline-flex;gap:8px;align-items:center;margin:0 0 14px;cursor:pointer;user-select:none}.filter i{display:inline-block;width:14px;height:14px;border:1.5px solid var(--muted);border-radius:3px;font-style:normal;text-align:center;line-height:12px;font-size:11px}#failing-only:checked ~ .cases .run.ok{display:none}#failing-only:checked ~ .filter i::before{content:"✓"}
.case{margin:0 0 34px;padding:18px 0 0;border-top:2px solid var(--rule)}.case-h{display:flex;justify-content:space-between;gap:16px;align-items:baseline;flex-wrap:wrap}.case h2{font-size:21px;margin:0;letter-spacing:-.01em;font-weight:600}.case-name{margin:2px 0 0;color:var(--muted);font-size:13.5px}
.case-num{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--muted)}.case-num b{color:var(--ink);font-size:15px}
.tags{margin:8px 0 10px;display:flex;flex-wrap:wrap;gap:6px}.tags span{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border:1px solid var(--rule);border-radius:4px;padding:1px 7px}.tags span.covers{text-transform:none;letter-spacing:0;font-family:"IBM Plex Mono",monospace;color:var(--track);border-color:var(--track-bg);background:var(--track-bg)}
.about{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:10px 14px;margin:0 0 14px;font-size:14px;box-shadow:var(--shadow)}.about summary{cursor:pointer;font-weight:600;font-size:13.5px}.about summary .desc{font-weight:400;color:var(--muted)}.about-b{margin:10px 0 4px}.about-h{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 6px;font-weight:600}
pre.prompt{white-space:pre-wrap;background:var(--code);border-radius:6px;padding:10px 12px;font-size:12.5px;margin:0}table.checks td{padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top;font-size:13.5px}table.checks td.t{color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:12px;white-space:nowrap}table.checks .how{color:var(--muted);font-size:12.5px;margin-top:2px}
.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:12px}
.run{background:var(--surface);border:1px solid var(--rule);border-left:4px solid var(--muted);border-radius:8px;padding:12px 14px;min-width:0;box-shadow:var(--shadow)}.run.ok{border-left-color:var(--pass)}.run.warn{border-left-color:var(--warn)}.run.bad{border-left-color:var(--fail)}.run.na{border-left-color:var(--muted);opacity:.85}
.run header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px}.arm{font-size:11px;padding:1px 7px;border-radius:4px;background:var(--code)}.arm.without{opacity:.75}
.score{font-weight:600;font-size:15px}.score.ok{color:var(--pass)}.score.bad{color:var(--fail)}.score.warn{color:var(--warn)}.meta{color:var(--muted);font-size:12px;margin-left:auto}.meta em{font-style:normal;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.chip{font-size:12px;padding:2px 8px;border-radius:4px;background:var(--code);cursor:help}.chip.pass{background:var(--pass-bg);color:var(--pass)}.chip.fail{background:var(--fail-bg);color:var(--fail)}.chip.ind{opacity:.7}.chip i{font-style:normal;font-size:9px;margin-left:4px;letter-spacing:.05em}
details{margin:4px 0}summary{cursor:pointer;font-size:13px;color:var(--muted)}summary:hover{color:var(--ink)}
.tools,.reasons,.files{margin:6px 0 4px;padding-left:18px;font-size:12.5px}.tools .in{color:var(--muted);font-size:11.5px;word-break:break-all}
code{font-size:.9em;background:var(--code);padding:1px 4px;border-radius:3px}
pre.resp{white-space:pre-wrap;word-break:break-word;background:var(--code);border-radius:6px;padding:10px 12px;font-size:12.5px;max-height:420px;overflow:auto;margin:6px 0 0}pre.err{white-space:pre-wrap;word-break:break-word;background:var(--fail-bg);color:var(--fail);border-radius:6px;padding:8px 10px;font-size:12px;margin:6px 0}
.howto{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:8px 14px;margin:0 0 18px;font-size:13.5px}.howto summary{font-weight:600;color:var(--ink)}.howto ol{margin:8px 0 4px;padding-left:20px}.howto li{margin:4px 0}
.foot{color:var(--muted);font-size:12px;margin-top:26px}
:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.runs{grid-template-columns:1fr}.wrap{padding:20px 16px 60px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cur.suite?.name ?? 'eval')} · ${esc(headline)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"><style>${css}</style></head><body><div class="wrap">
<header class="verdict">
  <div><p class="eyebrow">config-drift-checker · <b>${esc(cur.suite?.name ?? 'eval')}</b>${trackLabel ? ` · ${esc(trackLabel)} track` : ''}</p>
    <h1 class="${tone}"><span class="mark">${mark}</span><span>${esc(headline)}</span></h1>
    <p class="lede">${esc(lede)}</p></div>
  <dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
${moves ? `<div class="moves">${moves}</div>` : ''}
<details class="howto"><summary>How to read this report — and what to do</summary>
<ol>
<li><b>No drift / baseline recorded:</b> nothing to do. Hover a grader chip to see what each check asserts and why it passed.</li>
<li><b>N case(s) regressed:</b> open the red case(s) and classify each failing run: <i>refused or asked before acting</i> (1 turn, no tool calls) → the case never reached the skill/hook, rewrite the scenario; <i>skill/hook did not fire</i> → a real regression: pin <code>model.pinned</code>/<code>harness.pinned</code> in <code>.cdc.yml</code> to the last good pair, fix the setup (or run the <code>repair</code> skill), tell the maintainers; <i>grader wrong</i> (matched prose, a negation, nested parentheses) → fix the grader and re-score with <code>--regrade</code>; <i>flaky</i> (mixed verdicts across runs) → raise <code>runs</code>, never the threshold.</li>
<li><b>Efficiency drift (slower / pricier / longer):</b> every case still passes, but the median turns, cost or time moved past its threshold. Warning by default; add it to <code>fail_on</code> in <code>.cdc.yml</code> to make it red.</li>
<li><b>Noisy (⚠):</b> the case dropped past the threshold but stayed within its historical noise band — a warning, not a regression; more runs per case shrink the noise band.</li>
<li><b>Runs errored:</b> read the error text — usually no prepaid API credit or a Claude Code startup failure. Nothing was stored; fix and re-run.</li>
<li><b>A run shows <em>max_turns</em>:</b> it was cut short and scored as-is (amber) → raise that case's <code>max_turns</code>.</li>
<li><b>You changed the setup on purpose:</b> re-run with <code>promote-baseline: true</code> so this becomes the new baseline.</li>
</ol></details>
<div class="tablewrap"><table><thead><tr><th>status</th><th>case</th>${base ? '<th>baseline</th>' : ''}<th>score</th>${base ? '<th>Δ</th><th>noise</th>' : ''}${ablating ? '<th>without plugin</th><th>Δ plugin</th>' : ''}<th>turns</th><th>cost</th><th>runs</th></tr></thead><tbody>${tableRows}</tbody></table></div>
${notes}
<input type="checkbox" id="failing-only" hidden><label for="failing-only" class="filter"><i></i>show failing and flagged runs only</label>
<div class="cases">${sections}</div>
<p class="foot">Scores are the mean over a case's runs with the setup loaded; a drop of more than ${th.score} against the baseline is a regression${opt.history ? ' — a drop inside the case\'s noise band is a ⚠ warning, not red' : ''}. Indicators (ind) are recorded but not scored. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a>.</p>
</div></body></html>`;
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2); let curPath = null, basePath = null, out = null, threshold = null, configDir = null, historyDir = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--baseline') basePath = argv[++i]; else if (argv[i] === '--out') out = argv[++i]; else if (argv[i] === '--threshold') threshold = Number(argv[++i]); else if (argv[i] === '--config') configDir = argv[++i]; else if (argv[i] === '--history') historyDir = argv[++i]; else if (!argv[i].startsWith('--')) curPath = argv[i]; }
  if (!curPath) { console.error('usage: eval-report.mjs <current.json> [--baseline b.json] [--out report.html] [--threshold 0.15] [--config <plugin-dir>] [--history dir]'); process.exit(2); }
  const cur = JSON.parse(await fs.readFile(curPath, 'utf8'));
  const base = basePath ? JSON.parse(await fs.readFile(basePath, 'utf8')) : null;
  const { th, historyRuns, minBaselineRuns } = resolveThresholds(configDir ? path.resolve(configDir) : null, cur.track, { threshold });
  const history = historyDir ? await loadHistory(path.resolve(historyDir), { exclude: path.resolve(curPath), track: cur.track, limit: historyRuns, before: cur.generatedAt ?? null }) : null;
  const html = renderReport(cur, base, { thresholds: th, history, minBaselineRuns });
  const target = out ?? path.join(path.dirname(path.resolve(curPath)), 'report.html');
  await fs.writeFile(target, html);
  console.log(target);
}
