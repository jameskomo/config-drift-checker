#!/usr/bin/env node
// trigger-map: how reliably does each skill fire, and which skills steal each other's prompts?
//
//   node tools/trigger-map.mjs <plugin-dir> [--prompts prompts.yaml] [--generate n | --no-generate] [--no-evals]
//        [--cache <file>] [--regenerate] [--skill a,b] [--model haiku|pinned|<id>] [--judge-model m]
//        [--runs n] [--max-turns n] [--budget <usd>] [--concurrency n | -j n]
//        [--min-fire 0.8] [--max-false-fire 0.1] [--json <file>|-] [--md <file>|-] [--html <file>] [--dry-run]
//
// Every skill gets a set of prompts it should fire on (in scope) and prompts it should stay out of
// (adjacent, out of scope). They come from three places, merged and de-duplicated:
//   1. --prompts <file>: your own list, YAML or JSON:   <skill>:\n  fire:\n    - ...\n  no_fire:\n    - ...
//   2. the plugin's eval cases: a case with a tool_used Skill grader is an in-scope prompt for the skills its
//      input_match names (min 1), or an out-of-scope one (max 0). --no-evals leaves them out.
//   3. generated paraphrases: one call per skill to the judge model, with no tools, writes n in-scope and n
//      adjacent out-of-scope prompts from the skill's name and description (default n 10). They are saved to
//      a cache file (default <plugin>/.cdc-trigger-prompts.json) so reruns cost nothing and the set can be read
//      and edited; an entry is reused until the skill's name or description changes (--regenerate forces it).
//
// Each prompt then runs --runs times as `claude -p` with the plugin loaded (--plugin-dir), --max-turns 1, the
// Skill tool as the only tool (--tools Skill) and no MCP servers (--strict-mcp-config), in a fresh
// CLAUDE_CONFIG_DIR (credentials copied in) and an empty temp cwd. The first Skill tool call is the answer; the
// turn ends there. Output is capped at 1024 tokens, so a prompt that fires nothing stays cheap. Cheap model by
// default (haiku); --model pinned uses the pinned model from .cdc.yml.
//
// Reported per skill: the fire rate on in-scope prompts and the false-fire rate on out-of-scope prompts, each
// with a Wilson 95% interval, and a confusion matrix of intended skill against the skill that fired. A prompt
// meant for A that fired B is a collision; B may be another plugin skill or one built into Claude Code.
// --budget (default $1) covers generation and measurement together: no call starts once the spend, plus what
// the calls in flight are expected to cost, reaches it. Prompts are interleaved across skills, so a capped
// run leaves every skill with some evidence rather than a few skills with all of it.
// --dry-run prints the prompt counts and an estimated cost, calls nothing and spends $0.
// Exit 0 when something was measured, 1 when nothing was (every call errored, or the budget allowed none),
// 2 on a usage error.
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin, parseFrontmatter } from './skill-lint.mjs';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

export const SCHEMA_VERSION = 1;
export const DEFAULTS = { generate: 10, runs: 1, maxTurns: 1, budget: 1, concurrency: 4, minFire: 0.8, maxFalseFire: 0.1, model: 'haiku', maxOutputTokens: 1024 };
export const CACHE_FILE = '.cdc-trigger-prompts.json';

// ---------- statistics ----------
// Wilson score interval for k successes in n trials: honest at small n and at 0 or n, unlike the normal one.
export function wilson(k, n, z = 1.959964) {
  if (!n) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
const rate = (k, n) => ({ k, n, rate: n ? k / n : null, ci: wilson(k, n) });

// ---------- source 1: the user's prompt file ----------
// The shape is a two-level mapping: skill -> { fire: [...], no_fire: [...] }. YAML (block lists, [flow] lists,
// quoted, plain multi-line and | > block items, # comment lines) or JSON. Not a general YAML parser.
export function parsePromptFile(text, file = 'prompts') {
  const src = String(text).replace(/^﻿/, '');
  if (/^\s*\{/.test(src)) return normalizeShape(JSON.parse(src), file);
  const out = {};
  const lines = src.split(/\r?\n/);
  const indent = (l) => l.match(/^ */)[0].length;
  let skill = null, list = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], line = raw.trim(), ind = indent(raw);
    const fail = (m) => { throw new Error(`${file}:${i + 1}: ${m}`); };
    if (!line || line.startsWith('#')) continue;
    if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) fail('indent with spaces, not tabs');
    if (ind === 0) {
      const m = line.match(/^(.+?):\s*$/);
      if (!m) fail('expected "<skill-name>:" at the top level');
      skill = unquote(m[1]); out[skill] ??= { fire: [], no_fire: [] }; list = null;
      continue;
    }
    if (/^-(\s|$)/.test(line)) {
      if (!list) fail('a list item must sit under fire: or no_fire:');
      const cont = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || indent(lines[i + 1]) > ind)) cont.push(lines[++i]);
      while (cont.length && !cont.at(-1).trim()) cont.pop();
      const v = item(line.replace(/^-\s*/, ''), cont);
      if (v) list.push(v);
      continue;
    }
    const m = line.match(/^(fire|no_fire|no-fire|nofire):\s*(.*)$/i);
    if (!m) fail(`expected fire: or no_fire: under "${skill ?? '?'}", not "${line}"`);
    if (!skill) fail('fire: / no_fire: must sit under a skill name');
    list = out[skill][/^fire$/i.test(m[1]) ? 'fire' : 'no_fire'];
    if (m[2] && !m[2].startsWith('#')) {
      if (!/^\[.*\]$/.test(m[2])) fail('put list items on their own "- " lines, or use [a, b]');
      list.push(...splitFlow(m[2].slice(1, -1)).map(unquote).filter(Boolean));
      list = null;
    }
  }
  return out;
}
function item(first, cont) {
  const rest = cont.map((l) => l.trim());
  if (/^[|>][+-]?$/.test(first)) {
    const body = cont.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
    const cut = body.length ? Math.min(...body) : 0;
    const ls = cont.map((l) => l.slice(cut));
    return (first[0] === '|' ? ls.join('\n') : ls.map((l) => l.trim()).join(' ')).trim();
  }
  if (/^["']/.test(first)) return unquote([first, ...rest].join(' '));
  return [first, ...rest].filter(Boolean).join(' ').trim();
}
function unquote(s) {
  s = String(s).trim();
  if (s.startsWith('"')) { try { return JSON.parse(s.slice(0, s.lastIndexOf('"') + 1)); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'")) return s.slice(1, s.lastIndexOf("'")).replace(/''/g, "'");
  return s;
}
function splitFlow(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function normalizeShape(json, file) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file}: expected an object of skill -> { fire, no_fire }`);
  const out = {};
  for (const [skill, v] of Object.entries(json)) {
    const fire = v?.fire ?? [], noFire = v?.no_fire ?? v?.['no-fire'] ?? v?.noFire ?? [];
    if (!Array.isArray(fire) || !Array.isArray(noFire)) throw new Error(`${file}: ${skill}.fire and ${skill}.no_fire must be lists`);
    out[skill] = { fire: fire.map(String).filter((x) => x.trim()), no_fire: noFire.map(String).filter((x) => x.trim()) };
  }
  return out;
}

// ---------- the plugin: skills and eval cases ----------
export async function pluginSkills(pluginDir) {
  const p = await loadPlugin(pluginDir);
  const pluginName = p.manifest?.json?.name ?? path.basename(pluginDir);
  const skills = p.skills.filter((s) => s.fm.closed).map((s) => ({ name: (s.fm.fields.name?.value ?? '').trim() || s.dirName, description: (s.fm.fields.description?.value ?? '').trim(), file: s.rel }));
  return { pluginName, skills, manifest: p.manifest?.json ?? {} };
}

// Source 2: an eval case with a `tool_used` Skill grader already says which skill its prompt should (min >= 1)
// or should not (max 0) fire. input_match is tested the way the shim tests it, against the Skill call input.
export async function evalExpectations(pluginDir, { pluginName, skills, manifest = {} }) {
  const evalDir = path.join(pluginDir, manifest.experimental?.evals ?? 'evals');
  if (!existsSync(evalDir)) return [];
  const out = [];
  for (const d of (await fs.readdir(evalDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !['results', 'mocks'].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const promptPath = path.join(evalDir, d.name, 'prompt.md');
    const gdir = path.join(evalDir, d.name, 'graders');
    if (!existsSync(promptPath) || !existsSync(gdir)) continue;
    const pf = parseFrontmatter(await fs.readFile(promptPath, 'utf8'));
    const text = (pf.closed ? pf.body : await fs.readFile(promptPath, 'utf8')).trim();
    if (!text) continue;
    for (const g of (await fs.readdir(gdir)).filter((f) => f.endsWith('.md')).sort()) {
      const f = parseFrontmatter(await fs.readFile(path.join(gdir, g), 'utf8')).fields;
      if (f.type?.value !== 'tool_used' || f.tool?.value !== 'Skill' || !f.input_match?.value) continue;
      const max = f.max ? Number(f.max.value) : undefined, min = f.min ? Number(f.min.value) : (max === 0 ? 0 : 1);
      const expect = max === 0 ? 'no_fire' : min >= 1 ? 'fire' : null;
      if (!expect) continue;
      let re; try { re = new RegExp(String(f.input_match.value), 's'); } catch { continue; }
      for (const s of skills) if (re.test(JSON.stringify({ skill: `${pluginName}:${s.name}` })) || re.test(s.name)) out.push({ skill: s.name, expect, text, source: `eval:${d.name}` });
    }
  }
  return out;
}

// ---------- source 3: generated paraphrases ----------
export const descriptionKey = (s) => crypto.createHash('sha256').update(`${s.name}\n${s.description}`).digest('hex').slice(0, 16);
export function generationPrompt(skill, n) {
  return [
    'You write test prompts that check when a Claude Code skill triggers.', '',
    `Skill name: ${skill.name}`, `Skill description: ${skill.description}`, '',
    `Write ${n} in-scope prompts: realistic requests a developer would type to a coding agent, which this description says the skill should handle. Vary the wording, length and task. Most should not name the skill or repeat its trigger phrases word for word.`,
    `Write ${n} adjacent out-of-scope prompts: requests that share vocabulary, language or setting with the skill but that the description does not cover or explicitly excludes, so a well-scoped trigger stays quiet on them.`,
    'Each prompt is one to three sentences, self-contained, plain English, with no numbering.', '',
    'Reply with ONLY a JSON object: {"fire": ["..."], "no_fire": ["..."]}',
  ].join('\n');
}
export function parseGenerated(text, n) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in the reply');
  const j = JSON.parse(m[0]);
  const clean = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean).slice(0, n);
  const out = { fire: clean(j.fire), no_fire: clean(j.no_fire ?? j.noFire) };
  if (!out.fire.length && !out.no_fire.length) throw new Error('the reply had no prompts');
  return out;
}
export async function readCache(file) {
  try { const j = JSON.parse(await fs.readFile(file, 'utf8')); return j && typeof j.skills === 'object' ? j : { schemaVersion: 1, skills: {} }; }
  catch { return { schemaVersion: 1, skills: {} }; }
}
// a cache entry is reused while the skill's name and description are unchanged and it holds enough prompts
export const cacheHit = (cache, skill, n) => { const e = cache.skills?.[skill.name]; return !!e && e.key === descriptionKey(skill) && (e.count ?? 0) >= n ? e : null; };

// ---------- the prompt set ----------
// One entry per distinct prompt text, carrying every expectation on it, so a text shared by two sources (or
// two skills) runs once and counts for each.
export function buildPromptSet(expectations) {
  const byText = new Map();
  for (const e of expectations) {
    const text = String(e.text ?? '').trim();
    if (!text) continue;
    const k = text.replace(/\s+/g, ' ').toLowerCase();
    if (!byText.has(k)) byText.set(k, { id: `p${byText.size + 1}`, text, expect: [] });
    const p = byText.get(k);
    const have = p.expect.find((x) => x.skill === e.skill && x.expect === e.expect);
    if (have) { if (!have.sources.includes(e.source)) have.sources.push(e.source); }
    else p.expect.push({ skill: e.skill, expect: e.expect, sources: [e.source] });
  }
  return [...byText.values()];
}
// Round-robin over (skill, fire / no_fire) groups, so a budget cap cuts every skill short evenly.
export function interleave(prompts) {
  const groups = new Map();
  for (const p of prompts) { const e = p.expect[0]; const k = `${e.skill}\u0000${e.expect}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const qs = [...groups.values()], out = [];
  for (let i = 0; out.length < prompts.length; i++) for (const q of qs) if (i < q.length) out.push(q[i]);
  return out;
}

// ---------- reading one run ----------
// Which skills a run invoked, from its stream-json events. Plugin skills come back as <plugin>:<skill>.
export function skillCalls(events) {
  const out = [];
  for (const e of events) if (e.type === 'assistant') for (const b of e.message?.content ?? []) {
    if (b.type === 'tool_use' && b.name === 'Skill') { const n = b.input?.skill ?? b.input?.command ?? b.input?.name; if (n) out.push(String(n).replace(/^\//, '')); }
  }
  return out;
}
export function normalizeSkill(raw, pluginName, names) {
  const bare = raw.startsWith(`${pluginName}:`) ? raw.slice(pluginName.length + 1) : raw;
  return names.includes(bare) ? bare : raw;
}
export function readRun(stdout, { pluginName, names }) {
  const events = String(stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.findLast((e) => e.type === 'result');
  const invoked = skillCalls(events);
  const fired = [...new Set(invoked.map((r) => normalizeSkill(r, pluginName, names)))];
  // a max-turns stop is the expected end here: the turn that called a skill is the one we came for
  const failed = !result || (result.is_error && !String(result.subtype ?? '').startsWith('error_max_turns'));
  const error = failed && !invoked.length ? String(result?.result ?? result?.errors?.[0] ?? 'no result from claude').slice(0, 300) : null;
  return { fired, invoked, error, costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : 0, model: result?.modelUsage ? Object.keys(result.modelUsage)[0] : (init?.model ?? null), available: Array.isArray(init?.skills) ? init.skills : null };
}

// ---------- analysis ----------
const noun = (n, runs) => (runs > 1 ? (n === 1 ? 'run' : 'runs') : n === 1 ? 'prompt' : 'prompts');
const pct = (x) => `${Math.round(x * 100)}%`;
const ciText = (ci) => `95% CI ${Math.round(ci.low * 100)} to ${Math.round(ci.high * 100)}%`;
function tally(trials) {
  const m = new Map();
  for (const t of trials) m.set(t.skill, { count: (m.get(t.skill)?.count ?? 0) + 1, prompts: [...new Set([...(m.get(t.skill)?.prompts ?? []), t.text])] });
  return [...m].map(([skill, v]) => ({ skill, ...v })).sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}
export const STATUS = { ok: 'reliable', misses: 'misses in-scope work', leaky: 'fires out of scope', collides: 'collides', 'not-loaded': 'not loaded', 'no-data': 'not measured' };

export function analyse({ pluginName, skills, prompts, trials, available = null, runs = 1, minFire = DEFAULTS.minFire, maxFalseFire = DEFAULTS.maxFalseFire }) {
  const names = skills.map((s) => s.name);
  const done = trials.filter((t) => t && !t.error);
  const byPrompt = new Map();
  for (const t of done) { if (!byPrompt.has(t.prompt)) byPrompt.set(t.prompt, []); byPrompt.get(t.prompt).push(t); }
  const textOf = new Map(prompts.map((p) => [p.id, p.text]));
  const trialsWhere = (pred) => prompts.filter(pred).flatMap((p) => byPrompt.get(p.id) ?? []);
  const isExternal = (n) => !names.includes(n);
  const loaded = (s) => !available || available.some((a) => a === s || a === `${pluginName}:${s}`);

  const out = skills.map((s) => {
    const S = s.name;
    const posT = trialsWhere((p) => p.expect.some((e) => e.skill === S && e.expect === 'fire'));
    const negT = trialsWhere((p) => p.expect.some((e) => e.skill === S && e.expect === 'no_fire'));
    const hits = posT.filter((t) => t.fired.includes(S)).length;
    const collisions = tally(posT.filter((t) => !t.fired.includes(S) && t.fired.length).map((t) => ({ skill: t.fired[0], text: textOf.get(t.prompt) }))).map((c) => ({ ...c, external: isExternal(c.skill) }));
    const missT = posT.filter((t) => !t.fired.length), misses = missT.length;
    // a hit that also called other skills: the model could not choose, which is a collision in waiting
    const coFired = tally(posT.filter((t) => t.fired.includes(S)).flatMap((t) => t.fired.filter((f) => f !== S).map((f) => ({ skill: f, text: textOf.get(t.prompt) })))).map((c) => ({ ...c, external: isExternal(c.skill) }));
    const falseFires = negT.filter((t) => t.fired.includes(S));
    const stolenT = trialsWhere((p) => p.expect.some((e) => e.skill !== S && e.expect === 'fire') && !p.expect.some((e) => e.skill === S && e.expect === 'fire')).filter((t) => t.fired.includes(S));
    const stolen = tally(stolenT.map((t) => ({ skill: prompts.find((p) => p.id === t.prompt).expect.find((e) => e.expect === 'fire' && e.skill !== S).skill, text: textOf.get(t.prompt) })));
    const positives = rate(hits, posT.length), negatives = rate(falseFires.length, negT.length);
    const status = !loaded(S) ? 'not-loaded' : !posT.length && !negT.length ? 'no-data'
      : posT.length && positives.rate < minFire ? 'misses' : negT.length && negatives.rate > maxFalseFire ? 'leaky'
      : collisions.length || stolen.length ? 'collides' : 'ok';
    const tone = status === 'ok' ? 'pass' : status === 'no-data' ? 'muted' : status === 'not-loaded' || (status === 'misses' && positives.rate < 0.5) ? 'fail' : 'warn';
    const r = { name: S, description: s.description, status, label: STATUS[status], tone, positives, negatives, collisions, coFired, misses, missPrompts: [...new Set(missT.map((t) => textOf.get(t.prompt)))], falseFirePrompts: [...new Set(falseFires.map((t) => textOf.get(t.prompt)))], stolen };
    r.verdict = verdictFor(r, runs);
    r.notes = [];
    if (status !== 'not-loaded' && posT.length && posT.length < 10) r.notes.push(`only ${posT.length} in-scope ${noun(posT.length, runs)}: the interval is wide; add prompts with --prompts or a larger --generate`);
    return r;
  });

  // the confusion matrix: one row per (skill, fire | no_fire) group, one column per skill that could or did fire
  const rows = [];
  for (const kind of ['fire', 'no_fire']) for (const S of names) {
    const ts = trialsWhere((p) => p.expect.some((e) => e.skill === S && e.expect === kind));
    if (!ts.length) continue;
    const counts = {};
    for (const t of ts) { const col = !t.fired.length ? 'none' : t.fired.includes(S) ? S : t.fired[0]; counts[col] = (counts[col] ?? 0) + 1; }
    rows.push({ skill: S, kind, total: ts.length, counts });
  }
  // outside skills get a column only when they took a row's prompt; ones that only fired alongside are in coFired
  const externals = new Map();
  for (const r of rows) for (const [col, n] of Object.entries(r.counts)) if (col !== 'none' && isExternal(col)) externals.set(col, (externals.get(col) ?? 0) + n);
  const columns = [...names.map((n) => ({ id: n, external: false })), ...[...externals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => ({ id: n, external: true })), { id: 'none', external: false, none: true }];

  const measured = out.filter((r) => r.status !== 'no-data');
  const good = out.filter((r) => r.status === 'ok');
  const headline = !done.length ? { tone: 'muted', mark: '○', text: 'Nothing measured' }
    : good.length === measured.length ? { tone: 'pass', mark: '●', text: `${measured.length === 1 ? 'The skill fires' : `All ${measured.length} skills fire`} reliably` }
    : { tone: out.some((r) => r.tone === 'fail') ? 'fail' : 'warn', mark: out.some((r) => r.tone === 'fail') ? '▼' : '◆', text: `${measured.length - good.length} of ${measured.length} skill${measured.length === 1 ? '' : 's'} need${measured.length - good.length === 1 ? 's' : ''} attention` };
  return { skills: out, matrix: { columns, rows }, headline, measured: { done: done.length, errored: trials.filter((t) => t?.error).length } };
}

export function verdictFor(r, runs = 1) {
  const S = r.name;
  if (r.status === 'not-loaded') return `${S} never loaded: it is not in the session's skill list, so its trigger cannot be measured (run skill-lint on the plugin)`;
  const parts = [];
  const p = r.positives, n = r.negatives;
  if (p.n) {
    const extra = [...r.collisions.slice(0, 3).map((c) => `${c.count} ${noun(c.count, runs)} fired ${c.skill}${c.external ? ' (outside the plugin)' : ''} instead`), ...(r.misses ? [`${r.misses} fired no skill`] : []), ...(r.coFired ?? []).slice(0, 2).map((c) => `on ${c.count} it fired together with ${c.skill}`)];
    parts.push(`${S} fires on ${pct(p.rate)} of in-scope prompts (${p.k} of ${p.n} ${noun(p.n, runs)}, ${ciText(p.ci)})${extra.length ? `; ${extra.join('; ')}` : ''}`);
  } else parts.push(`${S} has no in-scope prompts to measure`);
  if (n.n) parts.push(n.k === 0 ? `It never fired on its ${n.n} out-of-scope ${noun(n.n, runs)} (${ciText(n.ci)})` : `It fired on ${n.k} of ${n.n} out-of-scope ${noun(n.n, runs)} (${pct(n.rate)}, ${ciText(n.ci)})`);
  if (r.stolen.length) parts.push(`It also fired on ${r.stolen.map((x) => `${x.count} ${noun(x.count, runs)} meant for ${x.skill}`).join(' and ')}`);
  return parts.join('. ');
}

// ---------- cost ----------
// Per call. Measured on Claude Code 2.1.310 with haiku (claude-haiku-5-5), October 2026: a mean of $0.0014 per
// measurement call (max $0.0048) and $0.0033 per generation call; rounded up here, and the other families
// scaled by list price. Rough on purpose: a dry run is for "dimes or dollars", not for accounting.
export const COST_PER_CALL = { haiku: 0.002, sonnet: 0.04, opus: 0.08, fable: 0.2 };
export const COST_PER_GENERATION = { haiku: 0.004, sonnet: 0.08, opus: 0.16, fable: 0.4 };
export function perCall(model, table = COST_PER_CALL) {
  const m = String(model ?? '').toLowerCase();
  const fam = Object.keys(table).find((k) => m.includes(k));
  return { usd: table[fam ?? 'sonnet'], family: fam ?? null };
}

// ---------- rendering ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (x) => `$${Number(x ?? 0).toFixed(x > 0 && x < 0.1 ? 4 : 2)}`;
const rateCell = (r) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n})` : 'n/a');
const ciCell = (r) => (r.n ? `${Math.round(r.ci.low * 100)} to ${Math.round(r.ci.high * 100)}%` : '');

export function renderMd(res) {
  const m = res.matrix;
  const label = (c) => (c.none ? 'none' : c.external ? `${c.id} (other)` : c.id);
  return [
    `### Trigger map: ${res.plugin}`, '',
    `**${res.headline.text}.** ${res.config.model} on Claude Code ${res.harness.version ?? '?'} · ${res.prompts.length} prompts × ${res.config.runs} run${res.config.runs === 1 ? '' : 's'} · spent ${usd(res.spent)} of $${res.config.budget}`, '',
    ...res.skills.map((s) => `- ${s.verdict}.`), '',
    '| skill | status | in-scope fire rate | 95% CI | out-of-scope false fires | 95% CI | collisions |', '|---|---|---|---|---|---|---|',
    ...res.skills.map((s) => `| ${s.name} | ${s.label} | ${rateCell(s.positives)} | ${ciCell(s.positives)} | ${rateCell(s.negatives)} | ${ciCell(s.negatives)} | ${s.collisions.map((c) => `${c.skill} ×${c.count}`).join(', ')} |`), '',
    ...(m.rows.length ? ['Who fired (rows: what the prompt was meant for; columns: the skill that fired):', '',
      `| prompts | ${m.columns.map(label).join(' | ')} |`, `|---|${m.columns.map(() => '---').join('|')}|`,
      ...m.rows.map((r) => `| ${r.kind === 'fire' ? `for ${r.skill}` : `not for ${r.skill}`} | ${m.columns.map((c) => r.counts[c.id] ?? 0).join(' | ')} |`), ''] : []),
  ].join('\n');
}

function cellTone(row, col) {
  if (row.kind === 'fire') return col.id === row.skill ? 'pass' : col.none ? 'warn' : 'fail';
  return col.id === row.skill ? 'fail' : col.none ? 'pass' : 'track';
}
function bar(r, good) {
  if (!r.n) return '<span class="muted">no prompts</span>';
  const lo = r.ci.low * 100, hi = r.ci.high * 100, p = r.rate * 100;
  return `<div class="bar ${good ? 'pass' : 'warn'}" title="${esc(`${r.k} of ${r.n}: ${pct(r.rate)}, ${ciText(r.ci)}`)}"><span class="ci" style="left:${lo.toFixed(1)}%;width:${Math.max(hi - lo, 0.8).toFixed(1)}%"></span><i style="left:${p.toFixed(1)}%"></i></div><span class="num">${pct(r.rate)}</span> <span class="from">${r.k}/${r.n} · ${Math.round(lo)} to ${Math.round(hi)}%</span>`;
}

export function renderHtml(res) {
  const h = res.headline, m = res.matrix, runs = res.config.runs;
  const head = m.columns.map((c) => `<th class="${c.external ? 'ext' : ''}${c.none ? ' nonecol' : ''}" title="${esc(c.none ? 'no skill fired' : c.external ? `${c.id}: not in this plugin (built into Claude Code, or another plugin)` : c.id)}">${esc(c.none ? 'none' : c.id)}${c.external ? ' <i class="tag">other</i>' : ''}</th>`).join('');
  const body = m.rows.map((r) => `<tr class="${r.kind}"><th class="rn">${r.kind === 'fire' ? 'meant for' : 'not for'} <b>${esc(r.skill)}</b> <span class="from">${r.total}</span></th>${m.columns.map((c) => {
    const n = r.counts[c.id] ?? 0, share = n / r.total;
    return `<td class="hm t-${cellTone(r, c)}${n ? '' : ' zero'}${share >= 0.5 ? ' hi' : ''}" style="--a:${Math.round(share * 100)}%" title="${esc(`${n} of ${r.total} ${noun(r.total, runs)} ${r.kind === 'fire' ? 'meant for' : 'out of scope for'} ${r.skill} ${c.none ? 'fired no skill' : `fired ${c.id}`}`)}">${n ? `${Math.round(share * 100)}%<small>${n}</small>` : ''}</td>`;
  }).join('')}</tr>`).join('');
  const rows = res.skills.map((s) => `<tr><th class="sn">${esc(s.name)}<div class="tagline"><span class="st ${s.tone}">${esc(s.label)}</span></div></th><td>${bar(s.positives, s.positives.n && s.positives.rate >= res.config.minFire)}</td><td>${bar(s.negatives, s.negatives.n && s.negatives.rate <= res.config.maxFalseFire)}</td><td class="coll">${s.collisions.length ? s.collisions.map((c) => `<span class="chip fail">${esc(c.skill)} ×${c.count}</span>`).join(' ') : '<span class="muted">none</span>'}${s.coFired?.length ? `<div class="from">fired together with ${s.coFired.map((c) => `<span class="chip warn" title="${esc(c.prompts.join('\n'))}">${esc(c.skill)} ×${c.count}</span>`).join(' ')}</div>` : ''}${s.stolen.length ? `<div class="from">took ${s.stolen.map((x) => `${x.count} of ${esc(x.skill)}'s`).join(', ')}</div>` : ''}</td></tr>`).join('');
  const byPrompt = new Map();
  for (const t of res.trials) { if (!byPrompt.has(t.prompt)) byPrompt.set(t.prompt, []); byPrompt.get(t.prompt).push(t); }
  const outcome = (t, exp) => {
    if (!t) return '<span class="chip muted">not run</span>';
    if (t.error) return `<span class="chip muted" title="${esc(t.error)}">error</span>`;
    if (!t.fired.length) return `<span class="chip ${exp.expect === 'fire' ? 'warn' : 'pass'}">none</span>`;
    // the skill itself: right or wrong call; another skill: a collision, a co-fire, or (out of scope) neutral
    const tone = (f) => (f === exp.skill ? (exp.expect === 'fire' ? 'pass' : 'fail') : exp.expect === 'fire' ? (t.fired.includes(exp.skill) ? 'warn' : 'fail') : 'muted');
    return t.fired.map((f) => `<span class="chip ${tone(f)}">${esc(f)}</span>`).join(' ');
  };
  const drill = res.skills.map((s) => {
    const mine = res.prompts.flatMap((p) => p.expect.filter((e) => e.skill === s.name).map((e) => ({ p, e })));
    if (!mine.length) return '';
    const tr = mine.sort((a, b) => (a.e.expect === b.e.expect ? 0 : a.e.expect === 'fire' ? -1 : 1)).map(({ p, e }) => {
      const ts = byPrompt.get(p.id) ?? [];
      return `<tr><td class="ex ${e.expect}">${e.expect === 'fire' ? 'fire' : 'no fire'}</td><td class="pt">${esc(p.text.length > 600 ? p.text.slice(0, 600) + '...' : p.text)}<div class="from">${esc(e.sources.join(', '))}</div></td><td class="oc">${Array.from({ length: runs }, (_, i) => outcome(ts.find((t) => t.run === i), e)).join('<br>')}</td></tr>`;
    }).join('');
    return `<details${s.tone === 'pass' || s.tone === 'muted' ? '' : ' open'}><summary><b>${esc(s.name)}</b> <span class="from">${mine.length} prompts</span></summary><table class="pr"><tbody>${tr}</tbody></table></details>`;
  }).join('');
  const src = res.sources;
  const stamp = [
    ['plugin', `<b>${esc(res.plugin)}</b> <span class="from">${res.skills.length} skill${res.skills.length === 1 ? '' : 's'}</span>`],
    ['model', `<b>${esc(res.config.model)}</b>${res.resolvedModels.length ? ` <span class="from">${esc(res.resolvedModels.join(', '))}</span>` : ''}`],
    ['Claude Code', `<b>${esc(res.harness.version ?? 'unknown')}</b>`],
    ['prompts', `<b>${res.prompts.length}</b> <span class="from">${[src.file && `${src.file} yours`, src.evals && `${src.evals} from evals`, src.generated && `${src.generated} generated`].filter(Boolean).join(', ')}</span>`],
    ['runs', `<b>${runs}</b> per prompt <span class="from">${res.trials.length} calls, max ${res.config.maxTurns} turn${res.config.maxTurns === 1 ? '' : 's'}</span>`],
    ['spent', `<b>${usd(res.spent)}</b> <span class="from">of $${res.config.budget}${res.budget.skipped ? `, ${res.budget.skipped} calls not started` : ''}</span>`],
    ['generated', `<span class="from">${esc(String(res.generatedAt).replace('T', ' ').slice(0, 16))} UTC</span>`],
  ];
  const lede = `Each prompt ran as a fresh claude -p session with only this plugin and the Skill tool, and the first skill it called was recorded. A skill should fire on its in-scope prompts and stay quiet on the adjacent ones; a prompt meant for one skill that fired another is a collision. Intervals are Wilson 95% intervals over the runs. Targets: fire on at least ${pct(res.config.minFire)} in scope, at most ${pct(res.config.maxFalseFire)} out of scope.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(res.plugin)} trigger map</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"><style>${CSS}</style></head><body><div class="wrap">
<header class="verdict">
  <div><p class="eyebrow">config-drift-checker · <b>${esc(res.plugin)}</b> · trigger map</p>
    <h1 class="${h.tone}"><span class="mark">${h.mark}</span><span>${esc(h.text)}</span></h1>
    <p class="lede">${esc(lede)}</p>
    <ul class="verdicts">${res.skills.map((s) => `<li class="${s.tone}"><span class="dot ${s.tone}"></span>${esc(s.verdict)}.${s.notes.length ? ` <span class="from">${esc(s.notes.join('; '))}.</span>` : ''}</li>`).join('')}</ul></div>
  <dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
<h2>Fire rates</h2>
<div class="tablewrap"><table class="rates"><thead><tr><th>skill</th><th>fires on in-scope prompts</th><th>fires on out-of-scope prompts</th><th>in-scope prompts that fired another skill</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="legend"><span><i class="sw pt"></i>measured rate</span><span><i class="sw ci"></i>95% interval: where the true rate plausibly sits</span></p>
${m.rows.length ? `<h2>Who fired</h2>
<div class="tablewrap"><table class="mx"><thead><tr><th class="rn">prompts</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
<p class="legend"><span><i class="sw t-pass"></i>right call</span><span><i class="sw t-warn"></i>in scope, nothing fired</span><span><i class="sw t-fail"></i>collision or false fire</span><span><i class="sw t-track"></i>out of scope, another skill took it</span><span>darker = larger share of the row</span></p>` : ''}
<h2>Every prompt</h2>
<div class="drill">${drill}</div>
<p class="foot">Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a> trigger-map. Generated prompts are cached in ${esc(res.config.cache ?? CACHE_FILE)}; edit them there, or add your own with --prompts.</p>
</div></body></html>`;
}

const CSS = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
a{color:inherit;text-decoration:none}a:hover{color:var(--track)}.wrap{max-width:1180px;margin:0 auto;padding:28px 28px 90px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.muted,.from{color:var(--muted)}.from{font-size:12px}
.num{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}
.verdict{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;display:flex;gap:14px;align-items:baseline}h1 .mark{font-size:26px}h1.pass .mark{color:var(--pass)}h1.fail .mark{color:var(--fail)}h1.warn .mark{color:var(--warn)}h1.muted .mark{color:var(--muted)}
.lede{font-size:15px;color:var(--muted);margin:0;max-width:66ch}
.verdicts{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:6px}.verdicts li{font-size:14.5px;background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--muted);border-radius:6px;padding:7px 12px;overflow-wrap:anywhere}
.verdicts li.pass{border-left-color:var(--pass)}.verdicts li.warn{border-left-color:var(--warn)}.verdicts li.fail{border-left-color:var(--fail)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--muted)}.dot.pass{background:var(--pass)}.dot.warn{background:var(--warn)}.dot.fail{background:var(--fail)}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:12.5px;box-shadow:var(--shadow)}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0;overflow-wrap:anywhere}.stamp b{font-weight:600}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}
table{border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%}
th,td{padding:8px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:middle}tr:last-child td,tr:last-child th{border-bottom:0}
thead th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
.rates td{min-width:220px}.rates .sn{font-weight:600;white-space:nowrap}.tagline{margin-top:3px}
.st{font-size:10.5px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;border-radius:4px;padding:1px 6px;background:var(--code);color:var(--muted)}
.st.pass{background:var(--pass-bg);color:var(--pass)}.st.warn{background:var(--warn-bg);color:var(--warn)}.st.fail{background:var(--fail-bg);color:var(--fail)}
.bar{position:relative;height:10px;width:100%;max-width:220px;background:var(--code);border-radius:5px;margin:2px 0 5px}
.bar .ci{position:absolute;top:0;bottom:0;border-radius:5px;background:var(--pass-bg);border:1px solid var(--pass)}.bar.warn .ci{background:var(--warn-bg);border-color:var(--warn)}
.bar i{position:absolute;top:-3px;width:3px;height:16px;margin-left:-1.5px;border-radius:2px;background:var(--pass)}.bar.warn i{background:var(--warn)}
.chip{display:inline-block;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;border-radius:4px;padding:1px 6px;margin:1px 0;background:var(--code);color:var(--muted)}
.chip.pass{background:var(--pass-bg);color:var(--pass)}.chip.fail{background:var(--fail-bg);color:var(--fail)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
.mx th,.mx td{white-space:nowrap}.mx thead th{text-align:center;text-transform:none;letter-spacing:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;color:var(--ink)}
.mx th.ext,.mx th.nonecol{color:var(--muted)}.mx .rn{position:sticky;left:0;z-index:1;background:var(--surface);font-weight:400;color:var(--muted);text-align:left}.mx .rn b{color:var(--ink);font-weight:600}
.mx tr.no_fire .rn{background:var(--surface)}.mx tbody tr.no_fire:first-of-type th,.mx tr.fire+tr.no_fire th,.mx tr.fire+tr.no_fire td{border-top:2px solid var(--rule)}
.tag{font-style:normal;font-size:10px;padding:0 5px;border-radius:4px;background:var(--code);color:var(--muted);margin-left:4px;font-family:"IBM Plex Sans",sans-serif}
td.hm{text-align:center;min-width:76px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;color:var(--ink);background:color-mix(in srgb,var(--c) var(--a),var(--surface))}
td.hm small{display:block;font-size:10.5px;font-weight:400;color:var(--muted)}td.hm.zero{background:var(--surface)}
.t-pass{--c:var(--pass)}.t-fail{--c:var(--fail)}.t-warn{--c:var(--warn)}.t-track{--c:var(--track)}
td.hm.hi,td.hm.hi small{color:var(--surface)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted);margin:10px 0 0}.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:14px;height:12px;border-radius:3px;display:inline-block;border:1px solid var(--rule)}.sw.t-pass,.sw.t-fail,.sw.t-warn,.sw.t-track{background:color-mix(in srgb,var(--c) 70%,var(--surface))}
.sw.pt{width:3px;background:var(--pass);border:0}.sw.ci{background:var(--pass-bg);border-color:var(--pass)}
.drill details{background:var(--surface);border:1px solid var(--rule);border-radius:8px;margin:0 0 8px;box-shadow:var(--shadow)}.drill summary{cursor:pointer;padding:10px 14px}
.pr td{vertical-align:top;border-top:1px solid var(--rule);border-bottom:0}.pr .ex{white-space:nowrap;font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;width:70px}.pr .ex.fire{color:var(--pass)}.pr .ex.no_fire{color:var(--muted)}
.pr .pt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px}.pr .oc{width:230px}
.foot{color:var(--muted);font-size:12px;margin-top:22px}:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.wrap{padding:20px 16px 60px}.pr .oc{width:auto}}`;

// ---------- calling claude ----------
function exec(cmd, args, { cwd, env, timeout }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ stdout, stderr: stderr + e.message, code: -1, timedOut }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code, timedOut }); });
  });
}
// a fresh CLAUDE_CONFIG_DIR with only the credentials copied in, and an empty cwd: nothing of the user's
// setup (skills, CLAUDE.md, settings, MCP servers) leaks into the measurement
async function isolated(fn) {
  const userConfig = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-map-'));
  const cfg = path.join(root, 'cfg'), ws = path.join(root, 'ws');
  await fs.mkdir(cfg); await fs.mkdir(ws);
  if (existsSync(path.join(userConfig, '.credentials.json'))) await fs.copyFile(path.join(userConfig, '.credentials.json'), path.join(cfg, '.credentials.json'));
  await fs.writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(DEFAULTS.maxOutputTokens) };
  delete env.ANTHROPIC_MODEL;
  try { return await fn({ cwd: ws, env }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function generateFor(skill, n, model) {
  return isolated(async ({ cwd, env }) => {
    const r = await exec('claude', ['-p', generationPrompt(skill, n), '--output-format', 'json', '--setting-sources', '', '--permission-mode', 'dontAsk', '--max-turns', '1', '--model', model, '--tools', '', '--strict-mcp-config'], { cwd, env, timeout: 180_000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    const costUsd = typeof j?.total_cost_usd === 'number' ? j.total_cost_usd : 0;
    try { return { ...parseGenerated(j?.result, n), costUsd }; }
    catch (e) { return { error: `${e.message}${r.timedOut ? ' (timed out)' : ''}${!j ? `: ${(r.stderr || r.stdout).trim().slice(0, 200)}` : ''}`, costUsd }; }
  });
}
async function runTrial(text, { pluginDir, pluginName, names, model, maxTurns }) {
  return isolated(async ({ cwd, env }) => {
    const t0 = Date.now();
    const r = await exec('claude', ['-p', text, '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns), '--model', model, '--tools', 'Skill', '--strict-mcp-config', '--plugin-dir', pluginDir], { cwd, env, timeout: 180_000 });
    const run = readRun(r.stdout, { pluginName, names });
    if (run.error && r.timedOut) run.error = 'timed out';
    if (run.error && !r.stdout.trim()) run.error = (r.stderr.trim() || `claude exited ${r.code} with no output`).slice(0, 300);
    return { ...run, durationMs: Date.now() - t0 };
  });
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { plugin: null, prompts: null, generate: DEFAULTS.generate, evals: true, cache: null, regenerate: false, skill: null, model: DEFAULTS.model, judgeModel: null, runs: DEFAULTS.runs, maxTurns: DEFAULTS.maxTurns, budget: DEFAULTS.budget, concurrency: DEFAULTS.concurrency, minFire: DEFAULTS.minFire, maxFalseFire: DEFAULTS.maxFalseFire, json: null, md: null, html: null, dryRun: false };
  const usage = 'usage: trigger-map.mjs <plugin-dir> [--prompts file] [--generate n | --no-generate] [--no-evals] [--cache file] [--regenerate] [--skill a,b] [--model haiku|pinned|id] [--judge-model m] [--runs n] [--max-turns n] [--budget usd] [-j n] [--min-fire 0.8] [--max-false-fire 0.1] [--json file|-] [--md file|-] [--html file] [--dry-run]';
  const die = (m, code = 2) => { console.error(m); process.exit(code); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) die(`${a} needs a value\n${usage}`); return argv[++i]; };
    if (a === '--prompts') opt.prompts = path.resolve(next());
    else if (a === '--generate') opt.generate = Number(next());
    else if (a === '--no-generate') opt.generate = 0;
    else if (a === '--no-evals') opt.evals = false;
    else if (a === '--cache') opt.cache = path.resolve(next());
    else if (a === '--regenerate') opt.regenerate = true;
    else if (a === '--skill') opt.skill = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') opt.model = next();
    else if (a === '--judge-model') opt.judgeModel = next();
    else if (a === '--runs') opt.runs = Number(next());
    else if (a === '--max-turns') opt.maxTurns = Number(next());
    else if (a === '--budget') opt.budget = Number(next());
    else if (a === '--concurrency' || a === '-j') opt.concurrency = Number(next());
    else if (a === '--min-fire') opt.minFire = Number(next());
    else if (a === '--max-false-fire') opt.maxFalseFire = Number(next());
    else if (a === '--json') { const v = next(); opt.json = v === '-' ? '-' : path.resolve(v); }
    else if (a === '--md') { const v = next(); opt.md = v === '-' ? '-' : path.resolve(v); }
    else if (a === '--html') opt.html = path.resolve(next());
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('-') && !opt.plugin) opt.plugin = path.resolve(a);
    else die(`unknown option ${a}\n${usage}`);
  }
  if (!opt.plugin) die(usage);
  if (!existsSync(path.join(opt.plugin, '.claude-plugin', 'plugin.json'))) die(`${opt.plugin} is not a plugin (no .claude-plugin/plugin.json)`);
  if (!Number.isInteger(opt.generate) || opt.generate < 0 || opt.generate > 50) die('--generate must be a whole number from 0 to 50');
  if (!Number.isInteger(opt.runs) || opt.runs < 1 || opt.runs > 20) die('--runs must be a whole number from 1 to 20');
  if (!Number.isInteger(opt.maxTurns) || opt.maxTurns < 1 || opt.maxTurns > 5) die('--max-turns must be a whole number from 1 to 5');
  if (!Number.isInteger(opt.concurrency) || opt.concurrency < 1 || opt.concurrency > 8) die('--concurrency must be a whole number from 1 to 8');
  if (!(opt.budget > 0)) die('--budget must be above 0 (dollars)');
  if (!(opt.minFire >= 0 && opt.minFire <= 1) || !(opt.maxFalseFire >= 0 && opt.maxFalseFire <= 1)) die('--min-fire and --max-false-fire are rates from 0 to 1');
  if ([opt.json, opt.md].filter((x) => x === '-').length > 1) die('only one of --json and --md can write to stdout');
  const say = (...m) => ((opt.json === '-' || opt.md === '-') ? console.error : console.log)(...m);
  const log = (...m) => console.error(...m);

  const cdc = loadConfig(opt.plugin);
  const pinned = resolveTrack(cdc, 'pinned');
  if (opt.model === 'pinned') opt.model = pinned.model;
  opt.judgeModel ??= pinned.judgeModel ?? 'haiku';
  opt.cache ??= path.join(opt.plugin, CACHE_FILE);

  const plugin = await pluginSkills(opt.plugin);
  let skills = plugin.skills;
  if (!skills.length) die(`${plugin.pluginName} ships no skills (no SKILL.md with frontmatter found)`, 1);
  if (opt.skill) {
    const unknown = opt.skill.filter((s) => !skills.some((k) => k.name === s));
    if (unknown.length) die(`--skill: ${unknown.join(', ')} not in ${plugin.pluginName} (skills: ${skills.map((s) => s.name).join(', ')})`);
    skills = skills.filter((s) => opt.skill.includes(s.name));
  }
  const names = plugin.skills.map((s) => s.name);
  const wanted = new Set(skills.map((s) => s.name));

  // sources 1 and 2
  const expectations = [];
  if (opt.prompts) {
    if (!existsSync(opt.prompts)) die(`no such prompts file: ${opt.prompts}`);
    let file; try { file = parsePromptFile(await fs.readFile(opt.prompts, 'utf8'), path.basename(opt.prompts)); } catch (e) { die(`--prompts: ${e.message}`); }
    for (const [key, v] of Object.entries(file)) {
      const skill = normalizeSkill(key, plugin.pluginName, names);
      if (!names.includes(skill)) { log(`  ${path.basename(opt.prompts)}: "${key}" is not a skill of ${plugin.pluginName}; its prompts are skipped`); continue; }
      if (!wanted.has(skill)) continue;
      for (const text of v.fire) expectations.push({ skill, expect: 'fire', text, source: 'file' });
      for (const text of v.no_fire) expectations.push({ skill, expect: 'no_fire', text, source: 'file' });
    }
  }
  if (opt.evals) expectations.push(...(await evalExpectations(opt.plugin, plugin)).filter((e) => wanted.has(e.skill)));

  // source 3: what the cache already holds, and what is left to generate
  const cache = await readCache(opt.cache);
  const toGenerate = opt.generate ? skills.filter((s) => opt.regenerate || !cacheHit(cache, s, opt.generate)) : [];
  const fromCache = (s) => { const e = cacheHit(cache, s, opt.generate); return e ? [...e.fire.slice(0, opt.generate).map((text) => ({ skill: s.name, expect: 'fire', text, source: 'generated' })), ...e.no_fire.slice(0, opt.generate).map((text) => ({ skill: s.name, expect: 'no_fire', text, source: 'generated' }))] : []; };

  const callEst = perCall(opt.model), genEst = perCall(opt.judgeModel, COST_PER_GENERATION);
  if (opt.dryRun) {
    const cached = opt.generate ? skills.filter((s) => !toGenerate.includes(s)).flatMap(fromCache) : [];
    const known = buildPromptSet([...expectations, ...cached]);
    const pending = toGenerate.length * opt.generate * 2;
    say(`Trigger map dry run: ${plugin.pluginName}, ${skills.length} skill${skills.length === 1 ? '' : 's'}`);
    for (const s of skills) {
      const mine = [...expectations, ...cached].filter((e) => e.skill === s.name);
      const count = (src, ex) => mine.filter((e) => e.source.startsWith(src) && e.expect === ex).length;
      const gen = toGenerate.includes(s) ? ` + ${opt.generate} in / ${opt.generate} out to generate` : '';
      say(`  ${s.name}: in scope ${count('file', 'fire')} yours, ${count('eval', 'fire')} from evals, ${count('generated', 'fire')} cached; out of scope ${count('file', 'no_fire')} yours, ${count('eval', 'no_fire')} from evals, ${count('generated', 'no_fire')} cached${gen}`);
    }
    const calls = (known.length + pending) * opt.runs;
    const total = toGenerate.length * genEst.usd + calls * callEst.usd;
    say(`\n${known.length + pending} prompts × ${opt.runs} run${opt.runs === 1 ? '' : 's'} = ${calls} measurement calls on ${opt.model}${toGenerate.length ? `, plus ${toGenerate.length} generation call${toGenerate.length === 1 ? '' : 's'} on ${opt.judgeModel}` : ''}.`);
    say(`Estimated cost: about ${usd(total)} (${usd(callEst.usd)} per call${callEst.family ? '' : ', unknown model priced as sonnet'}; about ${usd(callEst.usd * 100)} per 100 prompts). Budget: $${opt.budget}${total > opt.budget ? `, which covers about ${Math.max(0, Math.floor((opt.budget - toGenerate.length * genEst.usd) / callEst.usd))} of the ${calls} calls` : ''}.`);
    say('\nDry run: nothing called, $0 spent.');
    process.exit(0);
  }

  const harnessVersion = (() => { try { return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim().split(/\s+/)[0] || null; } catch { return null; } })();
  log(`trigger-map: ${plugin.pluginName} · ${skills.length} skill${skills.length === 1 ? '' : 's'} · model=${opt.model} · runs=${opt.runs} · budget=$${opt.budget} · claude-code=${harnessVersion ?? '?'}`);

  let spent = 0, inFlight = 0, observed = [], skipped = 0, budgetHit = false;
  const expected = () => (observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : callEst.usd);
  const canStart = (est) => spent + inFlight * expected() + est <= opt.budget || (spent === 0 && inFlight === 0);

  // generation: one call per skill that has no fresh cache entry; written back as soon as it lands
  const genErrors = [];
  for (const s of toGenerate) {
    if (!canStart(genEst.usd)) { budgetHit = true; genErrors.push({ skill: s.name, error: 'budget reached before generation' }); continue; }
    log(`  ▸ generating ${opt.generate} in-scope and ${opt.generate} out-of-scope prompts for ${s.name} (${opt.judgeModel})`);
    const g = await generateFor(s, opt.generate, opt.judgeModel);
    spent += g.costUsd;
    if (g.error) { genErrors.push({ skill: s.name, error: g.error }); log(`    generation failed: ${g.error}`); continue; }
    cache.skills[s.name] = { key: descriptionKey(s), count: opt.generate, model: opt.judgeModel, generatedAt: new Date().toISOString(), fire: g.fire, no_fire: g.no_fire };
    cache.schemaVersion = 1;
    cache.note = 'Generated by config-drift-checker trigger-map: prompts each skill should fire on (fire) and adjacent ones it should not (no_fire). Edit freely; an entry is regenerated only when the skill name or description changes, or with --regenerate.';
    await fs.writeFile(opt.cache, JSON.stringify(cache, null, 2) + '\n');
  }
  if (opt.generate) for (const s of skills) expectations.push(...fromCache(s));

  const prompts = buildPromptSet(expectations);
  if (!prompts.length) die(`no prompts to run: add --prompts, keep --generate on, or add eval cases with a Skill grader${genErrors.length ? ` (generation failed: ${genErrors[0].error})` : ''}`, 1);
  const order = interleave(prompts);
  const queue = Array.from({ length: opt.runs }, (_, run) => order.map((p) => ({ p, run }))).flat();
  const trials = new Array(queue.length);
  let available = null, nextIdx = 0, doneN = 0;
  const resolved = new Set();
  log(`  ${prompts.length} prompts × ${opt.runs} run${opt.runs === 1 ? '' : 's'} = ${queue.length} calls, ${opt.concurrency} at a time`);
  const worker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= queue.length) return;
      const { p, run } = queue[i];
      if (!canStart(expected())) { if (!budgetHit) log(`  ■ budget: $${spent.toFixed(4)} spent, the next call would pass $${opt.budget}; not starting more`); budgetHit = true; skipped++; continue; }
      inFlight++;
      let r;
      try { r = await runTrial(p.text, { pluginDir: opt.plugin, pluginName: plugin.pluginName, names, model: opt.model, maxTurns: opt.maxTurns }); }
      finally { inFlight--; }
      spent += r.costUsd; if (!r.error) observed.push(r.costUsd);
      if (r.available && !available) available = r.available;
      if (r.model) resolved.add(r.model);
      trials[i] = { prompt: p.id, run, fired: r.fired, invoked: r.invoked, costUsd: r.costUsd, model: r.model, durationMs: r.durationMs, error: r.error };
      const e = p.expect[0];
      log(`  ▸ ${++doneN}/${queue.length} [${e.skill} ${e.expect === 'fire' ? 'in' : 'out'}] ${r.error ? `ERROR ${r.error}` : r.fired.length ? `fired ${r.fired.join(', ')}` : 'fired nothing'}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.concurrency, queue.length) }, worker));

  const ran = trials.filter(Boolean);
  const a = analyse({ pluginName: plugin.pluginName, skills, prompts, trials: ran, available, runs: opt.runs, minFire: opt.minFire, maxFalseFire: opt.maxFalseFire });
  const count = (src) => prompts.filter((p) => p.expect.some((e) => e.sources.some((x) => x.startsWith(src)))).length;
  const res = {
    schemaVersion: SCHEMA_VERSION, tool: 'trigger-map', plugin: plugin.pluginName, generatedAt: new Date().toISOString(),
    harness: { name: 'claude-code', version: harnessVersion },
    config: { model: opt.model, judgeModel: opt.judgeModel, runs: opt.runs, maxTurns: opt.maxTurns, budget: opt.budget, concurrency: opt.concurrency, minFire: opt.minFire, maxFalseFire: opt.maxFalseFire, generate: opt.generate, cache: path.relative(opt.plugin, opt.cache) || opt.cache, prompts: opt.prompts, evals: opt.evals },
    resolvedModels: [...resolved], available, spent, budget: { capUsd: opt.budget, spentUsd: spent, exceeded: budgetHit, skipped },
    sources: { file: count('file'), evals: count('eval'), generated: count('generated') }, generationErrors: genErrors,
    headline: a.headline, skills: a.skills, matrix: a.matrix, prompts, trials: ran,
  };
  if (opt.json) { const j = JSON.stringify(res, null, 2) + '\n'; if (opt.json === '-') process.stdout.write(j); else await fs.writeFile(opt.json, j); }
  if (opt.md) { const md = renderMd(res); if (opt.md === '-') process.stdout.write(md); else await fs.writeFile(opt.md, md); }
  if (opt.html) await fs.writeFile(opt.html, renderHtml(res));

  say(`\n${a.headline.text}.`);
  const clip = (t) => { const one = t.replace(/\s+/g, ' '); return one.length > 100 ? one.slice(0, 97) + '...' : one; };
  for (const s of a.skills) {
    say(`  ${s.verdict}.${s.notes.length ? ` (${s.notes.join('; ')})` : ''}`);
    for (const t of s.missPrompts.slice(0, 3)) say(`      missed:     ${clip(t)}`);
    for (const c of s.collisions.slice(0, 3)) for (const t of c.prompts.slice(0, 1)) say(`      to ${c.skill}: ${clip(t)}`);
    for (const t of s.falseFirePrompts.slice(0, 3)) say(`      false fire: ${clip(t)}`);
  }
  const perHundred = observed.length ? (observed.reduce((x, y) => x + y, 0) / observed.length) * 100 : null;
  say(`\n${ran.length} of ${queue.length} calls ran${a.measured.errored ? `, ${a.measured.errored} errored` : ''}${skipped ? `, ${skipped} not started (budget)` : ''}. Spent ${usd(spent)} of $${opt.budget}${perHundred !== null ? ` (about ${usd(perHundred)} per 100 prompts on ${opt.model})` : ''}.`);
  for (const f of [opt.json, opt.md, opt.html]) if (f && f !== '-') say(f);
  if (!a.measured.done) process.exitCode = 1;
}
