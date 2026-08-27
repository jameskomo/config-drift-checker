#!/usr/bin/env node
// eval-shim — runs a `claude plugin eval` suite (evals/<case>/prompt.md + graders/*.md)
// without the early-access gate, by driving `claude -p` directly.
//
//   node tools/eval-shim.mjs <plugin-dir> [--case <glob>] [--runs n] [--model m]
//        [--judge-model m] [--ablation none|with-without] [--json <path>]
//        [--output-dir <dir>] [--eval-dir <dir>] [--scaffold] [--no-isolate] [--no-safety-net] [--verbose]
//        [--regrade <aggregate-result.json>] [--regrade-llm]   re-score saved runs with the current graders (no agent calls;
//                                                          llm graders keep their saved verdict unless --regrade-llm)
//
// Safety net: every run (both arms) gets a PreToolUse hook (tools/safety-net.mjs) that blocks host-global
// destructive commands (docker compose down -v, prune, git push --force, rm -rf outside ws, DROP DATABASE…).
// Cases that must run such a command stub the binary in <ws>/.eval-bin/ from scaffold_script.
//
// Output: <plugin>/evals/results/<timestamp>/aggregate-result.json (official v1 shape, plus shim:true).
// Supported graders: regex, tool_used, file_exists, llm. tool_order/baseline are recorded as skipped.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderReport } from './eval-report.mjs';

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { case: null, runs: null, model: 'sonnet', judgeModel: 'haiku', ablation: 'with-without', json: null, outputDir: null, isolate: true, verbose: false, scaffold: false, evalDir: null, safetyNet: true, regrade: null, regradeLlm: false };
let pluginDir = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === '--case') opt.case = next();
  else if (a === '--runs') opt.runs = Number(next());
  else if (a === '--model') opt.model = next();
  else if (a === '--judge-model') opt.judgeModel = next();
  else if (a === '--ablation') opt.ablation = next();
  else if (a === '--json') opt.json = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : '-';
  else if (a === '--output-dir') opt.outputDir = next();
  else if (a === '--no-isolate') opt.isolate = false;
  else if (a === '--scaffold') opt.scaffold = true;
  else if (a === '--eval-dir') opt.evalDir = next();
  else if (a === '--no-safety-net') opt.safetyNet = false;
  else if (a === '--regrade') opt.regrade = path.resolve(next());
  else if (a === '--regrade-llm') opt.regradeLlm = true;
  else if (a === '--verbose') opt.verbose = true;
  else if (!a.startsWith('--')) pluginDir = path.resolve(a);
  else die(`unknown option ${a}`);
}
if (!pluginDir) die('usage: eval-shim.mjs <plugin-dir> [options]');
function die(m) { console.error(m); process.exit(1); }
const log = (...m) => { if (opt.json !== '-') console.error(...m); };

// ---------- tiny YAML-subset frontmatter parser ----------
function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    if (v === '|' || v === '>') { // block scalar
      const buf = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) buf.push(lines[++i].replace(/^\s{2}/, ''));
      meta[k] = buf.join(v === '|' ? '\n' : ' ');
      continue;
    }
    meta[k] = parseScalar(v);
  }
  return { meta, body: m[2].trim() };
}
function parseScalar(v) {
  v = v.trim();
  if (v === '') return '';
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => parseScalar(s)).filter((s) => s !== '');
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true; if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ---------- load suite ----------
const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
const pluginName = manifest.name;
const evalDir = path.join(pluginDir, opt.evalDir ?? manifest.experimental?.evals ?? 'evals');
if (!existsSync(evalDir)) die(`no eval dir at ${evalDir} (flag --eval-dir, manifest experimental.evals, or evals/)`);
const cases = [];
for (const d of (await fs.readdir(evalDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !['results', 'mocks'].includes(e.name))) {
  const promptPath = path.join(evalDir, d.name, 'prompt.md');
  if (!existsSync(promptPath)) continue;
  if (opt.case && !globToRe(opt.case).test(d.name)) continue;
  const { meta, body } = parseFrontmatter(await fs.readFile(promptPath, 'utf8'));
  const graders = [];
  const gdir = path.join(evalDir, d.name, 'graders');
  if (existsSync(gdir)) for (const g of (await fs.readdir(gdir)).filter((f) => f.endsWith('.md')).sort()) {
    const { meta: gm, body: gb } = parseFrontmatter(await fs.readFile(path.join(gdir, g), 'utf8'));
    graders.push({ name: g.replace(/\.md$/, ''), rubric: gb, ...gm });
  }
  let scaffoldScript = null;
  const casePath = path.join(evalDir, d.name, 'case.yaml');
  if (existsSync(casePath)) { const m = (await fs.readFile(casePath, 'utf8')).match(/scaffold_script:\s*\|\s*\n((?:[ \t]+.*\n?)+)/); if (m) scaffoldScript = m[1].replace(/^[ \t]+/gm, ''); }
  cases.push({ scaffoldScript, dir: d.name, name: meta.name ?? d.name, tags: meta.tags ?? [], runs: opt.runs ?? meta.runs ?? 3, maxTurns: meta.max_turns ?? 10, timeout: (meta.timeout_seconds ?? 300) * 1000, allowedTools: meta.allowed_tools ?? [], model: opt.model ?? meta.model, prompt: body, graders });
}
if (!cases.length) die('No eval cases found');
function globToRe(g) { const alts = g.replace(/^\{(.*)\}$/, '$1').split(',').map((x) => x.trim()).filter(Boolean); return new RegExp('^(?:' + alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')).join('|') + ')$'); } // supports a,b and {a,b}

// ---------- isolated config (mirrors the official sandbox: fresh CLAUDE_CONFIG_DIR + creds copied in) ----------
const userConfig = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const SAFETY_NET = path.join(path.dirname(new URL(import.meta.url).pathname), 'safety-net.mjs');
async function makeConfigDir() {
  if (!opt.isolate) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-shim-cfg-'));
  for (const f of ['.credentials.json']) if (existsSync(path.join(userConfig, f))) await fs.copyFile(path.join(userConfig, f), path.join(dir, f));
  const settings = { hasCompletedOnboarding: true, theme: 'dark' };
  if (opt.safetyNet) settings.hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${JSON.stringify(SAFETY_NET)}` }] }] };
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

// ---------- one agent run ----------
async function runAgent(c, arm) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `eval-shim-ws-${c.dir}-`));
  if (c.scaffoldScript) {
    if (!opt.scaffold) log(`    (scaffold_script present but --scaffold not given: skipping)`);
    else { const r = await exec('bash', ['-euo', 'pipefail', '-c', c.scaffoldScript], { cwd: ws, env: { ...process.env, EVAL_PLUGIN_ROOT: pluginDir, EVAL_CASE: c.dir }, timeout: 120_000 }); if (r.code !== 0) log(`    scaffold failed: ${r.stderr.slice(-300)}`); }
  }
  const before = await snapshot(ws);
  const cfg = await makeConfigDir();
  const args = ['-p', c.prompt, '--output-format', 'stream-json', '--verbose', '--setting-sources', opt.safetyNet && cfg ? 'user' : '', '--permission-mode', 'dontAsk', '--max-turns', String(c.maxTurns), '--model', c.model];
  if (arm === 'with') args.push('--plugin-dir', pluginDir);
  if (c.allowedTools.length) args.push('--allowedTools', ...c.allowedTools);
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete env.ANTHROPIC_MODEL;
  if (existsSync(path.join(ws, '.eval-bin'))) env.PATH = path.join(ws, '.eval-bin') + path.delimiter + (env.PATH ?? '');
  if (cfg) env.CLAUDE_CONFIG_DIR = cfg;
  const t0 = Date.now();
  const { stdout, stderr, code, timedOut } = await exec('claude', args, { cwd: ws, env, timeout: c.timeout });
  const events = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const texts = [], toolUses = [];
  let result = null;
  for (const e of events) {
    if (e.type === 'assistant') for (const b of e.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) texts.push(b.text);
      if (b.type === 'tool_use') toolUses.push({ tool: b.name, input: b.input });
    }
    if (e.type === 'result') result = e;
  }
  const after = await snapshot(ws);
  const files = [...after.keys()].filter((f) => !before.has(f) || before.get(f) !== after.get(f)); // created or modified by the agent
  const fileContents = {};
  for (const f of files) { try { const s = await fs.stat(path.join(ws, f)); if (s.size < 200_000) fileContents[f] = await fs.readFile(path.join(ws, f), 'utf8'); } catch {} }
  if (cfg) await fs.rm(cfg, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
  return { lastMessage: texts.length ? texts.join('\n\n') : (result?.result ?? ''), finalMessage: result?.result ?? texts.at(-1) ?? '', texts, toolUses, files, fileContents, trace: events, costUsd: result?.total_cost_usd ?? null, inputTokens: result?.usage?.input_tokens ?? null, outputTokens: result?.usage?.output_tokens ?? null, numTurns: result?.num_turns ?? null, isError: !result || !!result.is_error, truncated: !!result && !result.is_error && (code !== 0 || String(result.subtype ?? '').startsWith('error_max_turns')), resultSubtype: result?.subtype ?? null, exitCode: code, timedOut, durationMs: Date.now() - t0, stderr: stderr.slice(-2000), rawTail: result ? '' : stdout.slice(-1500), model: result?.modelUsage ? Object.keys(result.modelUsage)[0] : c.model };
}
async function snapshot(dir) {
  const m = new Map();
  for (const f of await walk(dir)) { try { const s = await fs.stat(path.join(dir, f)); m.set(f, `${s.size}:${Math.round(s.mtimeMs)}`); } catch {} }
  return m;
}
async function walk(dir, rel = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r))); else out.push(r);
  }
  return out;
}
function exec(cmd, args, { cwd, env, timeout, input }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    p.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code, timedOut }); });
    if (input) p.stdin.write(input); p.stdin.end();
  });
}

// ---------- graders ----------
function targetText(g, run) {
  const t = g.target ?? 'last_message';
  if (t === 'last_message') return run.lastMessage; // all assistant text for the run (robust to sub-agent chatter); 'final_message' = the closing message only
  if (t === 'final_message') return run.finalMessage;
  if (t === 'trace') return run.trace.map((e) => JSON.stringify(e)).join('\n');
  if (t === 'files') return Object.entries(run.fileContents).map(([f, c]) => `### ${f}\n${c}`).join('\n\n'); // changed/created files only
  return run.lastMessage;
}
async function grade(g, run, arm, ablating) {
  const armScoped = (g.arm === 'with' || g.arm === 'without') && g.arm !== arm;
  const base = { name: g.name, type: g.type, scored: !armScoped, withOnly: false, armOnly: armScoped ? g.arm : undefined };
  if (g.type === 'regex') {
    const re = new RegExp(String(g.pattern), String(g.flags ?? '') + (String(g.flags ?? '').includes('s') ? '' : 's'));
    const txt = targetText(g, run);
    const mode = String(g.match ?? 'contains');
    let pass;
    if (mode === 'contains') pass = re.test(txt);
    else if (mode === 'not_contains') pass = !re.test(txt);
    else if (mode.startsWith('count:')) pass = (txt.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length >= Number(mode.slice(6));
    else pass = re.test(txt);
    return { ...base, score: pass ? 1 : 0, verdict: pass ? 'pass' : 'fail' };
  }
  if (g.type === 'tool_used') {
    const im = g.input_match ? new RegExp(String(g.input_match), 's') : null;
    const n = run.toolUses.filter((u) => u.tool === g.tool && (!im || im.test(typeof u.input === 'string' ? u.input : JSON.stringify(u.input)))).length;
    const max = g.max, min = g.min ?? (max === 0 ? 0 : 1);
    const pass = n >= min && (max === undefined || n <= max);
    const withOnly = g.tool === 'Skill' && g.arm !== 'both';
    return { ...base, score: pass ? 1 : 0, verdict: pass ? 'pass' : 'fail', count: n, withOnly, scored: base.scored && !(ablating && withOnly) };
  }
  if (g.type === 'file_exists') {
    const re = globToRe(String(g.path));
    const pass = run.files.some((f) => re.test(f));
    return { ...base, score: pass ? 1 : 0, verdict: pass ? 'pass' : 'fail' };
  }
  if (g.type === 'llm') {
    const txt = targetText(g, run);
    const judgePrompt = `You are grading an AI coding agent's output against a rubric. Reply with ONLY a JSON object: {"pass": true|false, "reason": "<one sentence>"}. If the output under test does not actually contain the artifact the criteria describe (e.g. no code, only commentary), answer pass=false.\n\nCRITERIA:\n${g.criteria ?? ''}\n\nRUBRIC NOTES:\n${g.rubric}\n\nOUTPUT UNDER TEST:\n<<<\n${txt.slice(0, 60_000)}\n>>>`;
    const cfg = await makeConfigDir();
    const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }; if (cfg) env.CLAUDE_CONFIG_DIR = cfg;
    const { stdout } = await exec('claude', ['-p', judgePrompt, '--output-format', 'json', '--setting-sources', '', '--permission-mode', 'dontAsk', '--max-turns', '1', '--model', opt.judgeModel, '--disallowedTools', 'Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Skill', 'Task'], { cwd: os.tmpdir(), env, timeout: 120_000 });
    if (cfg) await fs.rm(cfg, { recursive: true, force: true });
    let verdict = { pass: false, reason: 'judge produced no parseable verdict' };
    try { const r = JSON.parse(stdout).result ?? ''; const m = r.match(/\{[\s\S]*\}/); if (m) verdict = JSON.parse(m[0]); } catch {}
    return { ...base, score: verdict.pass ? 1 : 0, verdict: verdict.pass ? 'pass' : 'fail', reason: verdict.reason };
  }
  return { ...base, score: null, verdict: 'skipped', scored: false, reason: `grader type ${g.type} not supported by shim` };
}

// ---------- regrade support ----------
const regradeSource = opt.regrade ? JSON.parse(await fs.readFile(opt.regrade, 'utf8')) : null;
if (regradeSource && regradeSource.cases?.some((x) => x.arms?.without?.length)) opt.ablation = 'with-without';
function fromSaved(r) {
  const toolUses = (r.toolUses ?? []).map((u) => ({ tool: u.tool, input: (() => { try { return JSON.parse(u.input); } catch { return u.input; } })() }));
  return { lastMessage: r.response ?? '', finalMessage: r.response ?? '', texts: [r.response ?? ''], toolUses, files: r.filesChanged ?? [], fileContents: r.fileContents ?? {}, trace: [], costUsd: 0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, numTurns: r.numTurns, isError: r.isError, timedOut: r.timedOut, durationMs: r.durationMs, stderr: '', model: r.model };
}

// ---------- drive ----------
const ablating = opt.ablation === 'with-without';
const arms = ablating ? ['with', 'without'] : ['with'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = opt.outputDir ?? path.join(evalDir, 'results', stamp);
await fs.mkdir(outDir, { recursive: true });
log(`eval-shim: ${pluginName} · ${cases.length} case(s) · arms=${arms.join(',')} · model=${opt.model} · judge=${opt.judgeModel}${opt.regrade ? ' · REGRADE of ' + path.basename(path.dirname(opt.regrade)) : ''}`);
const report = { schemaVersion: '1', shim: true, generatedAt: new Date().toISOString(), regradeOf: opt.regrade ?? undefined, suite: { name: pluginName, caseCount: cases.length, baselineOnly: false }, cases: [], aggregates: {} };
let totalCost = 0, erroredRuns = 0, truncatedRuns = 0, firstError = null;
for (const c of cases) {
  const entry = { name: c.name, dir: c.dir, tags: c.tags, arms: {}, summary: {} };
  for (const arm of arms) {
    entry.arms[arm] = [];
    const saved = opt.regrade ? (regradeSource.cases.find((x) => (x.dir ?? x.name) === c.dir)?.arms?.[arm] ?? []) : null;
    if (saved && !saved.length) { delete entry.arms[arm]; continue; }
    const nRuns = saved ? saved.length : c.runs;
    for (let i = 0; i < nRuns; i++) {
      log(`  ▸ ${c.dir} [${arm}] ${saved ? 'regrade' : 'run'} ${i + 1}/${nRuns} …`);
      const run = saved ? fromSaved(saved[i]) : await runAgent(c, arm);
      const graders = [];
      for (const g of c.graders) {
        if (saved && g.type === 'llm' && !opt.regradeLlm) { const prev = saved[i].graders?.find((x) => x.name === g.name); graders.push(prev ? { ...prev, regraded: false } : { name: g.name, type: g.type, score: null, verdict: 'skipped', scored: false, reason: 'no saved verdict; use --regrade-llm' }); continue; }
        graders.push(await grade(g, run, arm, ablating));
      }
      const scored = graders.filter((g) => g.scored && g.score !== null);
      const score = run.isError ? null : (scored.length ? scored.reduce((s, g) => s + g.score, 0) / scored.length : null);
      if (run.isError) { erroredRuns++; if (!firstError) firstError = (run.lastMessage || run.stderr || run.rawTail || `claude exited ${run.exitCode} with no output`).trim().slice(0, 300); }
      totalCost += run.costUsd ?? 0;
      entry.arms[arm].push({ runIndex: i, score, graders, costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens, numTurns: run.numTurns, durationMs: run.durationMs, model: run.model, isError: run.isError, truncated: run.truncated, resultSubtype: run.resultSubtype, timedOut: run.timedOut, toolUses: run.toolUses.map((u) => ({ tool: u.tool, input: typeof u.input === 'string' ? u.input : JSON.stringify(u.input).slice(0, 500) })), prompt: c.prompt, response: run.lastMessage, filesChanged: run.files, fileContents: run.fileContents, stderrTail: run.isError ? (run.stderr || run.rawTail || `exit ${run.exitCode}, no output`) : undefined, exitCode: run.exitCode });
      if (run.isError) log(`    ERROR (exit ${run.exitCode}): ${(run.lastMessage || run.stderr || run.rawTail || 'no output').trim().slice(0, 300)}`);
      if (run.truncated) { truncatedRuns++; log(`    TRUNCATED (${run.resultSubtype || 'exit ' + run.exitCode}, ${run.numTurns} turns): scored as-is — raise max_turns for this case`); }
      log(`    score=${fmt(score)}  ${graders.map((g) => `${g.verdict === 'pass' ? '✓' : g.verdict === 'fail' ? '✗' : '·'}${g.name}${g.scored ? '' : '(ind)'}`).join(' ')}`);
    }
  }
  if (opt.regrade && !Object.keys(entry.arms).length) { log(`  ▸ ${c.dir}: no saved runs in source — skipped`); continue; }
  const mean = (arr) => arr.filter((x) => x !== null).length ? arr.filter((x) => x !== null).reduce((a, b) => a + b, 0) / arr.filter((x) => x !== null).length : null;
  entry.summary.score = mean((entry.arms.with ?? []).map((r) => r.score));
  if (ablating && entry.arms.without) { entry.summary.baselineScore = mean(entry.arms.without.map((r) => r.score)); entry.summary.delta = entry.summary.score !== null && entry.summary.baselineScore !== null ? entry.summary.score - entry.summary.baselineScore : null; }
  entry.summary.costUsd = Object.values(entry.arms).flat().reduce((s, r) => s + (r.costUsd ?? 0), 0);
  report.cases.push(entry);
}
const withScores = report.cases.map((c) => c.summary.score).filter((s) => s !== null);
const totalRuns = report.cases.reduce((n, c) => n + Object.values(c.arms).flat().length, 0);
report.aggregates = { overallScore: withScores.length ? withScores.reduce((a, b) => a + b, 0) / withScores.length : null, passed: report.cases.filter((c) => c.summary.score === 1).length, failed: report.cases.filter((c) => c.summary.score !== null && c.summary.score !== 1).length, costUsd: totalCost, erroredRuns, truncatedRuns, totalRuns, partialReason: erroredRuns ? `${erroredRuns} of ${totalRuns} agent runs errored: ${firstError}` : null };
const outPath = path.join(outDir, 'aggregate-result.json');
await fs.writeFile(outPath, JSON.stringify(report, null, 2));
await fs.writeFile(path.join(outDir, 'report.html'), renderReport(report));
if (opt.json === '-') process.stdout.write(JSON.stringify(report, null, 2));
else if (opt.json) await fs.writeFile(opt.json, JSON.stringify(report, null, 2));

log('\n' + pad('case', 44) + pad('with', 8) + (ablating ? pad('without', 9) + pad('delta', 8) : '') + 'cost');
for (const c of report.cases) log(pad(c.dir, 44) + pad(fmt(c.summary.score), 8) + (ablating ? pad(fmt(c.summary.baselineScore), 9) + pad(fmtDelta(c.summary.delta), 8) : '') + `$${c.summary.costUsd.toFixed(3)}`);
log(`\noverall=${fmt(report.aggregates.overallScore)} passed=${report.aggregates.passed}/${cases.length} cost=$${totalCost.toFixed(3)}${erroredRuns ? `\nERRORED RUNS: ${report.aggregates.partialReason}` : ''}${truncatedRuns ? `\nTRUNCATED RUNS: ${truncatedRuns} hit max_turns — scored as-is; raise max_turns on those cases` : ''}\n→ ${outPath}\n→ ${path.join(outDir, 'report.html')}`);
if (erroredRuns === totalRuns && totalRuns > 0) process.exitCode = 2; // nothing ran: partial, like the official runner
function fmt(s) { return s === null || s === undefined ? '—' : s.toFixed(2); }
function fmtDelta(d) { return d === null || d === undefined ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2); }
function pad(s, n) { return String(s).padEnd(n); }
