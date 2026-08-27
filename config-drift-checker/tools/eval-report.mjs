#!/usr/bin/env node
// eval-report — self-contained HTML report from aggregate-result.json (official runner or shim).
//
//   node tools/eval-report.mjs <current.json> [--baseline <baseline.json>] [--out report.html] [--threshold 0.15]
//
// Score table, baseline diff, per-case / per-run drill-down (grader verdicts + reasons, tool calls,
// response, changed files). No server, no login, no external scripts. Also exported as renderReport().
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function renderReport(cur, base = null, opt = {}) {
  const threshold = opt.threshold ?? 0.15;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
  const fd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2));
  const money = (x) => (x === null || x === undefined ? '—' : '$' + Number(x).toFixed(3));
  const key = (c) => c.dir ?? c.name;
  const runsOf = (c, arm) => c.arms?.[arm] ?? [];
  const models = new Set(); for (const c of cur.cases ?? []) for (const r of runsOf(c, 'with')) if (r.model) models.add(r.model);
  const ablating = (cur.cases ?? []).some((c) => runsOf(c, 'without').length);
  const baseMap = new Map((base?.cases ?? []).map((c) => [key(c), c]));
  const status = (c) => {
    if (!base) return c.summary?.score === 1 ? 'pass' : c.summary?.score === null || c.summary?.score === undefined ? 'none' : 'fail';
    const b = baseMap.get(key(c)); if (!b) return 'new';
    const d = (c.summary?.score ?? 0) - (b.summary?.score ?? 0);
    return d < -threshold ? 'regressed' : d > threshold ? 'improved' : 'stable';
  };
  const chip = (g) => {
    const cls = !g.scored ? 'ind' : g.verdict === 'pass' ? 'pass' : g.verdict === 'fail' ? 'fail' : 'skip';
    const mark = g.verdict === 'pass' ? '✓' : g.verdict === 'fail' ? '✗' : '·';
    const title = [g.type, g.reason, !g.scored ? (g.armOnly ? `scored in ${g.armOnly} arm only` : 'indicator (unscored)') : ''].filter(Boolean).join(' — ');
    return `<span class="chip ${cls}" title="${esc(title)}">${mark} ${esc(g.name)}${!g.scored ? '<i>ind</i>' : ''}</span>`;
  };
  const runCard = (r, arm) => {
    const tools = (r.toolUses ?? []).map((t) => `<li><code>${esc(t.tool)}</code> <span class="in">${esc(typeof t.input === 'string' ? t.input.slice(0, 220) : JSON.stringify(t.input).slice(0, 220))}</span></li>`).join('');
    const reasons = (r.graders ?? []).filter((g) => g.reason).map((g) => `<li><b>${esc(g.name)}</b> — ${esc(g.reason)}</li>`).join('');
    const files = (r.filesChanged ?? r.filesCreated ?? []).map((x) => `<li><code>${esc(x)}</code></li>`).join('');
    return `<article class="run ${r.score === 1 ? 'ok' : r.score === null ? 'na' : 'bad'}">
      <header><span class="arm ${arm}">${arm}</span> <b>run ${(r.runIndex ?? 0) + 1}</b> <span class="score">${f(r.score)}</span>
        <span class="meta">${r.numTurns ?? '—'} turns · ${money(r.costUsd)} · ${r.durationMs ? Math.round(r.durationMs / 1000) + ' s' : ''} ${r.isError ? '· <em class="err">error</em>' : ''}${r.truncated ? '· <em class="err">max_turns</em>' : ''}${r.timedOut ? '· <em class="err">timeout</em>' : ''}</span></header>
      <div class="chips">${(r.graders ?? []).map(chip).join('')}</div>
      ${reasons ? `<details><summary>Judge reasons</summary><ul class="reasons">${reasons}</ul></details>` : ''}
      <details><summary>Tool calls (${(r.toolUses ?? []).length})</summary>${tools ? `<ol class="tools">${tools}</ol>` : '<p class="muted">none</p>'}</details>
      ${files ? `<details><summary>Files changed (${(r.filesChanged ?? r.filesCreated).length})</summary><ul class="files">${files}</ul></details>` : ''}
      <details><summary>Response</summary><pre class="resp">${esc(r.response ?? '')}</pre></details>
    </article>`;
  };
  const rows = (cur.cases ?? []).map((c) => {
    const st = status(c); const b = baseMap.get(key(c));
    return `<tr class="st-${st}"><td><span class="dot ${st}"></span>${esc(st)}</td><td><a href="#case-${esc(key(c))}">${esc(key(c))}</a></td>
      ${base ? `<td class="num">${f(b?.summary?.score)}</td>` : ''}<td class="num">${f(c.summary?.score)}</td>${base ? `<td class="num">${fd(b ? (c.summary?.score ?? 0) - (b.summary?.score ?? 0) : null)}</td>` : ''}
      ${ablating ? `<td class="num">${f(c.summary?.baselineScore)}</td><td class="num">${fd(c.summary?.delta)}</td>` : ''}<td class="num">${runsOf(c, 'with').length}${ablating ? '+' + runsOf(c, 'without').length : ''}</td><td class="num">${money(c.summary?.costUsd)}</td></tr>`;
  }).join('');
  const graderWhat = (g) => {
    const t = g.type;
    if (t === 'regex') return `${g.match === 'not_contains' ? 'must NOT contain' : g.match?.startsWith('count') ? 'must contain ' + g.match.slice(6) + '× ' : 'must contain'} <code>${esc(g.pattern ?? '')}</code> in ${esc(g.target ?? 'last_message')}`;
    if (t === 'tool_used') return `tool <code>${esc(g.tool ?? '')}</code>${g.input_match ? ' matching <code>' + esc(g.input_match) + '</code>' : ''} used ${g.max === 0 ? '0 times' : (g.min ?? 1) + '+ times' + (g.max != null ? ', at most ' + g.max : '')}${g.arm ? ' (' + esc(g.arm) + ' arm)' : ''}`;
    if (t === 'file_exists') return `a file matching <code>${esc(g.path ?? '')}</code> exists`;
    if (t === 'llm') return `judge model: ${esc(g.criteria ?? '')}`;
    return esc(t);
  };
  const about = (c) => (c.prompt || (c.graders ?? []).length) ? `<div class="about">
      <div class="about-h">What this case evaluates</div>
      ${c.description ? `<p class="about-desc">${esc(c.description)}</p>` : ''}
      ${c.prompt ? `<details open><summary>The request given to the agent</summary><pre class="prompt">${esc(c.prompt)}</pre></details>` : ''}
      ${(c.graders ?? []).length ? `<details open><summary>The checks (${c.graders.length})</summary><table class="checks"><tbody>${c.graders.map((g) => `<tr><td><code>${esc(g.name)}</code></td><td class="t">${esc(g.type)}</td><td>${esc(g.rubric ?? '')}<div class="how">${graderWhat(g)}</div></td></tr>`).join('')}</tbody></table></details>` : ''}
      ${c.scaffold ? `<details><summary>Workspace setup before each run</summary><pre class="prompt">${esc(c.scaffold)}</pre></details>` : ''}
    </div>` : '';
  const sections = (cur.cases ?? []).map((c) => `<section class="case" id="case-${esc(key(c))}"><h2>${esc(key(c))}<small>${esc(c.name && c.name !== key(c) ? c.name : '')}</small></h2>
    <p class="tags">${(c.tags ?? []).map((t) => `<span>${esc(t)}</span>`).join('')}</p>
    ${about(c)}
    <div class="runs">${['with', 'without'].flatMap((arm) => runsOf(c, arm).map((r) => runCard(r, arm))).join('')}</div></section>`).join('');
  const a = cur.aggregates ?? {};
  const regressed = base ? (cur.cases ?? []).filter((c) => status(c) === 'regressed').length : null;
  const css = `
:root{--bg:#F4F6F8;--surface:#FFFFFF;--ink:#1A222D;--muted:#5B6672;--rule:#D6DCE3;--accent:#B85C1E;--pass:#2E7D4F;--fail:#B3362B;--pass-bg:#E6F2EA;--fail-bg:#F8E5E2;--code:#EDF0F3}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141922;--surface:#1B222D;--ink:#E6EAEF;--muted:#98A3B0;--rule:#2C3541;--accent:#E0823C;--pass:#5DBB84;--fail:#E06A5E;--pass-bg:#1B2E23;--fail-bg:#3A1F1C;--code:#0F141B}}
:root[data-theme="dark"]{--bg:#141922;--surface:#1B222D;--ink:#E6EAEF;--muted:#98A3B0;--rule:#2C3541;--accent:#E0823C;--pass:#5DBB84;--fail:#E06A5E;--pass-bg:#1B2E23;--fail-bg:#3A1F1C;--code:#0F141B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Familjen Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 28px 80px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h1 small{font-weight:500;color:var(--muted);font-size:13px;margin-left:10px;letter-spacing:.04em;text-transform:uppercase}
.strip{display:flex;gap:26px;flex-wrap:wrap;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--muted);margin:10px 0 24px}.strip b{color:var(--ink);font-weight:500}
.big{font-size:22px;font-weight:600}.big.pass{color:var(--pass)}.big.fail{color:var(--fail)}
.status{display:inline-flex;align-items:center;font-family:"Familjen Grotesk",sans-serif;font-weight:600;font-size:13px;padding:3px 10px;border-radius:4px}.status.pass{background:var(--pass-bg);color:var(--pass)}.status.fail{background:var(--fail-bg);color:var(--fail)}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface);margin:0 0 30px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--rule)}tr:last-child td{border-bottom:0}td.num{text-align:right;font-family:"JetBrains Mono",monospace;font-size:13px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted)}.dot.pass,.dot.stable,.dot.improved{background:var(--pass)}.dot.fail,.dot.regressed{background:var(--fail)}.dot.new{background:var(--accent)}
tr.st-regressed td,tr.st-fail td{background:var(--fail-bg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.case{margin:0 0 40px;padding-top:18px;border-top:2px solid var(--rule)}.case h2{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}.case h2 small{display:block;font-weight:400;color:var(--muted);font-size:13px}
.tags span{display:inline-block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border:1px solid var(--rule);border-radius:3px;padding:1px 6px;margin-right:6px}
.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
.run{background:var(--surface);border:1px solid var(--rule);border-left:4px solid var(--muted);border-radius:6px;padding:12px 14px;min-width:0;box-shadow:0 1px 0 rgba(0,0,0,.03)}.run.ok{border-left-color:var(--pass)}.run.bad{border-left-color:var(--fail)}
.run header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13px}.arm{font-family:"JetBrains Mono",monospace;font-size:11px;padding:1px 6px;border-radius:3px;background:var(--code)}.arm.without{opacity:.8}
.score{font-family:"JetBrains Mono",monospace;font-weight:600;font-size:15px}.meta{color:var(--muted);font-size:12px;margin-left:auto}.err{color:var(--fail);font-style:normal}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}.chip{font-size:12px;padding:2px 7px;border-radius:3px;background:var(--code);cursor:help}.chip.pass{background:var(--pass-bg);color:var(--pass)}.chip.fail{background:var(--fail-bg);color:var(--fail)}.chip.ind{opacity:.7}.chip i{font-style:normal;font-size:9px;margin-left:4px;letter-spacing:.05em}
details{margin:4px 0}summary{cursor:pointer;font-size:13px;color:var(--muted)}summary:hover{color:var(--ink)}
.tools,.reasons,.files{margin:6px 0 4px;padding-left:18px;font-size:12.5px}.tools .in{color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:11.5px;word-break:break-all}
code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.9em;background:var(--code);padding:1px 4px;border-radius:3px}
pre.resp{white-space:pre-wrap;word-break:break-word;background:var(--code);border-radius:4px;padding:10px;font-size:12.5px;max-height:420px;overflow:auto;margin:6px 0 0}
.muted{color:var(--muted)}
.about{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:12px 14px;margin:8px 0 14px;font-size:14px}.about-h{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.about-desc{margin:0 0 8px;font-size:15px}.about details{margin:4px 0}.about summary{color:var(--ink);font-weight:500}pre.prompt{white-space:pre-wrap;background:var(--code);border-radius:4px;padding:10px;font-size:13px;margin:6px 0 4px}table.checks{border-collapse:collapse;width:100%;margin:6px 0 4px}table.checks td{padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top;font-size:13.5px}table.checks td.t{color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:12px;white-space:nowrap}table.checks .how{color:var(--muted);font-size:12.5px;margin-top:2px}
.howto{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:8px 14px;margin:0 0 18px;font-size:13.5px}.howto summary{font-weight:600;color:var(--ink)}.howto ol{margin:8px 0 4px;padding-left:20px}.howto li{margin:4px 0}
#failing-only:checked ~ .cases .run.ok{display:none}.filter{font-size:13px;color:var(--muted);margin:0 0 12px;display:block}
@media (max-width:640px){.runs{grid-template-columns:1fr}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cur.suite?.name ?? 'eval')} · eval report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"><style>${css}</style></head><body><div class="wrap">
<h1>${esc(cur.suite?.name ?? 'eval')}<small>eval report</small></h1>
<div class="strip"><span class="status ${a.erroredRuns ? 'fail' : regressed ? 'fail' : a.overallScore === 1 ? 'pass' : 'fail'}">${a.erroredRuns ? 'runs errored' : regressed ? regressed + ' regression' + (regressed === 1 ? '' : 's') : a.overallScore === 1 ? 'all cases pass' : 'below 1.00'}</span><span class="big ${a.overallScore === 1 ? 'pass' : 'fail'}">${f(a.overallScore)}</span>
${base ? `<span>vs baseline <b class="${regressed ? 'fail' : ''}">${regressed} regressed</b> (threshold ${threshold})</span>` : ''}
<span>passed <b>${a.passed ?? '—'}</b> / ${(cur.cases ?? []).length}</span>${a.erroredRuns ? `<span class="big fail" style="font-size:14px">⚠ ${esc(a.partialReason)}</span>` : ''}<span>cost <b>${money(a.costUsd)}</b></span><span>model <b>${esc([...models].join(', ') || '?')}</b></span>
<span>${cur.shim ? 'shim' : 'official'} runner</span><span>${esc(cur.generatedAt ?? '')}</span>${cur.regradeOf ? '<span>regrade</span>' : ''}</div>
<details class="howto"><summary>How to read this report — and what to do</summary>
<ol>
<li><b>Header says no regressions / baseline recorded:</b> nothing to do. Hover a grader chip to see what each check asserts and why it passed.</li>
<li><b>Header says N regression(s):</b> open the red case(s) and classify each failing run: <i>refused or asked before acting</i> (1 turn, no tool calls) → the case never reached the skill/hook, rewrite the scenario; <i>skill/hook did not fire</i> → a real regression: pin <code>claude-code-version</code> to the last good release, fix the setup, tell the maintainers; <i>grader wrong</i> (matched prose, a negation, nested parentheses) → fix the grader and re-score with <code>--regrade</code>; <i>flaky</i> (mixed verdicts across runs) → raise <code>runs</code>, never the threshold.</li>
<li><b>Header says agent runs errored:</b> read the error text — usually no prepaid API credit or a Claude Code startup failure. Nothing was stored; fix and re-run.</li>
<li><b>A run shows <em>max_turns</em>:</b> it was cut short and scored as-is → raise that case's <code>max_turns</code>.</li>
<li><b>You changed the setup on purpose:</b> re-run with <code>promote-baseline: true</code> so this becomes the new baseline.</li>
</ol></details>
<div class="tablewrap"><table><thead><tr><th>status</th><th>case</th>${base ? '<th>baseline</th>' : ''}<th>score</th>${base ? '<th>Δ vs base</th>' : ''}${ablating ? '<th>without plugin</th><th>Δ plugin</th>' : ''}<th>runs</th><th>cost</th></tr></thead><tbody>${rows}</tbody></table></div>
<input type="checkbox" id="failing-only" hidden><label for="failing-only" class="filter">☐ show failing runs only (click to toggle)</label>
<div class="cases">${sections}</div>
<p class="muted" style="font-size:12px">Hover a grader chip for its type and reason. Indicators (ind) are recorded but not scored. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a> · <a href="https://jameskomo.github.io/config-drift-checker/#hosted">hosted beta</a>.</p>
</div></body></html>`;
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2); let curPath = null, basePath = null, out = null, threshold = 0.15;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--baseline') basePath = argv[++i]; else if (argv[i] === '--out') out = argv[++i]; else if (argv[i] === '--threshold') threshold = Number(argv[++i]); else if (!argv[i].startsWith('--')) curPath = argv[i]; }
  if (!curPath) { console.error('usage: eval-report.mjs <current.json> [--baseline b.json] [--out report.html] [--threshold 0.15]'); process.exit(2); }
  const cur = JSON.parse(await fs.readFile(curPath, 'utf8'));
  const base = basePath ? JSON.parse(await fs.readFile(basePath, 'utf8')) : null;
  const html = renderReport(cur, base, { threshold });
  const target = out ?? path.join(path.dirname(path.resolve(curPath)), 'report.html');
  await fs.writeFile(target, html);
  console.log(target);
}
