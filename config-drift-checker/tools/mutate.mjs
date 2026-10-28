#!/usr/bin/env node
// mutate: are my evals any good? Mutation testing for an agent setup.
//
//   node tools/mutate.mjs <plugin> [--operators delete-rule,blur-trigger,drop-skill,disable-hook,invert-rule,delete-section]
//        [--max-mutants N] [--seed s] [--full] [--runs 1] [--budget 5] [--baseline <aggregate-result.json>]
//        [--defaults] [--runner auto|official|shim] [--concurrency n] [--history <dir>] [--out-dir <dir>]
//        [--json <file>|-] [--md <file>|-] [--html <file>] [--dry-run]
//
// A mutant is one small sabotage of the setup, made in a temp copy of the plugin (the original is never
// touched), and a good suite goes red on it. Operators, each deterministic:
//   delete-rule    remove one rule bullet from CLAUDE.md or a SKILL.md body (rule ids as config-coverage prints them)
//   blur-trigger   replace a skill's description with a vague generic one (the frontmatter stays valid)
//   drop-skill     remove a skill directory, and its entry in plugin.json
//   disable-hook   remove one hook entry from the hooks config
//   invert-rule    negate a must / never / always / do not rule by a word swap (heuristic: it can read oddly).
//                  It records what may mask the swap: the rest of the same rule (the swap is in a later
//                  sentence) and the other rules under the same heading, and a missed inversion says so.
//   delete-section remove every rule under one heading that has two or more, so rules that back each other
//                  up (constructor injection only / never field injection) are tested together
//
// Each mutant runs only the cases relevant to it: cases whose covers.yaml names the rule, and for a skill or
// hook mutant also the cases that mention the skill or the hook's script. --full then runs the rest of the
// suite on a mutant the relevant cases missed. A mutant is killed (caught) when any case regresses against a
// reference run of the unmutated setup, by the eval-classify score threshold from .cdc.yml; the reference is
// one run of the original, or --baseline <result.json> (cases it lacks are run). A mutant no case is relevant
// to is "nothing tests it": a coverage gap, not just a weak test. Score = killed / (killed + survived), where
// the mutants nothing tests count as survived.
//
// --max-mutants N samples N mutants, round-robin across operators, reproducibly for one --seed.
// --budget caps the whole session, the reference run included: no mutant starts once it is spent, and those
// show as not run. --dry-run lists the mutants with an estimated cost from past results and spends $0.
// --out-dir keeps every suite result (reference.json can be the next --baseline).
// --defaults also runs the reference with no plugin loaded (one extra arm, on the reference only, so it
// roughly doubles the reference cost). A missed rule whose related graders pass in every no-plugin run is
// marked as a model default: today the model does it anyway, so the rule is not steering anything, but its
// grader stays useful as a tripwire for the release that changes that. Graders are related to a rule by
// shared words. A case that scores as well with no plugin is flagged too. With
// --baseline the reference still runs once, for the no-plugin arm; the baseline's scores stay the reference.
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { coverage, rulesFromHooks, assignIds, slug } from './config-coverage.mjs';
import { runSuite, usableReason } from './cc-release.mjs';
import { key, classifyCase, normalizeResult, resolveThresholds } from './eval-classify.mjs';
import { readResults } from './drift-matrix.mjs';

export const OPERATORS = ['delete-rule', 'blur-trigger', 'drop-skill', 'disable-hook', 'invert-rule', 'delete-section'];
const RULE_OPS = new Set(['delete-rule', 'invert-rule', 'delete-section']);
export const BLURRED = 'Helps with general tasks. Use when it seems useful.';
const SKIP_DIRS = new Set(['node_modules', '.git', 'results', 'evals', 'target', 'dist']);

const readText = async (p) => (existsSync(p) ? fs.readFile(p, 'utf8') : null);
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(2)}` : 'n/a');
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : 'n/a');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const unquote = (s) => String(s ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
const short = (s, n = 60) => { const t = String(s).replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
export const andList = (xs, max = 6) => { const a = xs.length > max ? [...xs.slice(0, max), `${xs.length - max} more`] : xs; return a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`; };

// ---------- the suite: cases, what each covers, and the text each one mentions ----------
export async function loadSuite(plugin) {
  const manifest = (await readJson(path.join(plugin, '.claude-plugin', 'plugin.json'))) ?? {};
  const cov = await coverage(plugin);
  const evalRel = manifest.experimental?.evals ?? 'evals', evalDir = path.join(plugin, evalRel);
  const cases = [];
  for (const c of [...cov.cases].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const dir = path.join(evalDir, c.dir), parts = [c.dir, await readText(path.join(dir, 'prompt.md')), await readText(path.join(dir, 'case.yaml'))], graders = [];
    for (const sub of ['graders', '.']) {
      const d = path.join(dir, sub);
      if (existsSync(d)) for (const f of (await fs.readdir(d)).filter((x) => /\.(md|sh|bash)$/.test(x) && x !== 'prompt.md').sort()) {
        const text = await readText(path.join(d, f));
        parts.push(text);
        if (sub === 'graders' && f.endsWith('.md')) graders.push({ name: f.replace(/\.md$/, ''), text: text ?? '' });
      }
    }
    cases.push({ dir: c.dir, covers: c.covers, text: parts.filter(Boolean).join('\n').toLowerCase(), graders });
  }
  return { manifest, cov, evalRel, cases };
}

async function skillFiles(plugin, manifest) {
  const out = new Set();
  for (const s of manifest.skills ?? []) { const p = path.join(plugin, s, 'SKILL.md'); if (existsSync(p)) out.add(p); }
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), depth + 1); }
      else if (e.name === 'SKILL.md') out.add(path.join(dir, e.name));
    }
  };
  await walk(plugin, 0);
  return [...out].sort();
}

// ---------- operators: pure text edits, so every mutant is reproducible ----------
// the description: line and its indented continuation lines become one generic line; null when there is none
export function blurDescription(src, text = BLURRED) {
  const lines = src.split('\n'), bare = (l) => l.replace(/\r$/, '');
  if (bare(lines[0] ?? '') !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && bare(l) === '---');
  const at = lines.findIndex((l, i) => i > 0 && i < end && /^description:/.test(l));
  if (end < 0 || at < 0) return null;
  let stop = at + 1;
  while (stop < end && /^\s+\S/.test(lines[stop])) stop++;
  const eol = lines[at].endsWith('\r') ? '\r' : '';
  return [...lines.slice(0, at), `description: ${text}${eol}`, ...lines.slice(stop)].join('\n');
}

// longer phrases first, so "must not" is found before "must"
const SWAPS = [['must not', 'must'], ["mustn't", 'must'], ['do not', 'do'], ["don't", 'do'], ['never', 'always'], ['always', 'never'], ['must', 'must not']];
const matchCase = (from, to) => (from.length > 1 && from === from.toUpperCase() ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);
// the first must / never / always / do not in lines[a..b] (0-based, inclusive), swapped; null when there is none
export function invertLines(lines, a, b) {
  for (let i = a; i <= b; i++) {
    let best = null;
    for (const [from, to] of SWAPS) {
      const m = lines[i].match(new RegExp(`(?<![\\w'])${from.replace("'", "['’]")}(?![\\w'])`, 'i'));
      if (m && (!best || m.index < best.index)) best = { index: m.index, from: m[0], to: matchCase(m[0], to) };
    }
    if (best) {
      const out = [...lines];
      out[i] = lines[i].slice(0, best.index) + best.to + lines[i].slice(best.index + best.from.length);
      return { lines: out, from: best.from, to: best.to, line: i, index: best.index };
    }
  }
  return null;
}

// true when the swap in lines[a..b] sits after the rule's first sentence, so the rest of the rule still says
// the opposite ("Every response is wrapped: ... Never return raw entities" inverted to "Always return ...")
export function swapAfterFirstSentence(lines, a, b, inv) {
  const before = lines.slice(a, inv.line).map((l) => `${l}\n`).join('') + lines[inv.line].slice(0, inv.index);
  const body = before.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\b(e\.g|i\.e|etc|vs)\./gi, '$1');
  return /[.;:!?](\s|$)/.test(body.replace(/`[^`]*`/g, ''));
}

function hooksSource(manifest, plugin) {
  if (typeof manifest.hooks === 'string') return { file: path.normalize(manifest.hooks), inline: false };
  if (manifest.hooks && typeof manifest.hooks === 'object') return { file: path.join('.claude-plugin', 'plugin.json'), inline: true };
  return existsSync(path.join(plugin, 'hooks', 'hooks.json')) ? { file: path.join('hooks', 'hooks.json'), inline: false } : null;
}
const scriptWords = (cmd) => [...String(cmd).matchAll(/([\w.-]+)\.(?:mjs|cjs|js|ts|sh|bash|py)\b/g)].flatMap((m) => [m[0], ...(m[1].length >= 4 ? [m[1]] : [])]);

// Every mutant of the setup: { id, operator, file, ruleId, skill, hook, description, heuristic, targets, ops }.
// ops are the edits to make in a copy: { path, content } writes a file, { path, remove: true } deletes one.
export async function generateMutants(plugin, suite, { operators = OPERATORS } = {}) {
  const want = new Set(operators), out = [];
  const add = (m) => out.push({ ruleId: null, skill: null, hook: null, heuristic: false, ...m });
  const rulesByFile = new Map();
  for (const r of suite.cov.rules.filter((x) => x.scope !== 'hook')) rulesByFile.set(r.source, [...(rulesByFile.get(r.source) ?? []), r]);
  for (const [file, rules] of rulesByFile) {
    const src = await fs.readFile(path.join(plugin, file), 'utf8'), lines = src.split('\n');
    const sections = new Map();
    for (const r of rules) if (r.heading) sections.set(r.heading, [...(sections.get(r.heading) ?? []), r]);
    for (const r of rules) {
      const a = (r.start ?? r.line) - 1, b = r.line - 1;
      if (want.has('delete-rule')) add({ operator: 'delete-rule', file, ruleId: r.id, description: `deleted rule '${short(r.text)}' from ${file}`,
        targets: { rules: [r.id], mentions: [], texts: [r.text] }, ops: [{ path: file, content: [...lines.slice(0, a), ...lines.slice(b + 1)].join('\n') }] });
      const inv = want.has('invert-rule') ? invertLines(lines, a, b) : null;
      if (inv) add({ operator: 'invert-rule', file, ruleId: r.id, heuristic: true, description: `inverted rule '${short(r.text)}' in ${file} ('${inv.from}' became '${inv.to}')`,
        masking: { sameRule: swapAfterFirstSentence(lines, a, b, inv), section: r.heading ?? null, siblings: r.heading ? sections.get(r.heading).filter((x) => x !== r).map((x) => x.id) : [] },
        targets: { rules: [r.id], mentions: [], texts: [r.text] }, ops: [{ path: file, content: inv.lines.join('\n') }] });
    }
    if (want.has('delete-section')) for (const [heading, rs] of sections) {
      if (rs.length < 2) continue;
      const drop = new Set(rs.flatMap((r) => Array.from({ length: r.line - (r.start ?? r.line) + 1 }, (_, k) => (r.start ?? r.line) - 1 + k)));
      add({ operator: 'delete-section', file, section: heading, description: `deleted section '${short(heading)}' (${rs.length} rules) from ${file}`,
        targets: { rules: rs.map((r) => r.id), mentions: [], texts: rs.map((r) => r.text) }, ops: [{ path: file, content: lines.filter((_, i) => !drop.has(i)).join('\n') }] });
    }
  }
  for (const p of await skillFiles(plugin, suite.manifest)) {
    const file = path.relative(plugin, p), dir = path.dirname(file), src = await fs.readFile(p, 'utf8');
    const name = unquote((src.match(/^---[\s\S]*?^name:\s*(.+)$/m) ?? [])[1] ?? path.basename(path.dirname(p)));
    const scope = `skill/${slug(name)}`;
    const targets = { rules: suite.cov.rules.filter((r) => r.scope === scope).map((r) => r.id), mentions: [...new Set([name, path.basename(path.dirname(p))])] };
    const blurred = want.has('blur-trigger') ? blurDescription(src) : null;
    if (blurred && blurred !== src) add({ operator: 'blur-trigger', file, skill: name, description: `blurred the trigger description of skill '${name}' in ${file}`, targets, ops: [{ path: file, content: blurred }] });
    if (want.has('drop-skill') && dir !== '.') {
      const ops = [{ path: dir, remove: true }];
      const listed = (suite.manifest.skills ?? []).filter((s) => path.normalize(s).replace(/\/$/, '') === dir);
      if (listed.length) ops.push({ path: path.join('.claude-plugin', 'plugin.json'), content: JSON.stringify({ ...suite.manifest, skills: suite.manifest.skills.filter((s) => !listed.includes(s)) }, null, 2) + '\n' });
      add({ operator: 'drop-skill', file: dir, skill: name, description: `removed skill '${name}' (${dir}/) entirely`, targets, ops });
    }
  }
  const hs = want.has('disable-hook') ? hooksSource(suite.manifest, plugin) : null;
  const hooksObj = hs ? (hs.inline ? suite.manifest.hooks : await readJson(path.join(plugin, hs.file))) : null;
  if (hooksObj && typeof hooksObj === 'object') {
    const wrapped = hooksObj.hooks && typeof hooksObj.hooks === 'object' && !Array.isArray(hooksObj.hooks), events = wrapped ? hooksObj.hooks : hooksObj;
    const ids = assignIds(rulesFromHooks(hooksObj, hs.file)).map((r) => r.id);
    let k = 0;
    for (const [event, entries] of Object.entries(events)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, j) => {
        const id = ids[k++], cmds = (entry.hooks ?? []).map((h) => h.command ?? h.type).filter(Boolean);
        const rest = entries.filter((_, x) => x !== j), nextEvents = { ...events, [event]: rest };
        if (!rest.length) delete nextEvents[event];
        const nextHooks = wrapped ? { ...hooksObj, hooks: nextEvents } : nextEvents;
        const content = JSON.stringify(hs.inline ? { ...suite.manifest, hooks: nextHooks } : nextHooks, null, 2) + '\n';
        add({ operator: 'disable-hook', file: hs.file, hook: id, ruleId: id, description: `disabled hook ${event} on ${entry.matcher ?? '*'}${cmds.length ? ` (${short(cmds.join('; '), 50)})` : ''} in ${hs.file}`,
          targets: { rules: [id], mentions: [...new Set(cmds.flatMap(scriptWords))] }, ops: [{ path: hs.file, content }] });
      });
    }
  }
  const seen = new Map();
  for (const m of out) {
    const base = `${m.operator}:${m.ruleId ?? (m.skill ? `skill/${slug(m.skill)}` : m.section ? `${m.file}#${slug(m.section)}` : m.file)}`, n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n); m.id = n === 1 ? base : `${base}-${n}`;
  }
  return out;
}

// cases whose covers.yaml names a targeted rule, or (skill and hook mutants) whose files mention the target
const mentionRe = (w) => new RegExp(`(^|[^a-z0-9_])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`);
export function relevantCases(m, cases) {
  const rules = new Set(m.targets.rules), words = m.targets.mentions.filter(Boolean).map(mentionRe);
  return cases.filter((c) => c.covers.some((id) => rules.has(id)) || words.some((re) => re.test(c.text))).map((c) => c.dir);
}

// ---------- model defaults: graders that pass with no plugin loaded (--defaults) ----------
// words of four letters or more, a plural s dropped; rule boilerplate and grader frontmatter keys are not evidence
const STOPWORDS = new Set(['never', 'always', 'must', 'should', 'every', 'each', 'only', 'that', 'this', 'these', 'those', 'with', 'from', 'when', 'what', 'which', 'then', 'than', 'there', 'their', 'them', 'they', 'into', 'does', 'done', 'have', 'make', 'made', 'more', 'some', 'also', 'even', 'like', 'just', 'used', 'uses', 'using', 'your', 'ours', 'code', 'file', 'rule', 'test', 'tests', 'case', 'says', 'reply', 'score', 'hold', 'holds', 'true', 'false', 'type', 'regex', 'target', 'last', 'message', 'last_message', 'match', 'contains', 'not_contains', 'focus', 'criteria', 'flags', 'pattern', 'tool', 'input', 'name', 'description', 'other', 'where', 'here', 'about', 'will', 'would', 'without']);
export const ruleWords = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)).map((w) => (w.length > 4 ? w.replace(/s$/, '') : w)));
// related when the grader shares two words with the rule, or every word of the grader's name is in the rule
export function relatedGrader(ruleText, grader) {
  const rw = ruleWords(ruleText), name = [...ruleWords(String(grader.name).replace(/[-_]/g, ' '))];
  return (name.length && name.every((w) => rw.has(w))) || sharedWords(ruleText, grader) >= 2;
}
export const sharedWords = (ruleText, grader) => { const rw = ruleWords(ruleText); return [...ruleWords(`${String(grader.name).replace(/[-_]/g, ' ')} ${grader.text ?? ''}`)].filter((w) => rw.has(w)).length; };
// official runs carry passed; shim runs carry verdict and score. Indicators and skipped graders do not count.
const graderPassed = (g) => (g.withOnly || g.scored === false || g.verdict === 'skipped' ? null : typeof g.passed === 'boolean' ? g.passed : g.verdict ? g.verdict === 'pass' : typeof g.score === 'number' ? g.score >= 0.5 : null);
// per grader name: { with: { k, n }, without: { k, n } } over the runs that did not error
export function graderRates(c) {
  const out = new Map();
  for (const arm of ['with', 'without']) for (const r of c?.arms?.[arm] ?? []) {
    if (r.isError || r.error) continue;
    for (const g of r.graders ?? []) {
      const p = graderPassed(g);
      if (p === null) continue;
      const e = out.get(g.name) ?? { with: { k: 0, n: 0 }, without: { k: 0, n: 0 } };
      e[arm].n++; if (p) e[arm].k++;
      out.set(g.name, e);
    }
  }
  return out;
}
// the graders that show the model follows every targeted rule anyway. Only graders specific to the mutant
// count: related to a targeted rule and sharing fewer words with every other rule, so a judge that checks
// five rules at once is not evidence about one. Each rule needs at least one specific grader that ran without the plugin, and every
// one of them must pass every no-plugin run; [] as soon as one fails there (the rule still matters) or a
// rule has no evidence either way
export function modelDefaultGraders(m, relevant, suiteCases, withoutCases, ruleTexts = []) {
  const targets = m.targets.texts ?? [], others = ruleTexts.filter((t) => !targets.includes(t)), found = new Map();
  for (const text of targets) {
    let evidence = 0;
    for (const d of relevant) {
      const c = withoutCases.get(d), sc = suiteCases.find((x) => x.dir === d);
      if (!c || !sc) continue;
      const rates = graderRates(c);
      for (const g of sc.graders ?? []) {
        const rt = rates.get(g.name);
        if (!rt?.without.n || !relatedGrader(text, g)) continue;
        const own = sharedWords(text, g);
        if (others.some((o) => relatedGrader(o, g) && sharedWords(o, g) >= own)) continue;
        if (rt.without.k < rt.without.n) return [];
        evidence++; found.set(`${d}\0${g.name}`, { case: d, grader: g.name, without: `${rt.without.k} of ${rt.without.n}` });
      }
    }
    if (!evidence) return [];
  }
  return [...found.values()];
}

// a case whose job is to show a skill stays out (a Skill tool_used grader with max 0) passes with no plugin by design
const noFireCase = (sc) => (sc?.graders ?? []).some((g) => /^type:\s*tool_used\s*$/m.test(g.text) && /^tool:\s*Skill\s*$/m.test(g.text) && /^max:\s*0\s*$/m.test(g.text));

// ---------- reproducible sampling ----------
function prng(seed) {
  let h = 1779033703;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// n mutants, round-robin across operators so each one is represented; generation order is kept
export function sampleMutants(mutants, n, seed = '1') {
  if (!(n > 0) || n >= mutants.length) return mutants;
  const rand = prng(seed), byOp = new Map();
  for (const m of mutants) byOp.set(m.operator, [...(byOp.get(m.operator) ?? []), m]);
  const queues = [...byOp.values()].map((q) => { for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; } return q; });
  const picked = new Set();
  while (picked.size < n) for (const q of queues) if (picked.size < n && q.length) picked.add(q.shift());
  return mutants.filter((m) => picked.has(m));
}

// ---------- a mutated copy: the plugin minus .git, node_modules, past results and unselected cases ----------
export async function materialize(plugin, { ops = [], cases = null, evalRel = 'evals' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-mutant-'));
  const evalDir = path.join(plugin, evalRel), keep = cases ? new Set(cases) : null;
  const filter = (src) => {
    const rel = path.relative(plugin, src), top = rel.split(path.sep)[0];
    if (top === '.git' || top === 'node_modules') return false;
    const inEval = path.relative(evalDir, src);
    if (inEval === '' || inEval.startsWith('..') || path.isAbsolute(inEval)) return true;
    const c = inEval.split(path.sep)[0];
    return c !== 'results' && !(keep && !keep.has(c) && existsSync(path.join(evalDir, c, 'prompt.md')));
  };
  await fs.cp(plugin, dir, { recursive: true, verbatimSymlinks: true, filter });
  for (const op of ops) {
    const target = path.resolve(dir, op.path);
    if (!target.startsWith(dir + path.sep)) throw new Error(`a mutant edit points outside the copy: ${op.path}`);
    if (op.remove) await fs.rm(target, { recursive: true, force: true }); else await fs.writeFile(target, op.content);
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

export const publicMutant = ({ ops, targets, ...m }) => ({ ...m, edits: ops.map((o) => ({ path: o.path, action: o.remove ? 'remove' : 'write' })) });
const fileStem = (id) => id.replace(/[^\w.-]+/g, '_');

// ---------- the run ----------
// suiteRunner is injectable for tests; the default is cc-release's runSuite (official runner or the shim).
export async function runMutations({ plugin, suite, mutants, full = false, runs = 1, budget = 5, runner = 'auto', binDir = null, env = process.env, concurrency = 1, baseline = null, judgeModel = null, threshold = 0.15, outDir = null, defaults = false, log = console.error, suiteRunner = runSuite }) {
  const all = suite.cases.map((c) => c.dir);
  const plan = mutants.map((m) => ({ m, relevant: relevantCases(m, suite.cases) }));
  const needed = full ? all : [...new Set(plan.flatMap((p) => p.relevant))].sort();
  if (outDir) await fs.mkdir(outDir, { recursive: true });
  let spent = 0;
  const run = async (ops, cases, stem, ablation = 'none') => {
    const copy = await materialize(plugin, { ops, cases, evalRel: suite.evalRel });
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-mutate-out-'));
    try {
      const r = await suiteRunner({ plugin: copy.dir, binDir, env, runner, judgeModel, runs, concurrency, budget: Math.max(0.01, Number((budget - spent).toFixed(2))), expectCases: cases.length, outDir: out, ablation });
      spent += r.json?.aggregates?.costUsd ?? 0;
      if (r.raw && outDir) await fs.writeFile(path.join(outDir, `${stem}.json`), JSON.stringify(r.raw, null, 2));
      return { ...r, problem: r.json ? usableReason(r.json, cases.length) : (r.note ?? 'the runner wrote no result') };
    } finally { await copy.cleanup(); await fs.rm(out, { recursive: true, force: true }).catch(() => {}); }
  };

  // the reference: the unmutated setup, scored on every case a mutant will run
  const refCases = new Map(), reference = { source: baseline ? 'baseline' : 'run', costUsd: 0, runner: null, note: null, cases: [] };
  for (const c of baseline?.cases ?? []) if (typeof c.summary?.score === 'number') refCases.set(key(c), c);
  const missing = needed.filter((d) => !refCases.has(d));
  // --defaults runs every needed case once more with no plugin; a --baseline still supplies the with-plugin scores
  const refRun = defaults ? needed : missing, withoutCases = new Map();
  if (missing.length && baseline) { reference.source = 'baseline + run'; log(`· the baseline has no score for ${andList(missing)}; running the original setup on those`); }
  if (refRun.length) {
    log(`· reference: the unmutated setup on ${plural(refRun.length, 'case')}${defaults ? ', with and without the plugin' : ''}`);
    const r = await run([], refRun, 'reference', defaults ? 'with-without' : 'none');
    if (r.problem) throw new Error(`the reference run of the unmutated setup is not usable (${r.problem}${r.note && r.note !== r.problem ? `; ${r.note}` : ''})`);
    Object.assign(reference, { costUsd: r.json.aggregates?.costUsd ?? 0, runner: r.runner, note: r.note, ...(defaults && { ablation: 'with-without' }) });
    for (const c of r.json.cases) {
      if (typeof c.summary?.score === 'number' && !refCases.has(key(c))) refCases.set(key(c), c);
      if (c.arms?.without?.length) withoutCases.set(key(c), c);
    }
  }
  reference.cases = needed.map((d) => {
    const score = refCases.get(d)?.summary?.score ?? null, w = mean((withoutCases.get(d)?.arms?.without ?? []).filter((r) => !r.isError).map((r) => r.score).filter((x) => typeof x === 'number'));
    // a case that scores as well with no plugin cannot tell a sabotaged setup from a working one
    return { dir: d, score, ...(w !== null && { without: w, ...(score !== null && w >= score - threshold && !noFireCase(suite.cases.find((x) => x.dir === d)) && { indistinct: true }) }) };
  });

  const results = [];
  for (const { m, relevant } of plan) {
    const base = { ...publicMutant(m), relevant, cases: [], killedBy: [], costUsd: 0, note: null };
    if (!relevant.length && !full) { results.push({ ...base, status: 'uncovered' }); log(`  nothing tests it  ${m.description}`); continue; }
    if (spent >= budget) { results.push({ ...base, status: 'unrun', note: `budget $${budget} spent before this mutant` }); continue; }
    // relevant cases first; with --full the rest of the suite only when they missed it
    const phases = [relevant, full ? all.filter((d) => !relevant.includes(d)) : []].filter((p) => p.length);
    const compared = [], notes = [];
    let cost = 0;
    for (const [pi, cases] of phases.entries()) {
      if (pi > 0 && compared.some((c) => c.status === 'regressed')) break;
      if (pi > 0 && spent >= budget) { notes.push('the rest of the suite did not run (budget)'); break; }
      const before = spent, r = await run(m.ops, cases, fileStem(m.id) + (pi ? '-rest' : ''));
      cost += spent - before;
      if (r.note) notes.push(r.note);
      if (r.problem) { notes.push(`no usable result: ${r.problem}`); continue; }
      const got = new Map(r.json.cases.map((c) => [key(c), c]));
      for (const d of cases) {
        const ref = refCases.get(d), cur = got.get(d);
        const v = ref && cur ? classifyCase(d, ref, cur, null, threshold) : { status: 'unknown', before: ref?.summary?.score ?? null, after: cur?.summary?.score ?? null, delta: null };
        compared.push({ dir: d, relevant: relevant.includes(d), status: v.status, before: v.before, after: v.after, delta: v.delta });
      }
    }
    const killedBy = compared.filter((c) => c.status === 'regressed').map((c) => c.dir);
    const measured = compared.filter((c) => c.status !== 'unknown');
    const status = killedBy.length ? 'killed' : !measured.length ? 'errored' : relevant.length ? 'survived' : 'uncovered';
    if (status === 'survived' && measured.every((c) => (c.before ?? 0) <= threshold)) notes.push('the reference already fails every case that ran, so none of them could catch it');
    if (status === 'killed' && !killedBy.some((d) => relevant.includes(d))) notes.push('caught only by a case that does not claim it; add the rule to that case\'s covers.yaml');
    if (status === 'errored' && !notes.length) notes.push('no case could be compared with the reference');
    if (status === 'survived' && m.masking?.sameRule) notes.push('the swap is in a later sentence, so the rest of the rule still says the opposite; the model may follow that');
    if (status === 'survived' && m.masking?.siblings.length) notes.push(`${plural(m.masking.siblings.length, 'other rule')} in section '${short(m.masking.section)}' still ${m.masking.siblings.length === 1 ? 'stands' : 'stand'} and may say the opposite; the delete-section mutant tests them together`);
    const defaultsBy = status === 'survived' && RULE_OPS.has(m.operator) ? modelDefaultGraders(m, relevant, suite.cases, withoutCases, suite.cov.rules.map((r) => r.text)) : [];
    // a default today can change with the next model or Claude Code release, so the grader stays as a tripwire
    const many = m.operator === 'delete-section', g0 = defaultsBy[0];
    if (defaultsBy.length) notes.push(`the model does this with no plugin (${defaultsBy.length === 1 ? `grader ${g0.grader} passes ${g0.without} runs` : `graders ${andList([...new Set(defaultsBy.map((g) => g.grader))])} pass every run`} without it), so today ${many ? 'these rules are' : 'the rule is'} not steering anything. You can drop ${many ? 'them' : 'it'} to save context, but keep the grader: it becomes a tripwire, and the release canary turns red if a new model stops doing this, which is your cue to put ${many ? 'them' : 'it'} back`);
    results.push({ ...base, status, cases: compared, killedBy, costUsd: cost, note: notes.join('; ') || null, ...(defaultsBy.length && { modelDefault: { graders: defaultsBy } }) });
    const k = compared.find((c) => c.status === 'regressed');
    log(`  ${LABEL[status].padEnd(17)} ${m.description}${k ? ` (by ${k.dir}, ${f2(k.before)} to ${f2(k.after)})` : ''} · ${usd(cost)} · spent ${usd(spent)} of $${budget}`);
  }
  return { reference, mutants: results, spent, budget, full, runs, threshold, defaults };
}

// ---------- the verdict ----------
const LABEL = { killed: 'caught', survived: 'missed', uncovered: 'nothing tests it', unrun: 'not run', errored: 'errored' };
export const targetLabel = (r) => (r.operator === 'blur-trigger' ? `the trigger of skill ${r.skill}` : r.operator === 'drop-skill' ? `skill ${r.skill}` : r.operator === 'disable-hook' ? `hook ${r.hook}` : r.operator === 'delete-section' ? `section '${r.section}' of ${r.file}` : `rule ${r.ruleId}`);
export function summarize(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const killed = n('killed'), survived = n('survived'), uncovered = n('uncovered'), unrun = n('unrun'), errored = n('errored');
  const judged = killed + survived + uncovered;
  const labels = (s, keep = () => true) => [...new Set(results.filter((r) => r.status === s && keep(r)).map(targetLabel))];
  // a missed rule the model follows with no plugin is a different finding from a weak test, so the lists stay apart
  const modelDefaults = labels('survived', (r) => r.modelDefault), untested = labels('uncovered'), weak = labels('survived').filter((l) => !modelDefaults.includes(l));
  const parts = [judged ? `Your suite catches ${killed} of ${plural(judged, 'sabotage')}.` : 'No sabotage was measured, so there is no score yet.'];
  if (untested.length) parts.push(`Nothing tests: ${andList(untested)}.`);
  if (weak.length) parts.push(`Tested but not caught: ${andList(weak)}.`);
  if (modelDefaults.length) parts.push(`The model does these with no plugin, so today they are not steering anything (keep their graders as tripwires): ${andList(modelDefaults)}.`);
  if (unrun) parts.push(`${plural(unrun, 'mutant')} did not run (budget).`);
  if (errored) parts.push(`${plural(errored, 'mutant')} could not be measured (the runner errored).`);
  return { killed, survived, uncovered, unrun, errored, judged, total: results.length, score: judged ? killed / judged : null, untested, weak, modelDefaults, sentence: parts.join(' ') };
}
// cases that score as well with no plugin as with it (only known after a --defaults reference)
const DEFAULTS_HINT = 'Their graders pass even with no plugin installed, so today these rules cost context without changing behaviour. Keep the graders either way: on every Claude Code or model release they tell you if the model stops doing it by default. Graders are matched to rules by the words they share, so check that the named grader really tests the rule before you drop it.';
const SAME_HINT = 'With no plugin installed they score within the catch threshold of your full setup, so no sabotage can turn them red. Make their prompts ask for something only your setup knows.';
const defaultsCount = (j) => j.mutants.filter((m) => m.modelDefault).length;
const indistinct = (j) => (j.reference?.cases ?? []).filter((c) => c.indistinct);
const noPluginArm = (j) => j.reference?.ablation === 'with-without';

export function mutateJson(res, meta = {}) {
  return { schemaVersion: 1, tool: 'mutate', suite: meta.suite ?? null, generatedAt: meta.generatedAt ?? new Date().toISOString(),
    operators: meta.operators ?? OPERATORS, generated: meta.generated ?? res.mutants.length, seed: meta.seed ?? null, maxMutants: meta.maxMutants ?? null,
    runner: meta.runner ?? null, runs: res.runs, full: res.full, defaults: !!res.defaults, budget: res.budget, spent: res.spent, threshold: res.threshold,
    reference: res.reference, summary: summarize(res.mutants), mutants: res.mutants };
}

const caughtBy = (r) => { const c = r.cases.find((x) => x.status === 'regressed'); return c ? `${c.dir} (${f2(c.before)} to ${f2(c.after)})` : ''; };
export function renderMutateMd(j) {
  const s = j.summary;
  const rows = j.mutants.map((r) => `| ${LABEL[r.status]} | ${r.operator}${r.heuristic ? ' (heuristic)' : ''} | ${r.description.replace(/\|/g, '\\|')} | ${caughtBy(r) || (r.status === 'uncovered' ? 'no case claims it' : r.status === 'survived' ? 'stayed green' : '')} | ${r.costUsd ? usd(r.costUsd) : ''} |`);
  const same = indistinct(j);
  return [`### Mutation test: ${j.suite ?? 'suite'}`, '',
    `**${s.score === null ? 'No score yet' : `Score ${f2(s.score)}`}.** ${s.sentence}`, '',
    `Reference: ${j.reference.source === 'baseline' ? 'the --baseline result' : `one run of the unmutated setup (${usd(j.reference.costUsd)})`}${noPluginArm(j) ? ', with a no-plugin arm' : ''} · ${plural(j.runs, 'run')} per case${j.full ? ' · --full' : ''} · spent ${usd(j.spent)} of $${j.budget}`, '',
    ...((s.modelDefaults ?? []).length ? [`**The model does these anyway:** ${andList(s.modelDefaults, 99)}. ${DEFAULTS_HINT}`, ''] : []),
    ...(same.length ? [`**Cases that cannot tell your setup from no plugin:** ${andList(same.map((c) => `${c.dir} (${f2(c.score)} with, ${f2(c.without)} without)`), 99)}. No sabotage can turn them red.`, ''] : []),
    '| result | operator | mutant | caught by | cost |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

// ---------- the page ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function renderMutateHtml(j) {
  const s = j.summary, tone = s.score === null ? 'muted' : s.score >= 0.8 ? 'pass' : s.score >= 0.5 ? 'warn' : 'fail';
  const head = s.judged ? `Catches ${s.killed} of ${plural(s.judged, 'sabotage')}` : 'Nothing measured yet';
  // the page lists the gaps right below, so its lede counts them instead of naming them
  const brief = [s.uncovered && `${plural(s.uncovered, 'mutant')} had no case that tests ${s.uncovered === 1 ? 'it' : 'them'}.`, s.survived && `${s.survived} stayed green under a case that claims ${s.survived === 1 ? 'it' : 'them'}${defaultsCount(j) ? `; with no plugin installed the model already does what ${defaultsCount(j) === 1 ? 'one' : defaultsCount(j)} of them test${defaultsCount(j) === 1 ? 's' : ''}` : ''}.`,
    s.unrun && `${s.unrun} did not run (budget).`, s.errored && `${s.errored} could not be measured (the runner errored).`].filter(Boolean).join(' ') || (s.judged ? 'Every sabotage turned a case red.' : s.sentence);
  const stamp = [
    ['score', `<b>${s.score === null ? 'n/a' : f2(s.score)}</b> <span class="from">caught / (caught + missed + nothing tests it)</span>`],
    ['mutants', `<b>${s.total}</b> <span class="from">${j.generated > s.total ? `sampled from ${j.generated} (seed ${esc(j.seed)})` : 'every one generated'}</span>`],
    ['reference', `<b>${esc(j.reference.source === 'run' ? 'one run of the original' : j.reference.source)}</b>${noPluginArm(j) ? ' <span class="from">plus a no-plugin arm</span>' : ''}${j.reference.costUsd ? ` <span class="from">${usd(j.reference.costUsd)}</span>` : ''}`],
    ['spend', `<b>${usd(j.spent)}</b> <span class="from">of $${j.budget} budget, ${plural(j.runs, 'run')} per case${j.full ? ', --full' : ''}</span>`],
    ['caught when', `<span class="from">a case drops more than ${j.threshold} below the reference</span>`],
    ['generated', `<span class="from">${esc(String(j.generatedAt).replace('T', ' ').slice(0, 16))} UTC</span>`],
  ];
  const chips = (xs, cls) => `<ul class="chips">${xs.map((x) => `<li class="${cls}">${esc(x)}</li>`).join('')}</ul>`;
  const rows = j.mutants.map((r) => {
    const k = r.cases.find((x) => x.status === 'regressed');
    const by = k ? `<b>${esc(k.dir)}</b> <span class="from">${f2(k.before)} to ${f2(k.after)}</span>` : r.status === 'uncovered' ? '<span class="from">no case claims it</span>' : r.status === 'survived' ? `<span class="from">${esc(r.cases.map((c) => `${c.dir} ${f2(c.before)} to ${f2(c.after)}`).join(', '))}</span>` : '';
    return `<tr class="st-${r.status}"><td><span class="pill ${r.status}">${LABEL[r.status]}</span></td><td class="op">${esc(r.operator)}${r.heuristic ? ' <i class="tag">heuristic</i>' : ''}</td>
<td class="desc">${esc(r.description)}<div class="id">${esc(r.id)}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td><td>${by}</td><td class="num">${r.costUsd ? usd(r.costUsd) : ''}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(j.suite ?? 'suite')} mutation test</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>${CSS}</style></head><body><div class="wrap">
<header class="verdict"><div><p class="eyebrow">config-drift-checker · <b>${esc(j.suite ?? 'suite')}</b> · mutation test</p>
<h1 class="${tone}"><span>${esc(head)}</span></h1><p class="lede">${esc(brief)}</p>
<p class="lede">Each mutant is one small sabotage of a temp copy of the setup: a deleted or inverted rule, a deleted section, a blurred skill trigger, a removed skill or a disabled hook. A good suite goes red on every one.</p></div>
<dl class="stamp">${stamp.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></header>
${s.untested.length ? `<h2>Nothing tests these</h2><p class="hint">No case claims them in covers.yaml or mentions them. Add a case, or list the rule id in an existing case's covers.yaml.</p>${chips(s.untested, 'gap')}` : ''}
${s.weak.length ? `<h2>Tested but not caught</h2><p class="hint">A case claims them, but it stayed green with the sabotage in place. Tighten its graders.</p>${chips(s.weak, 'weak')}` : ''}
${(s.modelDefaults ?? []).length ? `<h2>The model does these anyway</h2><p class="hint">${esc(DEFAULTS_HINT)}</p>${chips(s.modelDefaults, 'default')}` : ''}
${indistinct(j).length ? `<h2>Cases that cannot tell your setup from no plugin</h2><p class="hint">${esc(SAME_HINT)}</p>${chips(indistinct(j).map((c) => `${c.dir}: ${f2(c.score)} with, ${f2(c.without)} without`), 'gap')}` : ''}
<h2>Every mutant</h2><div class="tablewrap"><table><thead><tr><th>result</th><th>operator</th><th>mutant</th><th>caught by</th><th class="num">cost</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="foot">Scores are the mean over a case's runs with the setup loaded, against a reference run of the unmutated setup. Inverted rules are a word swap and can read oddly, so they are marked heuristic. Generated by <a href="https://jameskomo.github.io/config-drift-checker/">config-drift-checker</a> mutate.</p>
</div></body></html>`;
}

const CSS = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"tnum"}
a{color:inherit;text-decoration:none}a:hover{color:var(--track)}.wrap{max-width:1180px;margin:0 auto;padding:28px 28px 90px}
.verdict{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:28px;align-items:start;margin-bottom:26px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:600}h1.pass{color:var(--pass)}h1.fail{color:var(--fail)}h1.warn{color:var(--warn)}h1.muted{color:var(--muted)}
.lede{font-size:15px;color:var(--muted);margin:0 0 8px;max-width:66ch}
.stamp{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:12.5px;box-shadow:var(--shadow)}
.stamp dt{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;padding-top:2px}.stamp dd{margin:0}.stamp b{font-weight:600}.from{color:var(--muted)}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 6px}.hint{color:var(--muted);font-size:13.5px;margin:0 0 10px}
.chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.chips li{font:12.5px/1.4 "IBM Plex Mono",ui-monospace,Menlo,monospace;padding:4px 9px;border-radius:6px;border:1px solid var(--rule);background:var(--surface);overflow-wrap:anywhere}
.chips li.gap{border-left:3px solid var(--fail)}.chips li.weak{border-left:3px solid var(--warn)}.chips li.default{border-left:3px solid var(--track)}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{padding:8px 12px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}tr:last-child td{border-bottom:0}
thead th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
.op{white-space:nowrap;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12.5px}.num{text-align:right;white-space:nowrap;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace}
.desc{min-width:280px}.id{color:var(--muted);font:11.5px/1.4 "IBM Plex Mono",ui-monospace,Menlo,monospace;overflow-wrap:anywhere;margin-top:2px}.note{color:var(--warn);font-size:12.5px;margin-top:3px}
.tag{font-style:normal;font-size:10px;padding:0 5px;border-radius:4px;background:var(--track-bg);color:var(--track);margin-left:4px;font-family:"IBM Plex Sans",system-ui,sans-serif}
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--code);color:var(--muted)}
.pill.killed{background:var(--pass-bg);color:var(--pass)}.pill.survived{background:var(--warn-bg);color:var(--warn)}.pill.uncovered,.pill.errored{background:var(--fail-bg);color:var(--fail)}
.foot{color:var(--muted);font-size:12px;margin-top:22px}:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:820px){.verdict{grid-template-columns:1fr}h1{font-size:28px}.wrap{padding:20px 16px 60px}.desc{min-width:200px}}`;

// ---------- cost estimate (dry run) ----------
// per-case mean cost of one with-arm run from past results, the all-case mean for a case with no history
// --defaults: every needed case runs in the reference with both arms, so its share counts twice
export function estimatePlan(plan, history, { runs = 1, full = false, all = [], baselineCases = [], defaults = false } = {}) {
  const byCase = new Map();
  for (const { json } of history) for (const c of json.cases ?? []) for (const r of c.arms?.with ?? []) if (!r.isError && typeof r.costUsd === 'number') byCase.set(key(c), [...(byCase.get(key(c)) ?? []), r.costUsd]);
  const samples = [...byCase.values()].flat();
  if (!samples.length) return null;
  const overall = mean(samples), perCase = (d) => (mean(byCase.get(d) ?? []) ?? overall) * runs;
  const needed = full ? all : [...new Set(plan.flatMap((p) => p.relevant))];
  const reference = defaults ? 2 * sum(needed.map(perCase)) : sum(needed.filter((d) => !baselineCases.includes(d)).map(perCase));
  const mutants = plan.map(({ relevant }) => (relevant.length || full ? sum((full ? all : relevant).map(perCase)) : 0));
  return { perRunUsd: overall, samples: samples.length, casesWithHistory: needed.filter((d) => byCase.has(d)).length, needed: needed.length, reference, mutants, total: reference + sum(mutants) };
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { plugin: null, operators: OPERATORS, maxMutants: null, seed: '1', runs: 1, budget: 5, baseline: null, full: false, defaults: false, runner: 'auto', concurrency: 1, history: null, outDir: null, json: null, md: null, html: null, dryRun: false };
  const outArg = (v) => (v === '-' ? '-' : path.resolve(v));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--operators') opt.operators = String(next() ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--max-mutants') opt.maxMutants = Number(next()); else if (a === '--seed') opt.seed = String(next());
    else if (a === '--runs') opt.runs = Number(next()); else if (a === '--budget') opt.budget = Number(next());
    else if (a === '--baseline') opt.baseline = path.resolve(next()); else if (a === '--full') opt.full = true;
    else if (a === '--runner') opt.runner = next(); else if (a === '--concurrency' || a === '-j') opt.concurrency = Number(next());
    else if (a === '--history') opt.history = path.resolve(next()); else if (a === '--out-dir') opt.outDir = path.resolve(next());
    else if (a === '--json') opt.json = outArg(next()); else if (a === '--md') opt.md = outArg(next()); else if (a === '--html') opt.html = path.resolve(next());
    else if (a === '--dry-run') opt.dryRun = true; else if (a === '--defaults') opt.defaults = true;
    else if (!a.startsWith('-')) opt.plugin = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  const die = (m, code = 2) => { console.error(m); process.exit(code); };
  if (!opt.plugin) die('usage: mutate.mjs <plugin> [--operators a,b] [--max-mutants N] [--seed s] [--full] [--runs 1] [--budget 5] [--baseline result.json] [--defaults] [--runner auto|official|shim] [--concurrency n] [--dry-run] [--json f|-] [--md f|-] [--html f]');
  const unknownOps = opt.operators.filter((o) => !OPERATORS.includes(o));
  if (!opt.operators.length || unknownOps.length) die(`--operators takes a comma list of ${OPERATORS.join(', ')}${unknownOps.length ? ` (not ${unknownOps.join(', ')})` : ''}`);
  if (!['auto', 'official', 'shim'].includes(opt.runner)) die('--runner must be auto, official or shim');
  if (opt.maxMutants !== null && !(Number.isInteger(opt.maxMutants) && opt.maxMutants > 0)) die('--max-mutants must be a whole number above 0');
  if (!(Number.isInteger(opt.runs) && opt.runs >= 1) || !(opt.budget > 0)) die('--runs must be a whole number of at least 1, --budget above 0');
  if (!Number.isInteger(opt.concurrency) || opt.concurrency < 1 || opt.concurrency > 8) die('--concurrency must be a whole number from 1 to 8');
  if (!existsSync(path.join(opt.plugin, '.claude-plugin', 'plugin.json'))) die(`no .claude-plugin/plugin.json in ${opt.plugin}`, 1);

  const suite = await loadSuite(opt.plugin);
  if (!suite.cases.length) die(`no eval cases in ${path.join(opt.plugin, suite.evalRel)}`, 1);
  const generated = await generateMutants(opt.plugin, suite, { operators: opt.operators });
  if (!generated.length) die(`nothing to mutate: no rules, skills or hooks found for ${opt.operators.join(', ')}`, 1);
  const mutants = sampleMutants(generated, opt.maxMutants, opt.seed);
  const plan = mutants.map((m) => ({ m, relevant: relevantCases(m, suite.cases) }));
  const baseline = opt.baseline ? normalizeResult(await readJson(opt.baseline)) : null;
  if (opt.baseline && !Array.isArray(baseline?.cases)) die(`--baseline ${opt.baseline} is not an aggregate result`, 1);
  const name = suite.manifest.name ?? path.basename(opt.plugin);
  const say = opt.json === '-' || opt.md === '-' ? console.error : console.log; // stdout stays clean for - outputs
  const byOp = OPERATORS.filter((o) => opt.operators.includes(o)).map((o) => `${mutants.filter((m) => m.operator === o).length} ${o}`).join(', ');
  say(`Mutants: ${mutants.length}${mutants.length < generated.length ? ` of ${generated.length} (seed ${opt.seed})` : ''} · ${byOp} · ${plural(suite.cases.length, 'case')} · ${plural(opt.runs, 'run')} per case${opt.full ? ' · --full' : ''}${opt.defaults ? ' · --defaults' : ''} · budget $${opt.budget}`);

  if (opt.dryRun) {
    const history = [...await readResults(path.join(opt.plugin, suite.evalRel, 'results')), ...await readResults(opt.history)];
    const baselineCases = (baseline?.cases ?? []).filter((c) => typeof c.summary?.score === 'number').map(key);
    const est = estimatePlan(plan, history, { runs: opt.runs, full: opt.full, all: suite.cases.map((c) => c.dir), baselineCases, defaults: opt.defaults });
    for (const [i, { m, relevant }] of plan.entries()) say(`  ${m.id}\n      ${m.description}${m.heuristic ? ' (heuristic)' : ''}\n      ${relevant.length ? `runs ${andList(relevant)}` : `nothing tests it${opt.full ? ', so --full runs every case' : ''}`}${est && est.mutants[i] ? ` · about ${usd(est.mutants[i])}` : ''}`);
    if (!est) say(`\nNo past results to estimate from (looked in ${path.join(opt.plugin, suite.evalRel, 'results')}${opt.history ? ` and ${opt.history}` : ''}). Run the suite once, or pass --history <dir>.`);
    else {
      let cum = est.reference, fits = 0;
      for (const c of est.mutants) { if (cum >= opt.budget) break; cum += c; fits++; }
      say(`\nEstimated cost: about ${usd(est.total)}${opt.full ? ' at most' : ''} (reference run ${usd(est.reference)}${opt.defaults ? ' with the no-plugin arm' : baseline ? ' after --baseline' : ''}, mutants ${usd(est.total - est.reference)}), from ${usd(est.perRunUsd)} per agent run over ${est.samples} past runs; ${est.casesWithHistory} of ${est.needed} cases have their own history.`);
      say(fits >= est.mutants.length ? `The $${opt.budget} budget covers every mutant.` : `The $${opt.budget} budget starts about ${fits} of ${est.mutants.length} mutants; the rest would show as not run.`);
    }
    if (opt.json) {
      const j = JSON.stringify({ schemaVersion: 1, tool: 'mutate', dryRun: true, suite: name, generated: generated.length, mutants: plan.map(({ m, relevant }, i) => ({ ...publicMutant(m), relevant, estimatedUsd: est?.mutants[i] ?? null })), estimate: est ? { ...est, mutants: undefined } : null }, null, 2) + '\n';
      if (opt.json === '-') process.stdout.write(j); else await fs.writeFile(opt.json, j);
    }
    say('\nDry run: nothing run, $0 spent.');
    process.exit(0);
  }

  const { th, cfg } = resolveThresholds(opt.plugin, 'pinned'), judgeModel = cfg?.judgeModel ?? null;
  const generatedAt = new Date().toISOString();
  let res;
  try { res = await runMutations({ plugin: opt.plugin, suite, mutants, full: opt.full, runs: opt.runs, budget: opt.budget, runner: opt.runner, concurrency: opt.concurrency, baseline, judgeModel, threshold: th.score, outDir: opt.outDir, defaults: opt.defaults }); }
  catch (e) { die(e.message, 1); }
  const j = mutateJson(res, { suite: name, generatedAt, operators: opt.operators, generated: generated.length, seed: opt.seed, maxMutants: opt.maxMutants, runner: opt.runner });
  if (opt.outDir) await fs.writeFile(path.join(opt.outDir, 'mutate.json'), JSON.stringify(j, null, 2) + '\n');
  if (opt.json === '-') process.stdout.write(JSON.stringify(j, null, 2) + '\n'); else if (opt.json) await fs.writeFile(opt.json, JSON.stringify(j, null, 2) + '\n');
  if (opt.md === '-') process.stdout.write(renderMutateMd(j)); else if (opt.md) await fs.writeFile(opt.md, renderMutateMd(j));
  if (opt.html) { await fs.mkdir(path.dirname(opt.html), { recursive: true }); await fs.writeFile(opt.html, renderMutateHtml(j)); }
  say(`\n${j.summary.score === null ? '' : `Score ${f2(j.summary.score)}. `}${j.summary.sentence}`);
  say(`Spent about ${usd(res.spent)} of $${opt.budget} (notional; $0 API on a subscription token)${opt.html ? `\n${opt.html}` : ''}`);
}
