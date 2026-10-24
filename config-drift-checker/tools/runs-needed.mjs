#!/usr/bin/env node
// runs-needed: how many runs each eval case needs before its green means something.
//
//   node tools/runs-needed.mjs <results-dir> --config <plugin-dir> [--track pinned|canary] [--threshold 0.15]
//        [--limit N] [--write] [--json <out>|-] [--md <out>|-]
//
// <results-dir> holds past results: the results branch's history/ (*.json), or the runner's own
// evals/results/ (<stamp>/aggregate-result.json). For each case on disk under <plugin-dir> it pools
// the run-to-run spread of the with-arm scores inside each result, then asks: with that spread, how
// many runs per side does it take to catch a drop of the score threshold 8 times in 10 (one-sided 5%,
// normal approximation)? The answer is floored at baseline.min_runs and capped at 20.
//
// Dry by default. --write sets `runs: N` in the frontmatter of each case's prompt.md where N is more
// than it runs today (it only ever raises; lowering is your call). A `runs:` on the .cdc.yml track
// overrides every prompt.md, and the Action's `runs` input overrides both; the output says so.
// Exit 0 on success, 2 on a usage error.
import { promises as fs, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory, normalizeResult, caseMap, resolveThresholds, withRuns } from './eval-classify.mjs';
import { spread, runsNeeded, shortLine, RUNS_CAP } from './eval-stats.mjs';

const DEFAULT_RUNS = 3; // the runners' default when nothing sets runs

// Past results, newest first: flat *.json (history/) plus <dir>/*/aggregate-result.json (evals/results/).
export async function loadResults(dir, { track = null, limit = 10 } = {}) {
  const flat = await loadHistory(dir, { track, limit: Infinity });
  const nested = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const p = path.join(dir, e.name, 'aggregate-result.json');
    if (!existsSync(p)) continue;
    try { const j = normalizeResult(JSON.parse(readFileSync(p, 'utf8'))); if (!(track && j.track && j.track !== track)) nested.push(j); } catch { /* not evidence */ }
  }
  return [...flat, ...nested].sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? ''))).slice(0, limit);
}

const frontmatter = (text) => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null;
export const runsOf = (text) => { const m = (frontmatter(text) ?? '').match(/^runs:[ \t]*(\d+)[ \t]*(?:#.*)?$/m); return m ? Number(m[1]) : null; };

// Set `runs: n` in prompt.md frontmatter, keeping every other line as it was.
export function setRuns(text, n) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const fm = frontmatter(text);
  if (fm === null) return `---${nl}runs: ${n}${nl}---${nl}${text}`;
  const next = /^runs:.*$/m.test(fm) ? fm.replace(/^runs:.*$/m, `runs: ${n}`) : `${fm}${nl}runs: ${n}`;
  return text.replace(fm, () => next);
}

export async function plan(resultsDir, pluginDir, { track = null, threshold = null, limit = null } = {}) {
  const { cfg, th, minBaselineRuns, historyRuns } = resolveThresholds(pluginDir, track, { threshold });
  const trackName = cfg?.track ?? track ?? 'pinned';
  const results = await loadResults(resultsDir, { track: trackName, limit: limit ?? historyRuns });
  const maps = results.map(caseMap);
  const manifest = (() => { try { return JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8')); } catch { return {}; } })();
  const evalDir = path.join(pluginDir, manifest.experimental?.evals ?? 'evals');
  const dirs = existsSync(evalDir) ? readdirSync(evalDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !['results', 'mocks'].includes(e.name) && existsSync(path.join(evalDir, e.name, 'prompt.md'))).map((e) => e.name).sort() : [];
  const trackRuns = cfg?.runs ?? null;
  const rows = dirs.map((dir) => {
    const promptPath = path.join(evalDir, dir, 'prompt.md');
    const declared = runsOf(readFileSync(promptPath, 'utf8'));
    const runs = trackRuns ?? declared ?? DEFAULT_RUNS;
    const groups = maps.map((m) => m.get(dir)).filter(Boolean).map((c) => withRuns(c).map((r) => r.score).filter((s) => typeof s === 'number'));
    const sp = spread(groups);
    const need = runsNeeded(sp.sd, th.score, { floor: minBaselineRuns });
    return { case: dir, promptPath, declared, runs, runsFrom: trackRuns !== null ? `.cdc.yml ${trackName}` : declared !== null ? 'prompt.md' : 'default', sd: sp.sd, samples: sp.samples, results: groups.filter((g) => g.length).length,
      needed: need?.needed ?? null, capped: need?.capped ?? false, raw: need?.raw ?? null, short: need ? runs < need.needed : null };
  });
  return { schemaVersion: 1, tool: 'runs-needed', plugin: path.basename(path.resolve(pluginDir)), track: trackName, threshold: th.score, floor: minBaselineRuns, cap: RUNS_CAP, results: results.length, trackRuns, rows };
}

export async function write(p) {
  const changed = [];
  for (const r of p.rows) {
    const today = r.declared ?? DEFAULT_RUNS;
    if (r.needed === null || r.needed <= today) continue;
    const text = await fs.readFile(r.promptPath, 'utf8');
    await fs.writeFile(r.promptPath, setRuns(text, r.needed));
    changed.push({ case: r.case, from: r.declared, to: r.needed });
  }
  return changed;
}

const f2 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2));
const verdict = (r) => (r.needed === null ? 'no history' : r.short ? 'too few' : 'enough');

export function format(p, { md = false, written = null } = {}) {
  const lines = [];
  const head = `${p.plugin}, ${p.track} track, score threshold ${p.threshold}, from ${p.results} past result${p.results === 1 ? '' : 's'}`;
  const short = p.rows.filter((r) => r.short);
  const notes = short.map((r) => shortLine(r.case, { current: r.runs, needed: r.needed, raw: r.raw, capped: r.capped }, p.threshold));
  if (p.trackRuns !== null) notes.push(`.cdc.yml sets runs: ${p.trackRuns} on the ${p.track} track, which overrides every prompt.md; raise it there (or pass the Action's runs input) for these numbers to take effect`);
  if (md) {
    lines.push(`### Runs needed: ${head}`, '', '| case | runs today | spread | samples | needs | |', '|---|---:|---:|---:|---:|---|',
      ...p.rows.map((r) => `| ${r.case} | ${r.runs} | ${f2(r.sd)} | ${r.samples} | ${r.needed ?? 'n/a'}${r.capped ? '+' : ''} | ${verdict(r)} |`));
    if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
    lines.push('', `<sub>Needs: runs per case to catch a ${p.threshold} score drop 8 times in 10 at the spread seen so far (at least ${p.floor}, at most ${p.cap}). Spread: the typical run-to-run difference in score within one result.</sub>`);
    return lines.join('\n') + '\n';
  }
  const w = Math.max(4, ...p.rows.map((r) => r.case.length));
  lines.push(`runs-needed: ${head}`, `  ${'case'.padEnd(w)}  runs  spread  samples  needs`);
  for (const r of p.rows) lines.push(`  ${r.case.padEnd(w)}  ${String(r.runs).padStart(4)}  ${f2(r.sd).padStart(6)}  ${String(r.samples).padStart(7)}  ${(String(r.needed ?? 'n/a') + (r.capped ? '+' : '')).padStart(5)}  ${verdict(r)}`);
  for (const n of notes) lines.push(`  ${n}`);
  if (written === null) lines.push(short.length ? '  dry run: nothing written. --write sets runs: in each short case\'s prompt.md (it only raises).' : '  every case with history runs often enough.');
  else lines.push(written.length ? `  wrote ${written.map((c) => `${c.case} runs: ${c.from ?? DEFAULT_RUNS} to ${c.to}`).join(', ')}` : '  nothing to write.');
  return lines.join('\n') + '\n';
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = 'usage: runs-needed.mjs <results-dir> --config <plugin-dir> [--track pinned|canary] [--threshold 0.15] [--limit N] [--write] [--json <out>|-] [--md <out>|-]';
  const argv = process.argv.slice(2), opt = { dir: null, config: null, track: null, threshold: null, limit: null, write: false, json: null, md: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (x === undefined) { console.error(usage); process.exit(2); } return x; };
    if (a === '--config') opt.config = path.resolve(v()); else if (a === '--track') opt.track = v();
    else if (a === '--threshold') opt.threshold = Number(v()); else if (a === '--limit') opt.limit = Number(v());
    else if (a === '--write') opt.write = true; else if (a === '--json') opt.json = v(); else if (a === '--md') opt.md = v();
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('--') && !opt.dir) opt.dir = path.resolve(a);
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  if (!opt.dir || !opt.config) { console.error(usage); process.exit(2); }
  if (!existsSync(opt.dir)) { console.error(`runs-needed: ${opt.dir} does not exist`); process.exit(2); }
  let p;
  try { p = await plan(opt.dir, opt.config, opt); } catch (e) { console.error(`runs-needed: ${e.message}`); process.exit(2); }
  const written = opt.write ? await write(p) : null;
  const emit = async (target, text) => { if (target === '-') process.stdout.write(text); else await fs.writeFile(target, text); };
  if (opt.json !== '-' && opt.md !== '-') process.stdout.write(format(p, { written }));
  if (opt.json) await emit(opt.json, JSON.stringify({ ...p, rows: p.rows.map(({ promptPath: _p, ...r }) => r), written }, null, 2) + '\n');
  if (opt.md) await emit(opt.md, format(p, { md: true, written }));
}
