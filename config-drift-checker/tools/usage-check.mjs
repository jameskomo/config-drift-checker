#!/usr/bin/env node
// usage-check: real usage vs eval results, per skill. Your eval suite says which skills trigger; your own
// session transcripts say which skills people actually use. Where the two disagree, one of them is wrong.
//
//   node tools/usage-check.mjs <plugin-dir> [result.json] [--since 30d] [--projects <glob>] [--transcripts <dir>]
//        [--skill-doctor <file>] [--json [out]] [--md [out]] [--html <out>]
//
// Real usage: every Skill tool call, and every /skill typed by the user, in the local Claude Code session
// transcripts (<config dir>/projects/*/**.jsonl, where the config dir is $CLAUDE_CONFIG_DIR or ~/.claude).
// Files are streamed line by line, files last written before the window are skipped unread, and malformed
// lines are counted and ignored. --projects limits the scan to project dirs whose name matches the glob
// (the dir name is the session's working directory with / replaced by -, so "*my-repo*" works).
//
// Eval side: a case "tests" a skill when it has a positive tool_used Skill grader (max not 0) whose
// input_match names the skill, or a covers.yaml id under skill/<name>/. With a result JSON (shim 1.1 or
// official v1), the grader verdicts say whether the trigger actually passes.
//
// --skill-doctor takes the text that `claude -p "/skill-doctor"` prints, for the per-skill context cost
// (the tokens its listing adds to every session); without it the cost is estimated from the description.
// That command reads the lifetime skillUsage counters in ~/.claude.json, an undocumented file, so the
// transcripts stay the default usage source; the doctor counts are used only when no transcript is found.
//
// Privacy: the output holds skill names, counts and dates only. No prompt, reply, path or project name
// from a transcript is ever copied out. Exit 0, or 2 on a usage error.
import { promises as fs, createReadStream, existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from './skill-lint.mjs';
import { loadSuite } from './suite-doctor.mjs';
import { coverage, slug } from './config-coverage.mjs';
import { normalizeResult } from './eval-classify.mjs';

const DAY = 86_400_000;
export const DEFAULT_SINCE = '30d';
const NAME_RE = /^[\w.@:-]{1,128}$/; // anything else is not a skill name and is never copied out

export const STATUS = {
  'dead-weight': { label: 'dead weight', tone: 'fail', tag: 'DEAD',
    advice: 'never invoked and no eval case: it costs context every session for nothing. Remove it, or fix its description and add a trigger case.' },
  'tested-unused': { label: 'tested but unused', tone: 'warn', tag: 'UNUSED',
    advice: 'your suite tests it but no real session invoked it: your suite may test a prompt users never write. Check the case prompt against how people actually ask.' },
  'used-untested': { label: 'used but untested', tone: 'warn', tag: 'UNTESTED',
    advice: 'real sessions rely on it but no eval case would notice it breaking. Add a trigger case (tool_used Skill) for it.' },
  healthy: { label: 'healthy', tone: 'pass', tag: 'OK', advice: 'used in real sessions and covered by an eval case.' },
};
const ORDER = ['dead-weight', 'tested-unused', 'used-untested', 'healthy'];

// ---------- the window ----------
// "30d", "2w", "12h", or an ISO date. Returns the cutoff as epoch ms.
export function parseSince(v, now = Date.now()) {
  const m = String(v ?? '').trim().match(/^(\d+)\s*([dwh])$/i);
  if (m) return now - Number(m[1]) * { d: DAY, w: 7 * DAY, h: DAY / 24 }[m[2].toLowerCase()];
  const t = Date.parse(String(v));
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v)) && Number.isFinite(t)) return t;
  throw new Error(`--since must look like 30d, 2w, 12h or 2026-09-01, got "${v}"`);
}
const day = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(0, 10));

export function globToRegExp(glob) {
  const re = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`);
}

// ---------- transcripts ----------
export const defaultTranscriptsDir = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const cleanName = (n) => { const s = String(n ?? '').trim().replace(/^\//, ''); return NAME_RE.test(s) ? s : null; };

// The skill invocations in one parsed transcript entry: model calls to the Skill tool, and slash commands
// the user typed (recorded as <command-name>/x</command-name>). Only the name, an id and the time survive.
export function invocationsIn(entry) {
  const out = [];
  if (!entry || typeof entry !== 'object') return out;
  const at = Date.parse(entry.timestamp ?? '');
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_use' && b.name === 'Skill') {
        const name = cleanName(b.input?.skill ?? b.input?.command);
        if (name) out.push({ name, kind: 'model', id: b.id ?? null, at: Number.isFinite(at) ? at : null });
      }
    }
  }
  if (entry.type === 'user') {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
    for (const t of texts) {
      const m = String(t ?? '').match(/<command-name>([^<]{1,140})<\/command-name>/);
      const name = m && cleanName(m[1]);
      if (name) out.push({ name, kind: 'user', id: entry.uuid ? `u:${entry.uuid}` : null, at: Number.isFinite(at) ? at : null });
    }
  }
  return out;
}

async function listJsonl(dir, acc = [], depth = 0) {
  if (depth > 4) return acc;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(p, acc, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

// Stream every transcript under root (optionally only project dirs matching `projects`) and count the
// invocations per name inside the window. A tool_use id seen twice (a resumed or forked session repeats
// its history) counts once.
export async function scanTranscripts({ root = defaultTranscriptsDir(), projects = null, since = 0 } = {}) {
  const stats = { root, found: existsSync(root), projects: 0, files: 0, skippedOld: 0, lines: 0, malformed: 0, invocations: 0 };
  const byName = new Map();
  if (!stats.found) return { stats, byName };
  const match = projects ? globToRegExp(projects) : null;
  const seen = new Set();
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && (!match || match.test(e.name))).map((e) => e.name).sort();
  for (const d of dirs) {
    const files = (await listJsonl(path.join(root, d))).sort();
    if (files.length) stats.projects++;
    for (const f of files) {
      let st;
      try { st = await fs.stat(f); } catch { continue; }
      if (st.mtimeMs < since) { stats.skippedOld++; continue; } // nothing in it can be newer than its last write
      stats.files++;
      const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        stats.lines++;
        if (!line.includes('"Skill"') && !line.includes('<command-name>')) continue; // cheap filter before parsing
        let entry;
        try { entry = JSON.parse(line); } catch { stats.malformed++; continue; }
        for (const inv of invocationsIn(entry)) {
          const at = inv.at ?? st.mtimeMs;
          if (at < since) continue;
          if (inv.id) { const k = `${inv.kind}:${inv.id}`; if (seen.has(k)) continue; seen.add(k); }
          const r = byName.get(inv.name) ?? { model: 0, user: 0, first: at, last: at };
          r[inv.kind]++; r.first = Math.min(r.first, at); r.last = Math.max(r.last, at);
          byName.set(inv.name, r);
          stats.invocations++;
        }
      }
    }
  }
  return { stats, byName };
}

// ---------- /skill-doctor text ----------
const num = (s) => { if (!s || s === '-') return null; const m = String(s).replace(/[~,]/g, '').match(/^([\d.]+)([kKmM]?)$/); if (!m) return null; return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)); };
// One row per skill: "  name  source  ~100  -  3x  7 days". The source column can hold spaces.
export function parseSkillDoctor(text) {
  const rows = [];
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const m = l.match(/^\s+(\S+)\s+(.+?)\s+(~?[\d.,]+[kKmM]?|-)\s+(~?[\d.,]+[kKmM]?|-)\s+(\d+)\s*[×x]\s+(never|today|\d+\s+days?)\s*$/);
    if (!m || !cleanName(m[1])) continue;
    const last = m[6] === 'never' ? null : m[6] === 'today' ? 0 : Number(m[6].match(/\d+/)[0]);
    rows.push({ name: m[1], source: m[2].trim(), contextTokens: num(m[3]), weekTokens: num(m[4]), uses: Number(m[5]), daysSinceUse: last });
  }
  return rows;
}

// ---------- matching names to the plugin's skills ----------
// A plugin skill is invoked as <plugin>:<skill>; a skill loaded from a plain skills dir as <skill>.
export function invokedAs(name, skillName, pluginName) {
  if (name === skillName) return true;
  const i = name.lastIndexOf(':');
  return i > 0 && name.slice(i + 1) === skillName && (!pluginName || name.slice(0, i) === pluginName);
}
function targetsSkill(inputMatch, skillName, pluginName) {
  if (inputMatch === null || inputMatch === undefined || inputMatch === '') return null; // any skill
  let re;
  try { re = new RegExp(String(inputMatch), 's'); } catch { return String(skillName).includes(String(inputMatch)); }
  return [skillName, `${pluginName}:${skillName}`, JSON.stringify({ skill: `${pluginName}:${skillName}` }), JSON.stringify({ skill: skillName })].some((s) => re.test(s));
}
const isSkillTrigger = (g) => g && g.type === 'tool_used' && g.tool === 'Skill' && !(g.max === 0 || g.max === '0');

// Which eval cases test which skill: trigger graders on disk (and in a shim result, which records them),
// plus covers.yaml ids under skill/<name>/.
async function evalCases(pluginDir, skills, pluginName, result) {
  const triggers = new Map(); // case dir -> [{ grader, inputMatch }]
  const add = (dir, name, inputMatch) => { const l = triggers.get(dir) ?? []; if (!l.some((x) => x.grader === name)) l.push({ grader: name, inputMatch }); triggers.set(dir, l); };
  let suiteFound = false;
  try {
    const suite = loadSuite(pluginDir);
    suiteFound = true;
    for (const c of suite.cases) for (const g of c.graders) if (isSkillTrigger(g.meta)) add(path.basename(c.dir), path.basename(g.file, '.md'), g.meta.input_match ?? null);
  } catch { /* no suite on disk */ }
  for (const c of result?.cases ?? []) for (const g of c.graders ?? []) {
    const flat = { type: g.type, tool: g.tool ?? g.config?.tool, max: g.max ?? g.config?.max };
    if (isSkillTrigger(flat)) add(c.dir, g.name, g.input_match ?? g.config?.input_match ?? null);
  }
  let covers = [];
  try { covers = (await coverage(pluginDir)).cases; } catch { /* unreadable manifest: no covers */ }
  const out = new Map(skills.map((s) => [s.name, []]));
  for (const [dir, gs] of triggers) for (const s of skills) {
    const hits = gs.filter((g) => { const t = targetsSkill(g.inputMatch, s.name, pluginName); return t === null ? skills.length === 1 : t; });
    if (hits.length) out.get(s.name).push({ dir, via: 'trigger', graders: hits.map((g) => g.grader) });
  }
  for (const c of covers) for (const s of skills) {
    if (out.get(s.name).some((x) => x.dir === c.dir)) continue;
    if (c.covers.some((id) => id.startsWith(`skill/${slug(s.name)}/`))) out.get(s.name).push({ dir: c.dir, via: 'covers', graders: [] });
  }
  return { byName: out, suiteFound };
}

// Did the trigger grader pass in the result? true / false / null (no result, case not run, or no verdict).
function triggerVerdict(result, dir, graders) {
  const c = (result?.cases ?? []).find((x) => x.dir === dir);
  if (!c) return null;
  const verdicts = (c.arms?.with ?? []).filter((r) => !r.isError).flatMap((r) => (r.graders ?? []).filter((g) => graders.includes(g.name)))
    .map((g) => (g.verdict === 'pass' || g.passed === true ? true : g.verdict === 'fail' || g.passed === false ? false : null)).filter((v) => v !== null);
  return verdicts.length ? verdicts.some(Boolean) : null;
}

// ---------- the cross-check ----------
// Pure core: plugin skills + usage counts + eval cases -> one row per skill. Tests call this directly.
export function crossCheck({ skills, pluginName, usage, cases, result = null, doctor = [], windowDays = null, usageSource = 'transcripts' }) {
  const rows = skills.map((s) => {
    let model = 0, user = 0, last = null; const seenAs = [];
    for (const [n, u] of usage) if (invokedAs(n, s.name, pluginName)) { model += u.model; user += u.user; last = Math.max(last ?? 0, u.last); seenAs.push(n); }
    const doc = doctor.find((d) => invokedAs(d.name, s.name, pluginName)) ?? null;
    if (usageSource === 'skill-doctor' && doc) { model = doc.daysSinceUse !== null && (windowDays === null || doc.daysSinceUse <= windowDays) ? doc.uses : 0; user = 0; last = doc.daysSinceUse === null ? null : Date.now() - doc.daysSinceUse * DAY; }
    const sc = (cases.get(s.name) ?? []).map((c) => ({ ...c, triggers: c.via === 'trigger' ? triggerVerdict(result, c.dir, c.graders) : null }));
    const verdicts = sc.map((c) => c.triggers).filter((v) => v !== null);
    const evalsTrigger = verdicts.length ? verdicts.some(Boolean) : null;
    const uses = model + user;
    const tested = sc.length > 0;
    const status = uses > 0 ? (tested ? 'healthy' : 'used-untested') : (tested ? 'tested-unused' : 'dead-weight');
    const context = doc?.contextTokens != null ? { tokens: doc.contextTokens, source: 'skill-doctor' }
      : { tokens: Math.ceil(`- ${s.name}: ${s.description}`.length / 4), source: 'estimate' };
    return { skill: s.name, status, uses, modelUses: model, userUses: user, lastUsed: day(last), invokedAs: [...new Set(seenAs)].sort(),
      cases: sc.map(({ dir, via, triggers }) => ({ dir, via, triggers })), evalsTrigger, contextTokens: context.tokens, contextSource: context.source,
      skillDoctor: doc ? { uses: doc.uses, daysSinceUse: doc.daysSinceUse, weekTokens: doc.weekTokens } : null, message: messageFor(status, { uses, evalsTrigger, context, windowDays }) };
  });
  rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.uses - a.uses || a.skill.localeCompare(b.skill));
  const counts = Object.fromEntries(ORDER.map((k) => [k, rows.filter((r) => r.status === k).length]));
  const wasted = rows.filter((r) => r.status === 'dead-weight').reduce((n, r) => n + r.contextTokens, 0);
  return { rows, counts, deadWeightTokens: wasted };
}

const inWindow = (d) => (d === null || d === undefined ? 'in the window' : `in the last ${d} day${d === 1 ? '' : 's'}`);
function messageFor(status, { uses, evalsTrigger, context, windowDays }) {
  const cost = `${context.source === 'estimate' ? 'about ' : ''}${context.tokens} tokens of context every session${context.source === 'estimate' ? ' (estimated from its description)' : ''}`;
  if (status === 'dead-weight') return `No real session invoked it ${inWindow(windowDays)} and no eval case covers it. It costs ${cost}.`;
  if (status === 'tested-unused') {
    const ev = evalsTrigger === true ? 'The evals say it triggers' : evalsTrigger === false ? 'An eval case targets it (and its trigger currently fails)' : 'An eval case targets it';
    return `${ev}, but no real session invoked it ${inWindow(windowDays)}: your suite may test a prompt users never write.`;
  }
  if (status === 'used-untested') return `Invoked ${uses} time${uses === 1 ? '' : 's'} ${inWindow(windowDays)}, but no eval case covers it: a break here would go unnoticed.`;
  return `Invoked ${uses} time${uses === 1 ? '' : 's'} ${inWindow(windowDays)} and covered by an eval case${evalsTrigger === false ? ', though its trigger case currently fails' : ''}.`;
}

// ---------- orchestration ----------
export async function usageCheck(pluginDir, { result = null, since = DEFAULT_SINCE, projects = null, transcripts = defaultTranscriptsDir(), skillDoctorText = null, now = Date.now() } = {}) {
  const dir = path.resolve(pluginDir);
  const plugin = await loadPlugin(dir);
  const pluginName = plugin.manifest?.json?.name ?? path.basename(dir);
  const skills = plugin.skills.map((s) => ({ name: (s.fm.fields.name?.value ?? '').trim() || s.dirName, description: (s.fm.fields.description?.value ?? '').trim() }));
  const cutoff = parseSince(since, now);
  const windowDays = Math.max(0, Math.round((now - cutoff) / DAY));
  const res = result ? normalizeResult(result) : null;
  const { stats, byName } = await scanTranscripts({ root: transcripts, projects, since: cutoff });
  const doctor = skillDoctorText ? parseSkillDoctor(skillDoctorText) : [];
  const usageSource = stats.files === 0 && doctor.length ? 'skill-doctor' : 'transcripts';
  const { byName: cases, suiteFound } = await evalCases(dir, skills, pluginName, res);
  const check = crossCheck({ skills, pluginName, usage: byName, cases, result: res, doctor, windowDays, usageSource });
  return {
    schemaVersion: 1, plugin: pluginName, generatedAt: new Date(now).toISOString(),
    window: { since: day(cutoff), days: windowDays },
    usage: { source: usageSource, transcriptsFound: stats.found, projects: stats.projects, files: stats.files, skippedOld: stats.skippedOld, lines: stats.lines, malformedLines: stats.malformed, invocations: stats.invocations, projectFilter: projects },
    evals: { suiteFound, result: res ? { source: res.source ?? 'shim', generatedAt: res.generatedAt ?? null, cases: (res.cases ?? []).length } : null },
    skillDoctor: skillDoctorText ? { rows: doctor.length } : null,
    skills: check.rows.length, counts: check.counts, deadWeightTokens: check.deadWeightTokens, rows: check.rows,
  };
}

// ---------- output ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function sourceLine(r) {
  const u = r.usage;
  const where = u.source === 'skill-doctor' ? 'real usage from the /skill-doctor text (lifetime counts, no transcripts found)'
    : !u.transcriptsFound ? 'no session transcripts found, so every skill reads as unused'
    : `real usage from ${plural(u.files, 'transcript file')} in ${plural(u.projects, 'project')}${u.projectFilter ? ` matching ${u.projectFilter}` : ''}`;
  return `${where}, since ${r.window.since}${u.malformedLines ? `, ${plural(u.malformedLines, 'malformed line')} skipped` : ''}`;
}
export function summaryLine(r) {
  return `summary: ${ORDER.map((k) => `${r.counts[k]} ${STATUS[k].label}`).join(', ')}${r.deadWeightTokens ? `. Dead weight costs ${r.deadWeightTokens} tokens of context every session` : ''}`;
}
export function formatText(r) {
  const w = Math.max(5, ...r.rows.map((x) => x.skill.length));
  const out = [`usage-check: ${plural(r.skills, 'skill')} in ${r.plugin}; ${sourceLine(r)}${r.evals.result ? `; eval result of ${String(r.evals.result.generatedAt ?? '').slice(0, 10) || 'unknown date'}` : r.evals.suiteFound ? '; eval cases from the suite on disk (no result given, so trigger verdicts are unknown)' : '; no eval suite found'}`];
  for (const x of r.rows) out.push(`  ${STATUS[x.status].tag.padEnd(8)} ${x.skill.padEnd(w)}  ${x.message}`);
  if (!r.rows.length) out.push('  (the plugin ships no skills)');
  out.push(summaryLine(r));
  return out.join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
export function markdown(r) {
  const lines = [`### Skill usage vs evals: ${r.plugin}`, '', `${cap(sourceLine(r))}.`, '', '| status | skill | real uses | last used | eval cases | evals trigger | context |', '|---|---|---|---|---|---|---|'];
  for (const x of r.rows) lines.push(`| ${STATUS[x.status].label} | \`${cell(x.skill)}\` | ${x.uses} | ${x.lastUsed ?? 'never'} | ${x.cases.length ? x.cases.map((c) => `\`${cell(c.dir)}\``).join(', ') : 'none'} | ${x.evalsTrigger === null ? 'unknown' : x.evalsTrigger ? 'yes' : 'no'} | ${x.contextSource === 'estimate' ? 'about ' : ''}${x.contextTokens} tokens |`);
  lines.push('', summaryLine(r) + '.');
  for (const k of ['dead-weight', 'tested-unused', 'used-untested']) if (r.counts[k]) lines.push('', `**${STATUS[k].label}**: ${STATUS[k].advice}`);
  return lines.join('\n');
}

export function renderHtml(r) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tone = r.counts['dead-weight'] ? 'fail' : r.counts['tested-unused'] || r.counts['used-untested'] ? 'warn' : 'pass';
  const headline = !r.skills ? 'No skills to check'
    : r.counts['dead-weight'] ? `${plural(r.counts['dead-weight'], 'skill')} ${r.counts['dead-weight'] === 1 ? 'is' : 'are'} dead weight`
    : tone === 'warn' ? 'Usage and evals disagree' : 'Every skill is used and tested';
  const lede = !r.skills ? 'The plugin ships no SKILL.md files.'
    : tone === 'pass' ? `Every skill was invoked in real sessions in the last ${r.window.days} days and has an eval case.`
    : `Real sessions and the eval suite disagree on ${plural(r.rows.filter((x) => x.status !== 'healthy').length, 'skill')}. Each row says which side to fix.`;
  const stamp = [['plugin', esc(r.plugin)], ['window', `${r.window.days} days, since ${esc(r.window.since)}`],
    ['usage', esc(r.usage.source === 'skill-doctor' ? '/skill-doctor text' : `${plural(r.usage.files, 'transcript')}, ${plural(r.usage.invocations, 'invocation')}`)],
    ['evals', esc(r.evals.result ? `result of ${String(r.evals.result.generatedAt ?? 'unknown date').slice(0, 10)}` : r.evals.suiteFound ? 'suite on disk, no result' : 'no suite found')],
    ['generated', esc(r.generatedAt.slice(0, 16).replace('T', ' '))]];
  const tiles = ORDER.map((k) => `<div class="tile t-${r.counts[k] ? STATUS[k].tone : 'pass'}"><span class="tile-h">${esc(STATUS[k].label)}</span><span class="tile-v">${r.counts[k]}</span><span class="tile-s">${esc(STATUS[k].advice)}</span></div>`).join('');
  const rows = r.rows.map((x) => `<tr class="st-${x.status}"><td class="st"><span class="dot ${STATUS[x.status].tone}"></span>${esc(STATUS[x.status].label)}</td><td><code>${esc(x.skill)}</code><div class="why">${esc(x.message)}</div></td><td class="num">${x.uses}${x.userUses ? ` <small>${x.userUses} typed</small>` : ''}</td><td class="num">${esc(x.lastUsed ?? 'never')}</td><td>${x.cases.length ? x.cases.map((c) => `<code>${esc(c.dir)}</code>${c.via === 'covers' ? ' <small class="muted">covers</small>' : ''}`).join(' ') : '<span class="muted">none</span>'}</td><td>${x.evalsTrigger === null ? '<span class="muted">unknown</span>' : x.evalsTrigger ? '<span class="pass">yes</span>' : '<span class="fail">no</span>'}</td><td class="num">${x.contextSource === 'estimate' ? '<small>about</small> ' : ''}${x.contextTokens}</td></tr>`).join('');
  const css = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
.stamp,.num,code{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:inherit}a:hover{color:var(--track)}.wrap{max-width:1140px;margin:0 auto;padding:28px 28px 90px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.verdict{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600}h1.pass{color:var(--pass)}h1.fail{color:var(--fail)}h1.warn{color:var(--warn)}
.lede{font-size:16px;color:var(--muted);margin:0;max-width:56ch}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12.5px;box-shadow:var(--shadow);position:relative}
.stamp::before{content:"";position:absolute;inset:6px;border:1px dashed var(--rule);border-radius:5px;pointer-events:none}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px}.tile{flex:1 1 220px;min-width:0;display:grid;gap:2px;padding:9px 12px;border:1px solid var(--rule);border-left-width:4px;border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}.tile.t-pass{border-left-color:var(--pass)}.tile.t-warn{border-left-color:var(--warn)}.tile.t-fail{border-left-color:var(--fail)}
.tile-h{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}.tile-v{font-weight:600;font-size:20px;color:var(--ink)}.t-warn .tile-v{color:var(--warn)}.t-fail .tile-v{color:var(--fail)}.tile-s{font-size:12px;color:var(--muted)}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);margin:0 0 26px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%}th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);white-space:nowrap;font-weight:600}
td{padding:9px 12px;border-bottom:1px solid var(--rule);font-size:14px;vertical-align:top}tr:last-child td{border-bottom:0}td.num{text-align:right;font-size:13px;white-space:nowrap}td small{color:var(--muted);font-size:11px}td.st{white-space:nowrap}
.why{font-size:12.5px;color:var(--muted);margin-top:3px;max-width:60ch}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--muted);vertical-align:1px}.dot.pass{background:var(--pass)}.dot.fail{background:var(--fail)}.dot.warn{background:var(--warn)}
tr.st-dead-weight td{background:var(--fail-bg)}tr.st-tested-unused td,tr.st-used-untested td{background:var(--warn-bg)}
code{font-size:.9em;background:var(--code);padding:1px 4px;border-radius:3px}
.foot{color:var(--muted);font-size:12px;margin-top:26px}
:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.wrap{padding:20px 16px 60px}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.plugin)} · skill usage</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"><style>${css}</style></head><body><div class="wrap">
<header class="verdict">
  <div><p class="eyebrow">config-drift-checker · <b>${esc(r.plugin)}</b> · real usage vs evals</p>
    <h1 class="${tone}">${esc(headline)}</h1>
    <p class="lede">${esc(lede)}</p></div>
  <dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</header>
<div class="tiles">${tiles}</div>
<div class="tablewrap"><table><thead><tr><th>status</th><th>skill</th><th>real uses</th><th>last used</th><th>eval cases</th><th>evals trigger</th><th>context tokens</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">The plugin ships no skills.</td></tr>'}</tbody></table></div>
<p class="foot">${esc(cap(sourceLine(r)))}. Real uses count Skill tool calls and typed slash commands. Context tokens are what the skill's listing adds to every session${r.rows.some((x) => x.contextSource === 'estimate') ? '; "about" marks an estimate from the description (pass --skill-doctor for the measured figure)' : ''}. This page holds skill names, counts and dates only: no prompt or transcript text. Generated by <a href="https://github.com/jameskomo/config-drift-checker">config-drift-checker</a> usage-check.</p>
</div></body></html>`;
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = 'usage: usage-check.mjs <plugin-dir> [result.json] [--result f] [--since 30d] [--projects <glob>] [--transcripts <dir>] [--skill-doctor <file>] [--json [out]] [--md [out]] [--html <out>]';
  const argv = process.argv.slice(2);
  const opt = { dir: null, result: null, since: DEFAULT_SINCE, projects: null, transcripts: null, skillDoctor: null, json: null, md: null, html: null };
  const value = (i) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--result', '--since', '--projects', '--transcripts', '--skill-doctor', '--html'].includes(a)) {
      const v = value(i); if (v === null) { console.error(`${a} needs a value\n${usage}`); process.exit(2); }
      opt[{ '--result': 'result', '--since': 'since', '--projects': 'projects', '--transcripts': 'transcripts', '--skill-doctor': 'skillDoctor', '--html': 'html' }[a]] = v; i++;
    } else if (a === '--json' || a === '--md') { const v = value(i); opt[a.slice(2)] = v ?? '-'; if (v !== null) i++; }
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('--') && !opt.dir) opt.dir = a;
    else if (!a.startsWith('--') && !opt.result) opt.result = a;
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  if (!opt.dir) { console.error(usage); process.exit(2); }
  if (!existsSync(opt.dir)) { console.error(`no such directory: ${opt.dir}`); process.exit(2); }
  let r;
  try {
    const result = opt.result ? JSON.parse(await fs.readFile(opt.result, 'utf8')) : null;
    const skillDoctorText = opt.skillDoctor ? await fs.readFile(opt.skillDoctor, 'utf8') : null;
    r = await usageCheck(opt.dir, { result, since: opt.since, projects: opt.projects, transcripts: opt.transcripts ? path.resolve(opt.transcripts) : defaultTranscriptsDir(), skillDoctorText });
  } catch (e) { console.error(`usage-check: ${e.message}`); process.exit(2); }
  const json = JSON.stringify(r, null, 2) + '\n';
  if (opt.json === '-') process.stdout.write(json);
  else if (opt.md === '-') console.log(markdown(r));
  else console.log(formatText(r));
  if (opt.json && opt.json !== '-') await fs.writeFile(opt.json, json);
  if (opt.md && opt.md !== '-') await fs.writeFile(opt.md, markdown(r) + '\n');
  if (opt.html) { await fs.writeFile(opt.html, renderHtml(r)); console.error(`wrote ${opt.html}`); }
}
