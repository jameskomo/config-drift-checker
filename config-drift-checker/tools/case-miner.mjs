#!/usr/bin/env node
// case-miner: turn real sessions into suggested regression cases. usage-check shows that a suite can test
// prompts nobody writes; this pulls the prompts people did write out of your local transcripts, anonymises
// them on your machine, and stages them as eval cases for you to review.
//
//   node tools/case-miner.mjs <plugin-dir> [--since 30d] [--projects <glob>] [--skill <name>] [--max 5]
//        [--transcripts <dir>] [--out <dir>] [--json [out]] [--dry-run]
//   node tools/case-miner.mjs accept <id...> [--plugin <dir>] [--out <dir>]
//
// Per skill, three kinds of candidate, each from one real user prompt:
//   trigger     the skill fired on the prompt.                          -> graders/skill-fired.md (with-only)
//   missed      it did not fire, the prompt matches the skill (keywords from the positive part of its
//               description, or a file in its paths: scope that the prompt names or the agent touched),
//               and within the next 3 turns the user typed /<skill>, named the skill, or corrected the
//               agent. A skill already loaded earlier in the session is never "missed".
//                                                                       -> graders/skill-fired.md (with-only)
//   no-trigger  it fired, and within the next 2 turns the user said it was wrong or irrelevant.
//                                                                       -> graders/skill-not-fired.md (both)
//
// Only human prompts count: tool results, slash commands, task notifications, messages from other agents,
// accepted suggestions, headless (claude -p) sessions and sub-agent transcripts are skipped. Files are
// streamed line by line, files last written before the window are skipped unread, malformed lines are
// counted and ignored. Assistant replies are never copied; the agent's Skill calls and the file paths it
// touched are read for matching only.
//
// Anonymised before anything is written or printed: the repo path (-> <repo>/...), other home and system
// paths (-> <path>/<file name>), the OS user name, emails, IP addresses, URLs carrying credentials or
// tokens, known key formats (sk-, ghp_, github_pat_, xox*, AKIA, AIza, glpat-, JWTs, private keys, ...),
// key=value secrets, other high-entropy strings, the name after "my name is", and long pasted code or logs
// (-> a placeholder with the line count). Prompts are cut to 1000 characters. Every candidate carries a
// note of what was removed.
//
// Review first: candidates go to a staging dir, default <plugin>/.eval-candidates/, with a .gitignore so it
// never lands in git by accident: one case dir per candidate, candidates.md (date, why, confidence, the
// anonymised prompt, what was removed) and index.json. The staging dir is never inside the eval dir: the
// official runner (checked on 2.1.310) loads case dirs anywhere under it, dot dirs included, so a staged
// case there would run unreviewed. Nothing reaches the suite until `accept <id...>` moves a case dir into
// the eval dir; it refuses to overwrite an existing case and refuses a case that fails a suite-doctor rule. Near-identical prompts (token Jaccard
// >= 0.8) are merged, prompts already in the suite are left out, and --max caps the candidates per skill.
//
// No network, no model. Exit 0, 1 when accept refuses an id, 2 on a usage error.
import { promises as fs, createReadStream, existsSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, cpSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from './skill-lint.mjs';
import { loadSuite, loadCase, resolveEvalDir, splitFrontmatter, RULES } from './suite-doctor.mjs';
import { parseSince, globToRegExp, defaultTranscriptsDir, invocationsIn, invokedAs, DEFAULT_SINCE } from './usage-check.mjs';
import { slugify, triggerMatch } from './evals-convert.mjs';

const DAY = 86_400_000;
export const DEFAULT_MAX = 5;
export const MAX_CHARS = 1000;
export const SIMILAR = 0.8; // token Jaccard at or above this is a near duplicate
const MISSED_TURNS = 3, MISSED_MS = 2 * 3_600_000;
const WRONG_TURNS = 2, WRONG_MS = 3_600_000;
export const KINDS = {
  trigger: { label: 'trigger', polarity: 'fire', grader: 'skill-fired' },
  missed: { label: 'missed trigger', polarity: 'fire', grader: 'skill-fired' },
  'no-trigger': { label: 'near-miss negative', polarity: 'quiet', grader: 'skill-not-fired' },
};
const displayPath = (p) => { const r = path.relative(process.cwd(), p); return !r ? '.' : r.startsWith('..') ? p : r; };
const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

// ---------- anonymise ----------
// Known key formats first (labelled in the note), then the generic catch-alls.
export const SECRET_FORMATS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['Anthropic or OpenAI key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['AWS key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];
const KEY_VALUE = /\b(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key(?:[_-]?id)?|secret[_-]?key|private[_-]?key)\b(\s*[:=]\s*|\s+is\s+)(["']?)([^\s"'<>,;]{4,})\3/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._+/=-]{16,}/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const SECRET_PARAM = /[?&#](?:[\w-]*(?:token|key|secret|sig|signature|password|passwd|pass|auth|credential|session|code)[\w-]*)=/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const ABS_PATH = /(?<![\w.>])(?:~\/|\/(?:home|Users|root|tmp|var|private|mnt|media|opt|srv|Volumes)(?=[/\s]|$)|[A-Za-z]:\\)[^\s'"`<>()[\]{},;|]*/g;
const NAME_INTRO = /\b(my name is|my name's)\s+/gi;
const TYPE_WORDS = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'int', 'long', 'object', 'required', 'optional', 'none']);
const PLURALS = { 'code block': 'code blocks', 'pasted code or log': 'pasted code or logs', secret: 'secrets', email: 'emails', 'IP address': 'IP addresses', 'URL with a token': 'URLs with tokens', path: 'paths', 'user name': 'user names', name: 'names' };
const COMMON_USERS = new Set(['admin', 'user', 'root', 'dev', 'test', 'ubuntu', 'runner', 'ec2-user', 'node', 'home', 'guest', 'default', 'build']);

export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
// A long token that mixes letters and digits and is not lowercase-words-with-dashes reads as a secret.
export function looksSecret(t) {
  if (t.length < 20) return false;
  if (/^[a-z]+(?:[-_][a-z0-9]+)*$/.test(t) && !t.split(/[-_]/).some((p) => p.length > 12 && /\d/.test(p))) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(t)).length;
  if (!(/\d/.test(t) && /[A-Za-z]/.test(t)) && !(t.length >= 32 && classes === 3)) return false;
  return entropy(t) >= 3.3;
}

const CODE_LINE = /[;{}]\s*$|^\s{2,}\S|^\t|^\s*at [\w.$<>]+\(|^\s*(?:import|package|public|private|protected|def|class|function|const|let|var|return|if|for|while|#include|SELECT|INSERT|UPDATE)\b|^\s*<\/?[\w:-]+[^>]*>\s*$|^\d{4}-\d\d-\d\d[T ]\d\d:\d\d|^\s*(?:Caused by|Traceback|Exception|Error)\b/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

// Returns { text, removed: [{ what, n, detail? }], note }. Pure; no I/O.
export function anonymise(input, { cwd = null, home = null, users = [], maxChars = MAX_CHARS } = {}) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n');
  const removed = new Map();
  const tally = (what, n = 1, detail = null) => {
    const r = removed.get(what) ?? { what, n: 0, details: [] };
    r.n += n; if (detail && !r.details.includes(detail)) r.details.push(detail);
    removed.set(what, r);
  };

  // long pasted code and logs: fenced blocks, then unfenced runs of code-like lines
  text = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n\2[ \t]*(?=\n|$)|$)/g, (m, pre, _f, body) => {
    const lines = body.split('\n').length;
    if (lines < 6 && body.length < 400) return m;
    tally('code block', 1, `${lines} lines`);
    return `${pre}<code block removed: ${lines} lines>`;
  });
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j < lines.length && CODE_LINE.test(lines[j]) && !LIST_LINE.test(lines[j]) && !/^<code block removed/.test(lines[j])) j++;
    if (j - i >= 6) { tally('pasted code or log', 1, `${j - i} lines`); out.push(`<pasted code or log removed: ${j - i} lines>`); i = j; } else { out.push(lines[i]); i++; }
  }
  text = out.join('\n');

  for (const [label, re] of SECRET_FORMATS) text = text.replace(re, () => { tally('secret', 1, label); return '<secret>'; });
  text = text.replace(URL_RE, (m) => {
    const u = m.replace(/[.,:;!?]+$/, '');
    if (/^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(u) || SECRET_PARAM.test(u) || u.split(/[/?&=#]/).some(looksSecret)) { tally('URL with a token', 1); return `<url>${m.slice(u.length)}`; }
    return m;
  });
  text = text.replace(BEARER, (_m, b) => { tally('secret', 1, 'bearer token'); return `${b} <secret>`; });
  text = text.replace(KEY_VALUE, (m, k, sep, q, v) => {
    const bare = v.replace(/[.!?:)]+$/, '');
    if (TYPE_WORDS.has(bare.toLowerCase()) || (/^\s+is\s+$/.test(sep) && /^[A-Za-z]+$/.test(bare))) return m; // "token: string", "the password is wrong"
    tally('secret', 1, `${k.toLowerCase()} value`); return `${k}${sep}${q}<secret>${q}`;
  });
  text = text.replace(EMAIL, () => { tally('email', 1); return '<email>'; });
  text = text.replace(IPV4, (ip) => { if (ip === '127.0.0.1' || ip === '0.0.0.0') return ip; tally('IP address', 1); return '<ip>'; });

  // paths: the session's repo becomes <repo>, anything else under a home or system dir keeps its file name only
  if (cwd && cwd.length > 1) {
    const esc = cwd.replace(/[\\/]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`${esc}(?![\\w.-])`, 'g'), () => { tally('path', 1); return '<repo>'; });
  }
  text = text.replace(ABS_PATH, (m) => {
    const p = m.replace(/[.,:;!?]+$/, '');
    const tail = m.slice(p.length);
    const parts = p.split(/[\\/]+/).filter(Boolean);
    const base = parts.length > 1 ? parts.at(-1) : '';
    tally('path', 1);
    const keep = base && !users.includes(base) && !(home && path.basename(home) === base) && !looksSecret(base);
    return `<path>${keep ? `/${base}` : ''}${tail}`;
  });
  for (const u of users.filter((x) => x && x.length >= 4 && !COMMON_USERS.has(x.toLowerCase()))) {
    text = text.replace(new RegExp(`\\b${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), () => { tally('user name', 1); return '<user>'; });
  }

  // the name after "my name is": the next word, plus up to two more that start with a capital
  text = text.replace(NAME_INTRO, (m) => `${m}\u0000`);
  text = text.replace(/\u0000([\p{L}'-]+)((?:\s+\p{Lu}[\p{L}'-]*){0,2})/gu, () => { tally('name', 1); return '<name>'; }).replace(/\u0000/g, '');

  // anything else that still looks like a secret
  text = text.replace(/[A-Za-z0-9_+=-]{20,}/g, (t) => { if (!looksSecret(t)) return t; tally('secret', 1, 'high-entropy string'); return '<secret>'; });

  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = null;
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const at = cut.search(/\s\S*$/);
    truncated = { from: text.length, to: maxChars };
    text = `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).trimEnd()} [truncated]`;
  }
  const list = [...removed.values()];
  const parts = list.map((r) => `${plural(r.n, r.what, PLURALS[r.what])}${r.details.length ? ` (${r.details.join(', ')})` : ''}`);
  if (truncated) parts.push(`cut from ${truncated.from} to ${truncated.to} characters`);
  return { text, removed: list.map(({ what, n, details }) => ({ what, n, ...(details.length ? { details } : {}) })), truncated, note: parts.length ? `removed ${parts.join(', ')}` : 'nothing removed' };
}

// ---------- what each skill is about ----------
const STOP = new Set(`a an and are as at be by for from in into is it its of on or that the this to with without your you we our their them they
  when whenever while use used uses using user users asks ask asked asking request requests requested want wants need needs write writes
  writing written add adds adding create creates creating make makes making update updates updating edit edits editing change changes fix
  fixes fixing refactor refactors refactoring review reviews reviewing help helps work works task tasks code coding file files skill skills
  trigger triggers triggering phrase phrases rule rules house convention conventions style styles guide guides guideline guidelines covering
  cover covers including include includes such like any all every each also only etc example examples eg ie new existing project projects
  team teams do does not don never other more most some how what which who why where there here these those then than so if but about
  over under after before via per just can could should would will may might must one two own same thing things way ways type types kind
  kinds always sure please exactly specific general based app apps`.split(/\s+/).filter(Boolean));
const stem = (w) => (w.length > 3 && /[^su]s$/.test(w) && !STOP.has(w) ? w.slice(0, -1) : w);
export const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
const NEGATIVE_SPLIT = /\b(?:do not|don't|never) (?:use|trigger)\b|\bnot for\b/i;

// The paths: (or globs:) frontmatter of a SKILL.md, as a list of globs.
function scopeGlobs(raw, description) {
  const out = [];
  const lines = String(raw ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:paths|globs):\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim().replace(/^\[|\]$/g, '');
    if (inline) out.push(...inline.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    for (let j = i + 1; j < lines.length && /^\s+-\s/.test(lines[j]); j++) out.push(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
  }
  for (const m of String(description ?? '').matchAll(/(?:^|[\s(,])\*?\.([a-z]{1,6})\b(?![.\w])/gi)) out.push(`**/*.${m[1].toLowerCase()}`);
  return [...new Set(out)];
}
function globRe(glob) {
  let g = glob.replace(/^\.\//, '');
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`(?:^|/)${re}$`);
}

export function skillProfile({ name, description = '', raw = '' }) {
  const [positive, ...rest] = String(description).split(NEGATIVE_SPLIT);
  const quoted = [...positive.matchAll(/"([^"]{2,40})"|`([^`]{2,40})`|“([^”]{2,40})”/g)].map((m) => tokens(m[1] ?? m[2] ?? m[3])).filter((t) => t.length);
  const words = new Set([...tokens(positive), ...tokens(name.replace(/[-_]/g, ' ')), ...quoted.flat()].filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));
  const negWords = new Set(tokens(rest.join(' ')).filter((w) => w.length >= 3 && !STOP.has(w) && !words.has(w)));
  return { name, words: [...words], phrases: quoted.filter((t) => t.length > 1), negWords: [...negWords], globs: scopeGlobs(raw, positive) };
}

const FILE_TOKEN = /[\w./\\-]*\w\.[A-Za-z][\w]{0,7}\b/g;
export function relevance(profile, text, files = [], cwd = null) {
  const toks = tokens(text);
  const set = new Set(toks);
  const has = (seq) => toks.some((_, i) => seq.every((w, k) => toks[i + k] === w));
  const phraseHits = profile.phrases.filter(has);
  const inPhrase = new Set(phraseHits.flat());
  const wordHits = profile.words.filter((w) => set.has(w));
  const negHits = profile.negWords.filter((w) => set.has(w));
  const rel = (f) => { const p = String(f).replace(/\\/g, '/'); return cwd && p.startsWith(`${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`) ? p.slice(cwd.length + 1) : p; };
  const candidates = [...files, ...(String(text).match(FILE_TOKEN) ?? [])].map(rel);
  const scoped = profile.globs.length > 0 && candidates.some((f) => profile.globs.some((g) => globRe(g).test(f)));
  return {
    score: wordHits.length + phraseHits.length - negHits.length,
    hits: [...phraseHits.map((p) => p.join(' ')), ...wordHits.filter((w) => !inPhrase.has(w))],
    negHits, scoped,
  };
}

// Does the prompt name the skill? A one-word name must come with "skill" or a slash, or it is just a word.
export function namesSkill(text, skill, pluginName) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = String(text);
  if (pluginName && new RegExp(`${esc(pluginName)}:${esc(skill)}\\b`, 'i').test(t)) return true;
  if (new RegExp(`/${esc(skill)}\\b`, 'i').test(t)) return true;
  if (/[-_]/.test(skill)) return new RegExp(`\\b${esc(skill).replace(/[-_]/g, '[-_ ]')}\\b`, 'i').test(t);
  return new RegExp(`\\b${esc(skill)}\\s+skill\\b|\\bskill\\s+${esc(skill)}\\b`, 'i').test(t);
}

// ---------- phrases ----------
export const CORRECTION = /\b(?:you (?:should have|should've|forgot|missed|ignored|didn'?t|did not|never)|(?:didn'?t|did not|doesn'?t|does not|not) follow(?:ing)?|follow (?:the|our|my) (?:rules|conventions|guidelines|standards|skill|house style)|use (?:the|our) [\w:-]+ skill|use (?:our|the) (?:skill|conventions|rules|guidelines)|(?:load|invoke|apply|read|run) the [\w:-]+ ?skill|that'?s not (?:how|what|right)|not what i (?:asked|wanted|meant)|why didn'?t you|wrong (?:approach|style|pattern|convention)|against (?:our|the) (?:rules|conventions))\b/i;
const WRONG_STRONG = [
  /\b(?:wrong|irrelevant|unnecessary|unneeded|not (?:the )?right|not relevant|(?:is|was)n'?t relevant|not needed|not applicable|doesn'?t apply|does not apply|no need for)\b/i,
  /\bwhy (?:did|would) you (?:use|load|invoke|call|run|pull in|trigger)\b/i,
  /\b(?:don'?t|do not|stop|never) (?:use|load|invoke|call|trigger)(?:ing)?\b/i,
];
const WRONG_GENERIC = /\b(?:that|this|it)(?:'s| is| was) (?:not relevant|irrelevant|not applicable|unrelated)\b|\bdoes(?:n'?t| not) apply here\b/i;
const CONTEXT_ONLY = /^(?:y|yes|yep|yeah|no|nope|ok|okay|sure|go|go ahead|do it|continue|proceed|thanks|thank you|lgtm|please do|done|next|again|retry|try again)\b/i;
export const dependsOnContext = (t) => { const n = String(t).trim().split(/\s+/).filter(Boolean).length; return n < 4 || (CONTEXT_ONLY.test(String(t).trim()) && n < 8); };

// ---------- transcripts: one session as a list of turns ----------
const INJECTED = /^\s*(?:<(?:task-notification|local-command-[\w-]+|command-(?:name|message|args)|bash-[\w-]+|system-reminder|user-memory-input)>|\[Request interrupted|This session is being continued|Caveat:)/;
const STRIP_TAGS = /<(system-reminder|ide_[\w-]+|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const NOT_HUMAN_SOURCE = new Set(['system', 'sdk', 'suggestion_accepted']);

// What a transcript entry is: a human prompt, a typed slash command, another turn boundary (task
// notification, agent message, compact summary, headless prompt), or nothing that starts a turn.
export function classifyEntry(e) {
  if (!e || typeof e !== 'object' || e.type !== 'user' || e.isSidechain) return { kind: 'skip' };
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return { kind: 'skip' };
  if (e.isMeta) return { kind: 'skip' };
  if (e.isCompactSummary || e.isVisibleInTranscriptOnly) return { kind: 'other', why: 'summary' };
  const cmd = invocationsIn(e).find((i) => i.kind === 'user');
  if (cmd) return { kind: 'command', command: cmd.name };
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n') : '';
  if (/<command-name>/.test(raw)) return { kind: 'other', why: 'command' };
  if (e.entrypoint === 'sdk-cli' || e.promptSource === 'sdk') return { kind: 'other', why: 'headless' };
  if ((e.origin?.kind && e.origin.kind !== 'human') || NOT_HUMAN_SOURCE.has(e.promptSource)) return { kind: 'other', why: 'not typed by a person' };
  if (INJECTED.test(raw)) return { kind: 'other', why: 'injected' };
  const text = raw.replace(STRIP_TAGS, '').trim();
  if (!text) return { kind: 'other', why: 'empty' };
  return { kind: 'prompt', text };
}

export async function readSession(file) {
  const turns = [];
  const stats = { lines: 0, malformed: 0, prompts: 0, headless: 0 };
  let cur = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    stats.lines++;
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { stats.malformed++; continue; }
    if (!e || typeof e !== 'object') { stats.malformed++; continue; }
    if (e.type === 'user') {
      const k = classifyEntry(e);
      if (k.kind === 'skip') continue;
      if (k.kind === 'prompt') stats.prompts++;
      if (k.why === 'headless') stats.headless++;
      const at = Date.parse(e.timestamp ?? '');
      cur = { kind: k.kind, uuid: e.uuid ?? null, at: Number.isFinite(at) ? at : null, cwd: typeof e.cwd === 'string' ? e.cwd : null, text: k.text ?? null, command: k.command ?? null, fired: [], files: [] };
      turns.push(cur);
    } else if (e.type === 'assistant' && cur && !e.isSidechain) {
      for (const inv of invocationsIn(e)) if (inv.kind === 'model') cur.fired.push(inv.name);
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== 'tool_use' || !FILE_TOOLS.has(b.name)) continue;
        const f = b.input?.file_path ?? b.input?.notebook_path ?? b.input?.path;
        if (typeof f === 'string' && f.length < 1024) cur.files.push(f);
      }
    }
  }
  return { turns, stats };
}

// ---------- the heuristics, per session ----------
const clamp = (x) => Math.round(Math.max(0.05, Math.min(0.95, x)) * 100) / 100;
export const confidenceLabel = (c) => (c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low');
const when = (n) => (n === 1 ? 'in the next turn' : `${n} turns later`);
const matchText = (r) => [r.hits.length ? `the description (${r.hits.slice(0, 5).join(', ')})` : null, r.scoped ? 'a file in its paths: scope' : null].filter(Boolean).join(' and ');

function lookahead(turns, i, maxTurns, maxMs, visit) {
  let human = 0;
  for (let j = i + 1; j < turns.length; j++) {
    const u = turns[j];
    if (u.kind === 'other') continue;
    if (++human > maxTurns) return;
    if (turns[i].at !== null && u.at !== null && u.at - turns[i].at > maxMs) return;
    if (visit(u, human) === false) return;
  }
}

// Raw candidates from one session: { skill, kind, turn, rel, confidence, why }. Prompt text stays raw
// here (the orchestrator anonymises it); nothing from an assistant entry is in the result but skill names.
export function mineSession(turns, skills, { pluginName = null } = {}) {
  const out = [];
  for (const s of skills) {
    const is = (n) => n && invokedAs(n, s.name, pluginName);
    // a correction that names another skill, or complains that one fired, is about that one, not this one
    const correctsThis = (text) => CORRECTION.test(text) && !skills.some((o) => o.name !== s.name && namesSkill(text, o.name, pluginName)) && !(/\bskills?\b/i.test(text) && WRONG_STRONG.some((re) => re.test(text)));
    let loaded = false;
    turns.forEach((t, i) => {
      const fired = t.fired.some(is);
      if (t.kind === 'prompt') {
        const rel = relevance(s.profile, t.text, t.files, t.cwd);
        const names = namesSkill(t.text, s.name, pluginName);
        if (fired) {
          let wrong = null;
          lookahead(turns, i, WRONG_TURNS, WRONG_MS, (u, n) => {
            if (u.kind !== 'prompt') return false;
            const aboutIt = /\bskills?\b/i.test(u.text) || namesSkill(u.text, s.name, pluginName) || new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(u.text);
            if (aboutIt && WRONG_STRONG.some((re) => re.test(u.text))) { wrong = { n, strong: true }; return false; }
            if (WRONG_GENERIC.test(u.text)) { wrong = { n, strong: false }; return false; }
            return true;
          });
          if (wrong) {
            const c = (wrong.strong ? 0.85 : 0.55) - (rel.score >= 3 ? 0.1 : 0) + (rel.negHits.length ? 0.05 : 0);
            out.push({ skill: s.name, kind: 'no-trigger', turn: t, rel, confidence: clamp(c),
              why: `${s.name} fired, then the user said it was ${wrong.strong ? 'the wrong skill or irrelevant' : 'irrelevant'} ${when(wrong.n)}${rel.negHits.length ? `; the prompt matches what its description excludes (${rel.negHits.slice(0, 4).join(', ')})` : ''}` });
          } else if (!CORRECTION.test(t.text)) {
            let c = 0.45 + 0.15 * Math.min(Math.max(rel.score, 0), 2) + (rel.scoped ? 0.1 : 0);
            if (names) c = Math.min(c, 0.4);
            out.push({ skill: s.name, kind: 'trigger', turn: t, rel, confidence: clamp(c),
              why: `${s.name} fired on this prompt${names ? '; it names the skill outright, so it tests little beyond the name' : matchText(rel) ? `; it matches ${matchText(rel)}` : '; no description keyword matched, so it may have fired on earlier context'}` });
          }
        } else if (!loaded && (rel.score >= 1 || rel.scoped)) {
          let signal = null;
          lookahead(turns, i, MISSED_TURNS, MISSED_MS, (u, n) => {
            if (u.kind === 'command') { if (is(u.command)) { signal = { how: `typed /${u.command}`, base: 0.65, n }; return false; } return true; }
            const firedU = u.fired.some(is);
            const corrected = correctsThis(u.text);
            const named = namesSkill(u.text, s.name, pluginName);
            if (firedU && corrected) { signal = { how: 'corrected the agent and the skill fired', base: 0.6, n }; return false; }
            if (named) { signal = { how: 'named the skill', base: 0.55, n }; return false; }
            if (firedU) return false; // it fired on a new request with no correction: no signal about this one
            if (corrected && !signal && (rel.score >= 2 || rel.scoped)) signal = { how: 'corrected the agent', base: 0.3, n };
            return true;
          });
          if (signal) {
            const c = signal.base + Math.min(0.3, 0.1 * Math.max(rel.score, 0)) + (rel.scoped ? 0.1 : 0) + (signal.n === 1 ? 0.05 : 0) - (names ? 0.2 : 0);
            out.push({ skill: s.name, kind: 'missed', turn: t, rel, confidence: clamp(c),
              why: `${s.name} did not fire, then the user ${signal.how} ${when(signal.n)}; the prompt matches ${matchText(rel)}` });
          }
        }
      }
      if (fired || (t.kind === 'command' && is(t.command))) loaded = true;
    });
  }
  return out;
}

// ---------- dedupe ----------
const normTokens = (s) => new Set(String(s).toLowerCase().replace(/<[^>]*>/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
export function jaccard(a, b) {
  const A = a instanceof Set ? a : normTokens(a), B = b instanceof Set ? b : normTokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- orchestration ----------
async function listSessions(dir, acc = [], depth = 0) {
  if (depth > 4) return acc;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'subagents') await listSessions(p, acc, depth + 1); } // sub-agent prompts are written by the agent
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}
const homeOf = (cwd) => cwd?.match(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/)?.[1] ?? null;

export async function mineCases(pluginDir, { since = DEFAULT_SINCE, projects = null, skill = null, max = DEFAULT_MAX, transcripts = defaultTranscriptsDir(), now = Date.now(), osUser = os.userInfo().username, osHome = os.homedir(), maxChars = MAX_CHARS } = {}) {
  const dir = path.resolve(pluginDir);
  const plugin = await loadPlugin(dir);
  const pluginName = plugin.manifest?.json?.name ?? path.basename(dir);
  let skills = plugin.skills.map((s) => {
    const name = (s.fm.fields.name?.value ?? '').trim() || s.dirName;
    const description = (s.fm.fields.description?.value ?? '').trim();
    return { name, description, profile: skillProfile({ name, description, raw: s.fm.raw }) };
  });
  if (skill) {
    if (!skills.some((s) => s.name === skill)) throw new Error(`no skill named ${skill} in ${pluginName} (it has ${skills.map((s) => s.name).join(', ') || 'none'})`);
    skills = skills.filter((s) => s.name === skill);
  }
  const cutoff = parseSince(since, now);
  const evalDir = resolveEvalDir(dir);
  const existing = [];
  try { for (const c of loadSuite(dir).cases) if (c.prompt) existing.push({ name: c.name, tokens: normTokens(splitFrontmatter(readFileSync(c.prompt.path, 'utf8')).after.join('\n')) }); } catch { /* no suite yet */ }

  const scan = { found: existsSync(transcripts), projects: 0, files: 0, skippedOld: 0, lines: 0, malformed: 0, prompts: 0, headless: 0 };
  const raw = new Map(); // uuid|skill -> best raw candidate (a resumed session repeats its history)
  const promptsSeen = new Set();
  if (scan.found) {
    const match = projects ? globToRegExp(projects) : null;
    const dirs = (await fs.readdir(transcripts, { withFileTypes: true })).filter((e) => e.isDirectory() && (!match || match.test(e.name))).map((e) => e.name).sort();
    for (const d of dirs) {
      const files = (await listSessions(path.join(transcripts, d))).sort();
      if (files.length) scan.projects++;
      for (const f of files) {
        let st;
        try { st = await fs.stat(f); } catch { continue; }
        if (st.mtimeMs < cutoff) { scan.skippedOld++; continue; }
        scan.files++;
        const { turns, stats } = await readSession(f);
        scan.lines += stats.lines; scan.malformed += stats.malformed; scan.headless += stats.headless;
        for (const t of turns) if (t.kind === 'prompt' && (t.at ?? st.mtimeMs) >= cutoff) promptsSeen.add(t.uuid ?? t);
        for (const c of mineSession(turns, skills, { pluginName })) {
          if ((c.turn.at ?? st.mtimeMs) < cutoff) continue;
          const key = `${c.turn.uuid ?? `${f}:${turns.indexOf(c.turn)}`}|${c.skill}`;
          const prev = raw.get(key);
          const rank = (x) => (x.kind === 'no-trigger' ? 1 : 0) * 10 + x.confidence;
          if (!prev || rank(c) > rank(prev)) raw.set(key, c);
        }
      }
    }
  }
  scan.prompts = promptsSeen.size; // the same prompt uuid in several files is one prompt

  const dropped = { 'depends on earlier turns': 0, 'empty after anonymisation': 0, 'already in the suite': 0, 'near duplicate': 0, 'over --max': 0 };
  const users = [...new Set([osUser, osHome && path.basename(osHome)].filter(Boolean))];
  const kept = [];
  for (const c of raw.values()) {
    if (dependsOnContext(c.turn.text)) { dropped['depends on earlier turns']++; continue; }
    const home = homeOf(c.turn.cwd) ?? osHome;
    const a = anonymise(c.turn.text, { cwd: c.turn.cwd, home, users: [...new Set([...users, home && path.basename(home)].filter(Boolean))], maxChars });
    if (a.text.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length < 3) { dropped['empty after anonymisation']++; continue; }
    const tk = normTokens(a.text);
    const dup = existing.find((x) => jaccard(tk, x.tokens) >= SIMILAR);
    if (dup) { dropped['already in the suite']++; continue; }
    const id = `mined-${slugify(c.skill, 32)}-${c.kind}-${createHash('sha1').update(`${c.skill}\n${c.kind}\n${a.text}`).digest('hex').slice(0, 6)}`;
    if (existsSync(path.join(evalDir, id))) { dropped['already in the suite']++; continue; } // accepted earlier, then edited
    kept.push({ id, skill: c.skill, kind: c.kind, confidence: c.confidence, label: confidenceLabel(c.confidence), date: day(c.turn.at), at: c.turn.at ?? 0,
      why: c.why, prompt: a.text, removed: a.removed, note: a.note, tokens: tk });
  }

  // near duplicates within a skill and polarity: keep the most confident, then the most recent
  kept.sort((x, y) => y.confidence - x.confidence || y.at - x.at || x.id.localeCompare(y.id));
  const unique = [];
  for (const c of kept) {
    if (unique.some((u) => u.skill === c.skill && KINDS[u.kind].polarity === KINDS[c.kind].polarity && jaccard(u.tokens, c.tokens) >= SIMILAR)) { dropped['near duplicate']++; continue; }
    unique.push(c);
  }
  // --max per skill, taken round robin across kinds (missed, then near-miss, then trigger) so the rarer
  // kinds are not crowded out by plain triggers
  const chosen = [];
  for (const s of skills) {
    const byKind = ['missed', 'no-trigger', 'trigger'].map((k) => unique.filter((c) => c.skill === s.name && c.kind === k));
    const pick = [];
    while (pick.length < max && byKind.some((l) => l.length)) for (const l of byKind) if (l.length && pick.length < max) pick.push(l.shift());
    dropped['over --max'] += byKind.reduce((n, l) => n + l.length, 0);
    chosen.push(...pick.sort((x, y) => y.confidence - x.confidence || x.id.localeCompare(y.id)));
  }
  const fresh = chosen.map(({ tokens: _t, at: _a, ...c }) => c);

  return {
    schemaVersion: 1, plugin: pluginName, pluginDir: dir, evalDir, generatedAt: new Date(now).toISOString(),
    window: { since: day(cutoff), days: Math.max(0, Math.round((now - cutoff) / DAY)) },
    scan: { ...scan, projectFilter: projects },
    skills: skills.map((s) => ({ name: s.name, keywords: s.profile.words.length, phrases: s.profile.phrases.length, scope: s.profile.globs,
      candidates: Object.fromEntries(Object.keys(KINDS).map((k) => [k, fresh.filter((c) => c.skill === s.name && c.kind === k).length])) })),
    dropped, candidates: fresh,
  };
}

// ---------- case files ----------
const yamlString = (s) => JSON.stringify(String(s));
export function caseFiles(c) {
  const fire = KINDS[c.kind].polarity === 'fire';
  const tags = ['mined', slugify(c.skill), fire ? 'trigger' : 'negative-trigger'];
  const prompt = ['---',
    `description: ${yamlString(`Mined by case-miner from a real session on ${c.date ?? 'an unknown date'} (${KINDS[c.kind].label}, ${c.label} confidence): ${c.why}.`)}`,
    `tags: [${tags.join(', ')}]`,
    'max_turns: 6',
    'allowed_tools: [Read, Glob, Grep, Skill]',
    '---',
    c.prompt, ''].join('\n');
  const grader = fire
    ? ['---', 'type: tool_used', 'tool: Skill', `input_match: '${triggerMatch(c.skill)}'`, 'min: 1', 'arm: with-only', '---',
      `The ${c.skill} skill fired on a prompt a real user wrote (also matches its namespaced plugin:${c.skill} form). An indicator only: never scored against the no-plugin arm.`, '']
    : ['---', 'type: tool_used', 'tool: Skill', `input_match: '${triggerMatch(c.skill)}'`, 'min: 0', 'max: 0', 'arm: both', '---',
      `The ${c.skill} skill must NOT fire: a real user said it was wrong or irrelevant on this prompt.`, ''];
  return [{ rel: 'prompt.md', text: prompt }, { rel: `graders/${KINDS[c.kind].grader}.md`, text: grader.join('\n') }];
}

// Write the files to a temp case dir and run every suite-doctor static rule on it.
export function validateCaseFiles(files, name = 'candidate') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'case-miner-'));
  try {
    const d = path.join(root, name);
    for (const f of files) { mkdirSync(path.dirname(path.join(d, f.rel)), { recursive: true }); writeFileSync(path.join(d, f.rel), f.text); }
    return doctorFindings(root, d);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function doctorFindings(evalDir, dir) {
  const c = loadCase(evalDir, dir);
  return RULES.flatMap((r) => r.detect(c).map((f) => ({ level: f.level ?? r.level, rule: r.id, file: f.file, message: f.message })));
}

// ---------- staging ----------
export const defaultStaging = (pluginDir) => path.join(path.resolve(pluginDir), '.eval-candidates');
const isInside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
// The runner loads every case dir under the eval dir, dot dirs too, so staging there would run the candidates.
export function checkStaging(staging, pluginDir) {
  const evalDir = resolveEvalDir(path.resolve(pluginDir));
  if (isInside(path.resolve(staging), evalDir)) throw new Error(`${displayPath(staging)} is inside the eval dir ${displayPath(evalDir)}: claude plugin eval would load and run the staged candidates. Stage them outside it (the default is ${displayPath(defaultStaging(pluginDir))})`);
  return path.resolve(staging);
}
const INDEX = 'index.json';
function readIndex(staging) {
  try { const j = JSON.parse(readFileSync(path.join(staging, INDEX), 'utf8')); return Array.isArray(j.candidates) ? j : { candidates: [] }; } catch { return { candidates: [] }; }
}
function writeIndex(staging, index) {
  index.candidates = index.candidates.filter((c) => existsSync(path.join(staging, c.id)));
  writeFileSync(path.join(staging, INDEX), JSON.stringify(index, null, 2) + '\n');
  writeFileSync(path.join(staging, 'candidates.md'), candidatesMarkdown(index));
}

export function writeCandidates(plan, staging = defaultStaging(plan.pluginDir)) {
  staging = checkStaging(staging, plan.pluginDir);
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, '.gitignore'), '# case-miner staging: anonymised prompts from your own sessions, kept out of git until you accept them\n*\n');
  const index = readIndex(staging);
  const written = [], kept = [], invalid = [];
  for (const c of plan.candidates) {
    const dir = path.join(staging, c.id);
    if (existsSync(dir)) { kept.push(c.id); if (!index.candidates.some((x) => x.id === c.id)) index.candidates.push(c); continue; } // staged before: never clobber your edits
    const files = caseFiles(c);
    const errors = validateCaseFiles(files, c.id).filter((f) => f.level === 'ERROR');
    if (errors.length) { invalid.push({ id: c.id, errors }); continue; }
    for (const f of files) { mkdirSync(path.dirname(path.join(dir, f.rel)), { recursive: true }); writeFileSync(path.join(dir, f.rel), f.text); }
    index.candidates = index.candidates.filter((x) => x.id !== c.id).concat(c);
    written.push(c.id);
  }
  index.schemaVersion = 1; index.plugin = plan.plugin; index.updatedAt = plan.generatedAt;
  index.candidates.sort((a, b) => a.skill.localeCompare(b.skill) || b.confidence - a.confidence || a.id.localeCompare(b.id));
  writeIndex(staging, index);
  return { staging, written, kept, invalid };
}

const fence = (s) => '`'.repeat(Math.max(3, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length + 1)));
export function candidatesMarkdown(index) {
  const cs = index.candidates ?? [];
  const lines = [`# Mined case candidates${index.plugin ? `: ${index.plugin}` : ''}`, '',
    'Each candidate is a real prompt from your own sessions, anonymised on this machine. Read every prompt below before you accept it:',
    'the anonymiser is a heuristic and can miss something. Edit a case dir freely; accept moves it into the suite unchanged.', '',
    `Accept: \`node tools/case-miner.mjs accept <id...> --plugin <plugin-dir>\`. Reject: delete its directory.`, ''];
  if (!cs.length) lines.push('No candidates staged.');
  for (const c of cs) {
    const f = fence(c.prompt);
    lines.push(`## ${c.id}`, '',
      `- skill: \`${c.skill}\`, ${KINDS[c.kind]?.label ?? c.kind} (${KINDS[c.kind]?.polarity === 'quiet' ? 'the skill must not fire' : 'the skill must fire'})`,
      `- source: a session on ${c.date ?? 'an unknown date'}`,
      `- why: ${c.why}`,
      `- confidence: ${c.label} (${c.confidence})`,
      `- anonymised: ${c.note}`, '', `${f}text`, c.prompt, f, '');
  }
  return lines.join('\n');
}

const ID_RE = /^[\w][\w.-]*$/;
export function acceptCandidates(ids, { pluginDir, staging = defaultStaging(pluginDir) } = {}) {
  staging = checkStaging(staging, pluginDir);
  const evalDir = resolveEvalDir(path.resolve(pluginDir));
  const moved = [], refused = [];
  for (const id of ids) {
    if (!ID_RE.test(id) || id.includes('..')) { refused.push({ id, why: 'not a candidate id' }); continue; }
    const src = path.join(staging, id), dest = path.join(evalDir, id);
    if (existsSync(dest)) { refused.push({ id, why: `${displayPath(dest)} already exists; not overwritten` }); continue; }
    if (!existsSync(path.join(src, 'prompt.md'))) { refused.push({ id, why: `no staged candidate ${id} in ${displayPath(staging)}` }); continue; }
    const errors = doctorFindings(staging, src).filter((f) => f.level === 'ERROR');
    if (errors.length) { refused.push({ id, why: `fails suite-doctor: ${errors.map((e) => `${e.file} ${e.message}`).join('; ')}` }); continue; }
    mkdirSync(evalDir, { recursive: true });
    try { renameSync(src, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true });
    }
    moved.push(id);
  }
  if (existsSync(staging)) writeIndex(staging, readIndex(staging));
  return { evalDir, moved, refused };
}

// ---------- output ----------
const oneLine = (s, n = 90) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
export function formatText(plan, res = null, { dryRun = false } = {}) {
  const s = plan.scan;
  const out = [`case-miner: ${plural(plan.skills.length, 'skill')} in ${plan.plugin}; ${!s.found ? 'no session transcripts found'
    : `${plural(s.prompts, 'prompt')} in ${plural(s.files, 'transcript file')} (${plural(s.projects, 'project')}${s.projectFilter ? ` matching ${s.projectFilter}` : ''})`} since ${plan.window.since}${s.malformed ? `, ${plural(s.malformed, 'malformed line')} skipped` : ''}`];
  for (const sk of plan.skills) {
    const cs = plan.candidates.filter((c) => c.skill === sk.name);
    const parts = Object.entries(sk.candidates).filter(([, n]) => n).map(([k, n]) => plural(n, KINDS[k].label));
    out.push(`  ${sk.name}: ${cs.length ? parts.join(', ') : 'no candidates'}`);
    for (const c of cs) {
      out.push(`    ${c.label.padEnd(6)} ${c.id}  ${c.date ?? '?'}  ${c.why}`);
      out.push(`           "${oneLine(c.prompt)}"  (${c.note})`);
    }
  }
  const left = Object.entries(plan.dropped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  if (left.length) out.push(`left out: ${left.join(', ')}`);
  if (dryRun) out.push('dry run: nothing written.');
  else if (res) {
    out.push(`staged ${plural(res.written.length, 'new candidate')}${res.kept.length ? ` (${res.kept.length} already staged, left as they are)` : ''} in ${displayPath(res.staging)}/`);
    for (const i of res.invalid) out.push(`  not staged ${i.id}: ${i.errors.map((e) => e.message).join('; ')}`);
    const custom = res.staging !== defaultStaging(plan.pluginDir) ? ` --out ${displayPath(res.staging)}` : '';
    if (plan.candidates.length) out.push(`review ${displayPath(path.join(res.staging, 'candidates.md'))}, then: node tools/case-miner.mjs accept <id...> --plugin ${displayPath(plan.pluginDir)}${custom}`);
  }
  return out.join('\n');
}

// ---------- CLI ----------
function findPluginRoot(start) {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.claude-plugin/plugin.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = ['usage: case-miner.mjs <plugin-dir> [--since 30d] [--projects <glob>] [--skill <name>] [--max N] [--transcripts <dir>] [--out <dir>] [--json [out]] [--dry-run]',
    '       case-miner.mjs accept <id...> [--plugin <dir>] [--out <dir>]'].join('\n');
  const fail = (msg) => { console.error(msg ? `${msg}\n${usage}` : usage); process.exit(2); };
  const argv = process.argv.slice(2);
  if (argv[0] === '-h' || argv[0] === '--help') { console.log(usage); process.exit(0); }
  const VALUED = { '--since': 'since', '--projects': 'projects', '--skill': 'skill', '--max': 'max', '--transcripts': 'transcripts', '--out': 'out', '--plugin': 'plugin' };
  const opt = { since: DEFAULT_SINCE, max: String(DEFAULT_MAX), json: null, dryRun: false };
  const pos = [];
  const accept = argv[0] === 'accept';
  for (let i = accept ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED[a]) { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) fail(`${a} needs a value`); opt[VALUED[a]] = argv[++i]; }
    else if (a === '--json' && !accept) { const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt.json = v; i++; } else opt.json = '-'; }
    else if (a === '--dry-run' && !accept) opt.dryRun = true;
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('--')) pos.push(a);
    else fail(`unknown option ${a}`);
  }

  if (accept) {
    if (!pos.length) fail('accept needs at least one candidate id');
    const pluginDir = opt.plugin ?? findPluginRoot(process.cwd());
    if (!pluginDir || !existsSync(pluginDir)) fail(opt.plugin ? `no such directory: ${opt.plugin}` : 'no plugin found above the current directory: pass --plugin <dir>');
    let r;
    try { r = acceptCandidates(pos, { pluginDir, staging: opt.out ? path.resolve(opt.out) : defaultStaging(pluginDir) }); } catch (e) { fail(`case-miner: ${e.message}`); }
    for (const id of r.moved) console.log(`accepted ${id} -> ${displayPath(path.join(r.evalDir, id))}/`);
    for (const x of r.refused) console.log(`refused  ${x.id}: ${x.why}`);
    if (r.moved.length) console.log(`check the suite with: node tools/suite-doctor.mjs ${displayPath(path.resolve(pluginDir))}`);
    process.exit(r.refused.length ? 1 : 0);
  }

  if (pos.length !== 1) fail(pos.length ? `unexpected argument ${pos[1]}` : '');
  if (!existsSync(pos[0])) fail(`no such directory: ${pos[0]}`);
  const max = Number(opt.max);
  if (!Number.isInteger(max) || max < 1) fail(`--max must be a whole number of at least 1, got "${opt.max}"`);
  let plan;
  try {
    plan = await mineCases(pos[0], { since: opt.since, projects: opt.projects ?? null, skill: opt.skill ?? null, max, transcripts: opt.transcripts ? path.resolve(opt.transcripts) : defaultTranscriptsDir() });
  } catch (e) { fail(`case-miner: ${e.message}`); }
  let res = null;
  try {
    const staging = checkStaging(opt.out ? path.resolve(opt.out) : defaultStaging(pos[0]), pos[0]);
    if (!opt.dryRun) res = writeCandidates(plan, staging);
  } catch (e) { fail(`case-miner: ${e.message}`); }
  const { pluginDir: _p, evalDir: _e, ...shown } = plan;
  const json = JSON.stringify({ ...shown, dryRun: opt.dryRun, staged: res ? { dir: displayPath(res.staging), written: res.written, kept: res.kept, invalid: res.invalid } : null }, null, 2) + '\n';
  if (opt.json === '-') process.stdout.write(json);
  else console.log(formatText(plan, res, { dryRun: opt.dryRun }));
  if (opt.json && opt.json !== '-') await fs.writeFile(opt.json, json);
  process.exit(0);
}
