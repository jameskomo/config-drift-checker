#!/usr/bin/env node
// context-cost: how many tokens your setup adds to every Claude Code session, per release, and how that moved.
//
//   node tools/context-cost.mjs <plugin-dir> [--runner <path-to-claude>] [--no-official] [--claude-md <path>]
//        [--store <dir>] [--json <out>|-] [--md <out>|-]
//   node tools/context-cost.mjs --history <dir> [--json <out>|-] [--md <out>|-]
//
// Every session pays for the names and descriptions of your skills, agents and commands (always-on), plus
// CLAUDE.md. A skill's or agent's full body is paid again each time it fires (on-invoke). A Claude Code
// release can change what it puts in context, so the same files can cost more on a new version. Two layers:
//
//   1. Estimate (always, free, no Claude needed): walk the plugin dir and count characters / 4 for each
//      component. Labelled "estimate" everywhere it shows.
//   2. Official (when a Claude Code binary is found: --runner, else `claude` on PATH): `claude plugin details
//      <name>`, which prints the component inventory and projected token cost (2.1.275 and later). The plugin
//      is loaded with `--plugin-dir <dir>` (falling back to a skills-dir link) under a throwaway
//      CLAUDE_CONFIG_DIR and HOME with no credentials, so the real user's ~/.claude is never read or written
//      and no model is called. If the command is missing or fails, the estimate is used and the output says why.
//
// --store <dir> writes the measurement as <dir>/<stamp>-cc<version>.json (the eval-dashboard reads
// <history-dir>/context-cost/ and draws a "Context cost per release" strip when such files exist).
// --history <dir> reads those files and reports the trend: one point per Claude Code release, the change
// between consecutive releases, and the components that moved most.
// Exit 0 on success, 2 on a usage error.
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './skill-lint.mjs';
import { findRunner } from './suite-doctor.mjs';

export const SCHEMA_VERSION = 1;
export const estimateTokens = (text) => Math.round(String(text ?? '').length / 4);

// ---------- layer 1: the static estimate ----------
const readIf = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const listRefs = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const mdFiles = (dir) => (isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f)) : []);

// A manifest path entry is a skill dir (has SKILL.md) or a dir of skill dirs; without entries, skills/*/SKILL.md.
function skillFiles(root, manifest) {
  const refs = listRefs(manifest?.skills);
  const dirs = refs.length ? refs.map((r) => path.resolve(root, r)) : [path.join(root, 'skills')];
  const out = [];
  for (const d of dirs) {
    if (existsSync(path.join(d, 'SKILL.md'))) out.push(path.join(d, 'SKILL.md'));
    else if (isDir(d)) for (const e of readdirSync(d).sort()) if (existsSync(path.join(d, e, 'SKILL.md'))) out.push(path.join(d, e, 'SKILL.md'));
  }
  return [...new Set(out)];
}
// agents and commands: manifest entries are .md files or dirs of them; without entries, agents/ and commands/
function componentFiles(root, manifest, key) {
  const refs = listRefs(manifest?.[key]);
  if (!refs.length) return mdFiles(path.join(root, key));
  return [...new Set(refs.flatMap((r) => { const p = path.resolve(root, r); return isDir(p) ? mdFiles(p) : p.endsWith('.md') && existsSync(p) ? [p] : []; }))];
}
const hookEvents = (obj) => Object.keys(obj?.hooks ?? obj ?? {}).filter((k) => k !== 'description');
const jsonIf = (p) => { const t = readIf(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };

export function estimate(pluginDir, { claudeMd = null } = {}) {
  const root = path.resolve(pluginDir);
  if (!isDir(root)) throw new Error(`${pluginDir} is not a directory`);
  const manifestPath = path.join(root, '.claude-plugin/plugin.json');
  const manifest = jsonIf(manifestPath) ?? {};
  const read = []; // [rel, text] of every file the estimate depends on, for the fingerprint
  const take = (p) => { const t = readIf(p); if (t !== null) read.push([path.relative(root, p) || path.basename(p), t]); return t; };
  if (existsSync(manifestPath)) take(manifestPath);
  const components = [];
  const fmText = (fm, k) => (fm.fields[k]?.value ?? '').trim();
  for (const f of skillFiles(root, manifest)) {
    const fm = parseFrontmatter(take(f));
    const name = fmText(fm, 'name') || path.basename(path.dirname(f));
    components.push({ kind: 'skill', name, alwaysOn: estimateTokens(name + fmText(fm, 'description')), onInvoke: estimateTokens(fm.body.trim()), file: path.relative(root, f) });
  }
  for (const [key, kind] of [['agents', 'agent'], ['commands', 'command']]) {
    for (const f of componentFiles(root, manifest, key)) {
      const fm = parseFrontmatter(take(f));
      const name = (kind === 'agent' && fmText(fm, 'name')) || path.basename(f, '.md');
      components.push({ kind, name, alwaysOn: estimateTokens(name + fmText(fm, 'description')), onInvoke: estimateTokens(fm.body.trim()), file: path.relative(root, f) });
    }
  }
  const cm = claudeMd ? path.resolve(claudeMd) : path.join(root, 'CLAUDE.md');
  const cmText = take(cm);
  if (cmText !== null) components.push({ kind: 'claude-md', name: path.relative(root, cm) || 'CLAUDE.md', alwaysOn: estimateTokens(cmText), onInvoke: 0, file: path.relative(root, cm),
    note: 'loaded in full every session when this dir is the project' });
  // hooks run in the harness; a SessionStart hook can print into context, which no static count can see
  let hooks = typeof manifest.hooks === 'object' && manifest.hooks ? manifest.hooks : null;
  if (!hooks) { const hp = typeof manifest.hooks === 'string' ? path.resolve(root, manifest.hooks) : path.join(root, 'hooks/hooks.json'); if (existsSync(hp)) { take(hp); hooks = jsonIf(hp); } }
  for (const ev of hookEvents(hooks)) components.push({ kind: 'hook', name: ev, alwaysOn: 0, onInvoke: 0,
    note: ev === 'SessionStart' ? 'harness only, but its output can be added to context' : 'harness only, no model context cost' });
  let mcp = typeof manifest.mcpServers === 'object' && manifest.mcpServers ? manifest.mcpServers : null;
  if (!mcp) { const mp = typeof manifest.mcpServers === 'string' ? path.resolve(root, manifest.mcpServers) : path.join(root, '.mcp.json'); if (existsSync(mp)) { take(mp); const j = jsonIf(mp); mcp = j?.mcpServers ?? j; } }
  for (const name of Object.keys(mcp ?? {})) components.push({ kind: 'mcp', name, alwaysOn: null, onInvoke: null, note: 'tool listings are resolved at runtime; not counted' });
  const h = crypto.createHash('sha256');
  for (const [rel, t] of read.sort((a, b) => a[0].localeCompare(b[0]))) h.update(`${rel}\0${t}\0`);
  return { plugin: { name: typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(root), version: typeof manifest.version === 'string' ? manifest.version : null },
    components, totals: totalsOf(components), fingerprint: h.digest('hex').slice(0, 16) };
}
const sum = (xs) => xs.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
const totalsOf = (cs) => ({ alwaysOn: sum(cs.map((c) => c.alwaysOn)), onInvoke: sum(cs.map((c) => c.onInvoke)) });

// ---------- layer 2: `claude plugin details` ----------
// "~1.7k" -> 1700, "~75" -> 75, "< 20" -> 20 (an upper bound, flagged)
export function parseTokens(s) {
  const m = String(s).trim().match(/^(<\s*|~)?\s*([\d.]+)\s*([kKmM])?$/);
  if (!m) return null;
  const n = Math.round(Number(m[2]) * (m[3] ? (m[3].toLowerCase() === 'k' ? 1000 : 1e6) : 1));
  return Number.isFinite(n) ? { tokens: n, below: !!m[1] && m[1].startsWith('<') } : null;
}

// Parses the text `claude plugin details <name>` prints (2.1.275 to 2.1.295):
//   Component inventory / "  Skills (3)  a, b, c" ... / Projected token cost / "  Always-on:   ~75 tok" /
//   Per-component (rounded) / "  component  always-on  on-invoke" / "  alpha   ~30   ~50"
export function parseDetails(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = lines.find((l) => l.trim())?.trim().split(/\s+/) ?? [];
  const inventory = {};
  let section = null, alwaysOn = null;
  const components = [];
  const TOK = '(<\\s*[\\d.]+[kKmM]?|~?[\\d.]+[kKmM]?)';
  for (const l of lines) {
    const t = l.trim();
    if (/^Component inventory/.test(t)) { section = 'inv'; continue; }
    if (/^Projected token cost/.test(t)) { section = 'cost'; continue; }
    if (/^Per-component/.test(t)) { section = 'per'; continue; }
    if (section === 'inv') {
      const m = l.match(/^\s+([A-Za-z][A-Za-z ]*?) \((\d+)\)(?:\s{2,}(.*))?$/);
      if (m) {
        const [items, note] = (m[3] ?? '').split(/\s{2,}\(/);
        inventory[m[1].toLowerCase()] = { count: Number(m[2]), names: items ? items.split(',').map((s) => s.trim()).filter(Boolean) : [], note: note ? note.replace(/\)\s*$/, '') : null };
      }
    } else if (section === 'cost') {
      const m = t.match(/^Always-on:\s*(\S+(?:\s\d+)?)\s*tok/);
      if (m) alwaysOn = parseTokens(m[1]);
    } else if (section === 'per') {
      if (/^component\s+always-on\s+on-invoke/.test(t) || !t) continue;
      const m = l.match(new RegExp(`^\\s+(.+?)\\s+${TOK}\\s+${TOK}\\s*$`));
      if (m) { const a = parseTokens(m[2]), o = parseTokens(m[3]); components.push({ name: m[1], alwaysOn: a.tokens, onInvoke: o.tokens, ...(a.below || o.below ? { below: [a.below && 'alwaysOn', o.below && 'onInvoke'].filter(Boolean) } : {}) }); }
    }
  }
  if (!alwaysOn && !components.length) return null;
  return { plugin: { name: head[0] ?? null, version: head[1] ?? null }, inventory, alwaysOn: alwaysOn?.tokens ?? sum(components.map((c) => c.alwaysOn)), components };
}

// Run `plugin details` against a local dir without touching the real config: empty CLAUDE_CONFIG_DIR and
// HOME, no credentials, cwd in the temp dir. First via --plugin-dir, then via a skills-dir link.
export function officialDetails(pluginDir, name, runnerPath, { timeoutMs = 60_000 } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'context-cost-'));
  try {
    const config = path.join(work, 'config'), home = path.join(work, 'home');
    mkdirSync(config, { recursive: true }); mkdirSync(home, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    const call = (args) => { const r = spawnSync(runnerPath, args, { encoding: 'utf8', env, cwd: home, timeout: timeoutMs }); return { r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }; };
    const version = (call(['--version']).r.stdout ?? '').trim().split(/\s+/)[0] || null;
    const dir = path.resolve(pluginDir);
    let via = 'plugin-dir', { r, output } = call(['--plugin-dir', dir, 'plugin', 'details', name]);
    if (/unknown option '--plugin-dir'|not found/i.test(output) && !/unknown command 'details'/.test(output)) {
      via = 'skills-dir';
      mkdirSync(path.join(config, 'skills'), { recursive: true });
      symlinkSync(dir, path.join(config, 'skills', name), 'dir');
      ({ r, output } = call(['plugin', 'details', name]));
    }
    if (/unknown command 'details'/.test(output)) return { status: 'skipped', reason: `Claude Code ${version ?? '?'} has no \`claude plugin details\``, version, runner: runnerPath };
    const parsed = r.status === 0 ? parseDetails(r.stdout) : null;
    if (!parsed) {
      const tail = output.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || (r.error?.message ?? `exit ${r.status}`);
      return { status: 'failed', reason: `\`claude plugin details ${name}\` gave no token figures: ${tail}`, version, runner: runnerPath };
    }
    return { status: 'ok', version, runner: runnerPath, via, ...parsed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- one measurement ----------
// Official per-component figures replace the estimate for what `plugin details` counts (skills, commands,
// agents). CLAUDE.md, hooks and MCP servers stay as estimated, since plugin details does not count them.
export function measure(pluginDir, { runner = null, official = true, claudeMd = null, envPath, now = new Date() } = {}) {
  const est = estimate(pluginDir, { claudeMd });
  let off = { status: 'skipped', reason: 'official figure disabled (--no-official)' };
  if (official) {
    const found = findRunner(runner, envPath);
    off = found.path ? officialDetails(pluginDir, est.plugin.name, found.path) : { status: 'skipped', reason: found.reason };
  }
  let components, totals, source;
  if (off.status === 'ok') {
    source = 'official';
    const byName = new Map(est.components.filter((c) => ['skill', 'agent', 'command'].includes(c.kind)).map((c) => [c.name, c]));
    const agents = new Set(off.inventory?.agents?.names ?? []);
    components = off.components.map((c) => ({ kind: byName.get(c.name)?.kind ?? (agents.has(c.name) ? 'agent' : 'skill'), name: c.name, alwaysOn: c.alwaysOn, onInvoke: c.onInvoke, source: 'official', ...(c.below ? { below: c.below } : {}) }));
    const rest = est.components.filter((c) => !['skill', 'agent', 'command'].includes(c.kind)).map((c) => ({ ...c, source: 'estimate' }));
    components.push(...rest);
    totals = { alwaysOn: off.alwaysOn + sum(rest.map((c) => c.alwaysOn)), onInvoke: sum(components.map((c) => c.onInvoke)) };
  } else {
    source = 'estimate';
    components = est.components.map((c) => ({ ...c, source: 'estimate' }));
    totals = est.totals;
  }
  const { status, reason = null, version = null, via = null, alwaysOn = null, inventory = null } = off;
  return { schemaVersion: SCHEMA_VERSION, tool: 'context-cost', generatedAt: now.toISOString(), plugin: est.plugin, pluginDir: path.basename(path.resolve(pluginDir)),
    claudeVersion: version, source, totals, components, fingerprint: est.fingerprint,
    official: { status, reason, via, alwaysOn, inventory }, estimate: { totals: est.totals, components: est.components } };
}

export const storeName = (m) => `${m.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-cc${m.claudeVersion ?? 'unknown'}.json`;

// ---------- history: one point per Claude Code release ----------
export function loadHistory(dir) {
  if (!dir || !isDir(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const j = jsonIf(path.join(dir, f));
    if (j?.tool === 'context-cost' && j.totals && Array.isArray(j.components)) out.push({ ...j, file: f });
  }
  return out.sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)) || a.file.localeCompare(b.file));
}

const pctOf = (before, after) => (before ? ((after - before) / before) * 100 : null);
const change = (before, after) => ({ before, after, delta: after - before, pct: pctOf(before, after) });
const ckey = (c) => `${c.kind}:${c.name}`;

export function trend(runs, { movers = 5 } = {}) {
  const byVersion = new Map();
  for (const r of runs) byVersion.set(r.claudeVersion ?? 'unknown', r); // newest run per version, first-seen order
  const points = [...byVersion.entries()].map(([cc, r]) => ({ claudeVersion: cc, at: r.generatedAt, source: r.source, alwaysOn: r.totals.alwaysOn, onInvoke: r.totals.onInvoke, fingerprint: r.fingerprint ?? null, run: r }));
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ca = new Map(a.run.components.map((c) => [ckey(c), c])), cb = new Map(b.run.components.map((c) => [ckey(c), c]));
    const moved = [];
    for (const k of new Set([...ca.keys(), ...cb.keys()])) {
      const x = ca.get(k), y = cb.get(k), c = y ?? x;
      const dA = (y?.alwaysOn ?? 0) - (x?.alwaysOn ?? 0), dI = (y?.onInvoke ?? 0) - (x?.onInvoke ?? 0);
      if (!dA && !dI && x && y) continue;
      moved.push({ kind: c.kind, name: c.name, status: !x ? 'added' : !y ? 'removed' : 'changed', alwaysOn: change(x?.alwaysOn ?? 0, y?.alwaysOn ?? 0), onInvoke: change(x?.onInvoke ?? 0, y?.onInvoke ?? 0) });
    }
    moved.sort((p, q) => Math.abs(q.alwaysOn.delta) - Math.abs(p.alwaysOn.delta) || Math.abs(q.onInvoke.delta) - Math.abs(p.onInvoke.delta) || p.name.localeCompare(q.name));
    steps.push({ from: a.claudeVersion, to: b.claudeVersion, alwaysOn: change(a.alwaysOn, b.alwaysOn), onInvoke: change(a.onInvoke, b.onInvoke),
      comparable: a.source === b.source, sameFiles: !!a.fingerprint && a.fingerprint === b.fingerprint, movers: moved.slice(0, movers), moversTotal: moved.length });
  }
  const strip = ({ run: _r, ...p }) => p;
  const last = steps.at(-1) ?? null;
  return { schemaVersion: SCHEMA_VERSION, tool: 'context-cost-history', plugin: runs.at(-1)?.plugin ?? null, points: points.map(strip), steps, latest: points.at(-1) ? strip(points.at(-1)) : null, headline: headline(last, points.at(-1)) };
}

export const fmtPct = (p) => { if (p === null || p === undefined) return 'n/a'; const r = Math.abs(p) >= 10 ? Math.round(p) : Math.round(p * 10) / 10; return `${r > 0 ? '+' : ''}${r}%`; };
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
export function headline(step, latest) {
  if (!latest) return 'No context-cost measurements yet.';
  if (!step) return `Your setup adds about ${num(latest.alwaysOn)} tokens to every session on Claude Code ${latest.claudeVersion} (${latest.source}). One release measured so far, so no trend yet.`;
  const p = step.alwaysOn.pct, abs = p === null ? null : Math.abs(p);
  const what = p === null ? `went from nothing to ${num(step.alwaysOn.after)} always-on tokens`
    : abs < 0.5 ? `cost the same on Claude Code ${step.to} as on ${step.from}: about ${num(step.alwaysOn.after)} always-on tokens per session`
    : `got ${fmtPct(abs).replace('+', '')} ${p > 0 ? 'more expensive' : 'cheaper'} on Claude Code ${step.to}: ${num(step.alwaysOn.before)} to ${num(step.alwaysOn.after)} always-on tokens per session (was ${step.from})`;
  const why = !step.comparable ? ' The measurement source changed between these releases, so the numbers are not directly comparable.'
    : abs !== null && abs < 0.5 ? '' : step.sameFiles ? ' Your files did not change, so the difference comes from Claude Code.' : ' Your files changed too, so part of the difference is your own edits.';
  return `Your setup ${what}.${why}`;
}

// ---------- reports ----------
const tok = (n, below) => (n === null || n === undefined ? 'not counted' : `${below ? '< ' : ''}${num(n)}`);
const SOURCE_NOTE = { official: 'official, from `claude plugin details`', estimate: 'estimate, characters / 4' };

export function formatMeasure(m, { md = false } = {}) {
  const o = m.official, head = `${m.plugin.name}${m.plugin.version ? ' ' + m.plugin.version : ''}${m.claudeVersion ? ` on Claude Code ${m.claudeVersion}` : ''}`;
  const why = m.source === 'estimate' ? (o.status === 'skipped' ? `official figure skipped: ${o.reason}` : `official figure failed: ${o.reason}`) : null;
  const rows = m.components.map((c) => [c.name, c.kind, tok(c.alwaysOn, c.below?.includes('alwaysOn')), tok(c.onInvoke, c.below?.includes('onInvoke')), c.source]);
  const notes = m.components.filter((c) => c.note).map((c) => `${c.kind} ${c.name}: ${c.note}`);
  if (m.source === 'official' && m.components.some((c) => c.source === 'estimate' && c.alwaysOn)) notes.push('rows marked estimate are not counted by `claude plugin details` and are added from the static estimate');
  if (md) {
    return [`### Context cost: ${head}`, '',
      `**${tok(m.totals.alwaysOn)} tokens** added to every session (always-on), **${tok(m.totals.onInvoke)}** more across components when each fires (on-invoke). Source: ${SOURCE_NOTE[m.source]}.`,
      ...(why ? ['', `> ${why}; showing the static estimate.`] : []), '',
      '| component | kind | always-on | on-invoke | source |', '|---|---|---:|---:|---|', ...rows.map((r) => `| ${r.map((x) => String(x).replace(/\|/g, '\\|')).join(' | ')} |`),
      ...(notes.length ? ['', ...notes.map((n) => `- ${n}`)] : [])].join('\n') + '\n';
  }
  const w = [9, 4, 9, 9].map((n, i) => Math.max(n, ...rows.map((r) => String(r[i]).length)));
  return [`context-cost: ${head} (${SOURCE_NOTE[m.source]})`, ...(why ? [`  ${why}; using the static estimate`] : []),
    `  always-on: ${tok(m.totals.alwaysOn)} tokens added to every session`, `  on-invoke: ${tok(m.totals.onInvoke)} tokens across components when each fires`,
    `  ${['component', 'kind', 'always-on', 'on-invoke'].map((h, i) => (i > 1 ? h.padStart(w[i]) : h.padEnd(w[i]))).join('  ')}  source`,
    ...rows.map((r) => `  ${r.slice(0, 4).map((x, i) => (i > 1 ? String(x).padStart(w[i]) : String(x).padEnd(w[i]))).join('  ')}  ${r[4]}`),
    ...notes.map((n) => `  note: ${n}`)].join('\n') + '\n';
}

const moverLine = (mv) => `${mv.kind} ${mv.name}: ${mv.status === 'added' ? `added, ${tok(mv.alwaysOn.after)} always-on` : mv.status === 'removed' ? `removed, was ${tok(mv.alwaysOn.before)} always-on`
  : `always-on ${tok(mv.alwaysOn.before)} to ${tok(mv.alwaysOn.after)} (${fmtPct(mv.alwaysOn.pct)}), on-invoke ${tok(mv.onInvoke.before)} to ${tok(mv.onInvoke.after)} (${fmtPct(mv.onInvoke.pct)})`}`;

export function formatHistory(t, { md = false } = {}) {
  const out = [];
  if (md) {
    out.push(`### Context cost per Claude Code release${t.plugin?.name ? `: ${t.plugin.name}` : ''}`, '', t.headline, '');
    if (t.points.length) {
      out.push('| Claude Code | always-on | change | on-invoke | change | source |', '|---|---:|---:|---:|---:|---|');
      t.points.forEach((p, i) => { const s = i ? t.steps[i - 1] : null; out.push(`| ${p.claudeVersion} | ${tok(p.alwaysOn)} | ${s ? fmtPct(s.alwaysOn.pct) : ''} | ${tok(p.onInvoke)} | ${s ? fmtPct(s.onInvoke.pct) : ''} | ${p.source} |`); });
    }
    for (const s of [...t.steps].reverse().filter((x) => x.movers.length).slice(0, 3)) {
      out.push('', `**Biggest movers ${s.from} to ${s.to}**${s.sameFiles ? ' (same files)' : ''}`, '', ...s.movers.map((mv) => `- ${moverLine(mv)}`));
      if (s.moversTotal > s.movers.length) out.push(`- and ${s.moversTotal - s.movers.length} more`);
    }
    return out.join('\n') + '\n';
  }
  out.push(`context-cost history: ${t.points.length} release(s)${t.plugin?.name ? ` of ${t.plugin.name}` : ''}`, `  ${t.headline}`);
  t.points.forEach((p, i) => { const s = i ? t.steps[i - 1] : null; out.push(`  cc${p.claudeVersion}  always-on ${tok(p.alwaysOn)}${s ? ` (${fmtPct(s.alwaysOn.pct)})` : ''}  on-invoke ${tok(p.onInvoke)}${s ? ` (${fmtPct(s.onInvoke.pct)})` : ''}  ${p.source}`); });
  for (const s of [...t.steps].reverse().filter((x) => x.movers.length).slice(0, 3)) {
    out.push(`  biggest movers ${s.from} to ${s.to}${s.sameFiles ? ' (same files)' : ''}:`, ...s.movers.map((mv) => `    ${moverLine(mv)}`));
    if (s.moversTotal > s.movers.length) out.push(`    and ${s.moversTotal - s.movers.length} more`);
  }
  return out.join('\n') + '\n';
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = 'usage: context-cost.mjs <plugin-dir> [--runner <claude>] [--no-official] [--claude-md <path>] [--store <dir>] [--json <out>|-] [--md <out>|-]\n       context-cost.mjs --history <dir> [--json <out>|-] [--md <out>|-]';
  const argv = process.argv.slice(2), opt = { dir: null, runner: null, official: true, claudeMd: null, store: null, json: null, md: null, history: null };
  const VALUE = { '--runner': 'runner', '--claude-md': 'claudeMd', '--store': 'store', '--json': 'json', '--md': 'md', '--history': 'history' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE[a]) { const v = argv[++i]; if (v === undefined || (v.startsWith('--') && v !== '-')) { console.error(usage); process.exit(2); } opt[VALUE[a]] = v; }
    else if (a === '--no-official') opt.official = false;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('--') && !opt.dir) opt.dir = a;
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  if (!opt.dir === !opt.history) { console.error(usage); process.exit(2); }
  const emit = async (target, text) => { if (target === '-') process.stdout.write(text); else await fs.writeFile(target, text); };
  const quiet = opt.json === '-' || opt.md === '-';
  if (opt.history) {
    if (!isDir(opt.history)) { console.error(`context-cost: ${opt.history} is not a directory`); process.exit(2); }
    const t = trend(loadHistory(opt.history));
    if (!quiet) process.stdout.write(formatHistory(t));
    if (opt.json) await emit(opt.json, JSON.stringify(t, null, 2) + '\n');
    if (opt.md) await emit(opt.md, formatHistory(t, { md: true }));
  } else {
    let m;
    try { m = measure(opt.dir, { runner: opt.runner, official: opt.official, claudeMd: opt.claudeMd }); } catch (e) { console.error(`context-cost: ${e.message}`); process.exit(2); }
    if (!quiet) process.stdout.write(formatMeasure(m));
    if (opt.store) { await fs.mkdir(opt.store, { recursive: true }); const p = path.join(opt.store, storeName(m)); await fs.writeFile(p, JSON.stringify(m, null, 2) + '\n'); if (!quiet) console.log(`stored ${p}`); }
    if (opt.json) await emit(opt.json, JSON.stringify(m, null, 2) + '\n');
    if (opt.md) await emit(opt.md, formatMeasure(m, { md: true }));
  }
}
