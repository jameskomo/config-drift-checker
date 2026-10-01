#!/usr/bin/env node
// skill-lint: static checks for the skills a Claude Code plugin ships, so a skill that will not load,
// loads under the wrong name, or triggers badly is caught before any model run is spent.
//
//   node tools/skill-lint.mjs <plugin-dir> [--json out.json] [--strict]
//
// Reads every SKILL.md under the plugin (skipping node_modules, .git, results, evals, target, dist) and
// the manifest .claude-plugin/plugin.json. Every check is one entry in RULES: an id, a level, a check
// function, a one-line explanation and a fix hint. ERROR means the skill may not load, or loads wrongly,
// under a strict loader; WARN means it loads but will trigger or read badly.
// Prints one line per finding and a summary line. Exits 1 on any ERROR (with --strict, on any WARN too),
// 2 on a usage error, else 0. --json writes the findings as structured data.
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKIP_DIRS = ['node_modules', '.git', 'results', 'evals', 'target', 'dist'];
export const MAX_DESCRIPTION = 1024;
export const MIN_DESCRIPTION = 40;
export const MAX_BODY_LINES = 500;
const TRIGGER_WORDS = ['use when', 'use whenever', 'use for', 'trigger', 'when the user'];
const NEGATIVE_WORDS = ['do not use', "don't use", 'not for', 'never use'];
const TYPOGRAPHY = { '\u2014': 'em dash', '\u2018': 'curly quote', '\u2019': 'curly quote', '\u201C': 'curly quote', '\u201D': 'curly quote' };
// Backticked paths are only treated as files the skill ships when they start in a conventional bundle dir
// (or with ./ or ../); anything else in backticks usually names a file in the user's project.
const BUNDLE_DIRS = ['references', 'reference', 'scripts', 'assets', 'templates'];

// Split a SKILL.md into frontmatter fields and body. A field records its YAML style (plain, quoted,
// block) because a plain scalar has stricter rules than the others. This is not a YAML parser: it reads
// the top-level `key: value` lines a skill frontmatter uses, which is all the rules need.
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return { present: false, closed: false, fields: {}, raw: '', body: lines.join('\n'), bodyStartLine: 1 };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return { present: true, closed: false, fields: {}, raw: lines.slice(1).join('\n'), body: '', bodyStartLine: lines.length + 1 };
  const fmLines = lines.slice(1, end);
  const fields = {};
  for (let i = 0; i < fmLines.length; i++) {
    const m = fmLines[i].match(/^([A-Za-z0-9_-]+):(?:\s+(.*?))?\s*$/);
    if (!m) continue;
    const keyLine = i + 2; // file line: line 1 is the opening ---
    const cont = [];
    while (i + 1 < fmLines.length && (/^\s/.test(fmLines[i + 1]) || fmLines[i + 1] === '')) cont.push(fmLines[++i]);
    while (cont.length && cont.at(-1).trim() === '') cont.pop();
    fields[m[1]] = readScalar(m[2] ?? '', cont, keyLine);
  }
  return { present: true, closed: true, fields, raw: fmLines.join('\n'), body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 };
}

function readScalar(first, cont, line) {
  const rest = cont.map((l) => l.trim());
  if (/^[>|]/.test(first)) return { style: 'block', value: rest.join(first[0] === '|' ? '\n' : ' ').trim(), line, lines: [] };
  if (first.startsWith('"') || first.startsWith("'")) {
    const joined = [first, ...rest].join(' ');
    const q = first[0];
    let value = joined.slice(1);
    if (q === '"') {
      const close = joined.slice(1).search(/(?<!\\)"/);
      value = close >= 0 ? joined.slice(1, close + 1) : value;
      try { value = JSON.parse(`"${value}"`); } catch { /* keep the raw text */ }
    } else {
      const m = joined.slice(1).match(/^((?:[^']|'')*)'/); // '' is an escaped quote inside '...'
      value = (m ? m[1] : value).replace(/''/g, "'");
    }
    return { style: 'quoted', value, line, lines: [] };
  }
  const parts = [first, ...rest].filter((s) => s !== '');
  return { style: 'plain', value: parts.join(' '), line, lines: parts };
}

// Path-like references in a skill body that should exist: markdown links and bundle-dir paths in
// backticks (both outside code fences, resolved against the skill dir), and ${CLAUDE_PLUGIN_ROOT}/...
// anywhere (resolved against the plugin dir). Paths with placeholders or globs are skipped.
export function localRefs(body, bodyStartLine = 1) {
  const refs = []; let fence = false;
  const usable = (p) => p && !/[<>*{}$?]/.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('#') && !p.startsWith('/');
  body.split(/\r?\n/).forEach((l, i) => {
    const line = bodyStartLine + i;
    for (const m of l.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`'")\]]+)/g)) {
      const p = m[1].replace(/[.,;:]+$/, '');
      if (usable(p)) refs.push({ ref: m[0].replace(/[.,;:]+$/, ''), base: 'plugin', path: p, line });
    }
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    for (const m of l.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const p = m[1].replace(/[#?].*$/, '');
      if (usable(p) && !p.includes('CLAUDE_PLUGIN_ROOT')) refs.push({ ref: m[1], base: 'skill', path: decodeURI(p), line });
    }
    for (const m of l.matchAll(/`([^`\s]+)`/g)) {
      const p = m[1].replace(/[.,;:]+$/, '');
      const first = p.split('/')[0];
      if (!p.includes('/') || !usable(p)) continue;
      if (first === '.' || first === '..' || BUNDLE_DIRS.includes(first)) refs.push({ ref: p, base: 'skill', path: p, line });
    }
  });
  return refs;
}

const field = (s, k) => s.fm.fields[k];
const text = (s, k) => (field(s, k)?.value ?? '').trim();
const hasFm = (s) => s.fm.closed;
const anyOf = (hay, needles) => needles.some((n) => hay.toLowerCase().includes(n));

// The rules table. scope 'skill' runs once per SKILL.md with (skill, plugin); scope 'plugin' runs once
// with (plugin). A check returns a list of problems: a string, or { message, file, line }.
export const RULES = [
  { id: 'frontmatter-missing', level: 'ERROR', scope: 'skill',
    explain: 'A skill without a leading --- frontmatter block has no name or description, so it cannot be listed or triggered.',
    fix: 'start the file with a --- line, then name: and description:, then a closing --- line',
    check: (s) => (s.fm.present ? [] : ['the file does not start with a --- frontmatter block']) },
  { id: 'frontmatter-unclosed', level: 'ERROR', scope: 'skill',
    explain: 'Without a closing --- the whole file is read as frontmatter, which is not valid YAML.',
    fix: 'add a --- line after the last frontmatter field',
    check: (s) => (s.fm.present && !s.fm.closed ? ['the frontmatter is never closed by a second --- line'] : []) },
  { id: 'name-missing', level: 'ERROR', scope: 'skill',
    explain: 'The name is how the skill is listed and invoked.',
    fix: 'add name: <skill-directory-name> to the frontmatter',
    check: (s) => (hasFm(s) && !text(s, 'name') ? [field(s, 'name') ? 'name is empty' : 'no name field'] : []) },
  { id: 'description-missing', level: 'ERROR', scope: 'skill',
    explain: 'The description is the only text the agent sees when deciding whether to load the skill.',
    fix: 'add description: saying what the skill does and when to use it',
    check: (s) => (hasFm(s) && !text(s, 'description') ? [field(s, 'description') ? 'description is empty' : 'no description field'] : []) },
  { id: 'yaml-plain-colon', level: 'ERROR', scope: 'skill',
    explain: 'In an unquoted YAML value, a colon followed by a space starts a new mapping, so strict parsers reject the whole frontmatter.',
    fix: 'wrap the value in double quotes (escape inner ones as \\") or use a > block scalar',
    check: (s) => ['name', 'description'].filter((k) => field(s, k)?.style === 'plain' && field(s, k).lines.some((l) => /:(\s|$)/.test(l)))
      .map((k) => ({ message: `the unquoted ${k} contains ": " ("${excerpt(field(s, k).value, field(s, k).value.search(/:(\s|$)/))}")`, line: field(s, k).line })) },
  { id: 'name-dir-mismatch', level: 'ERROR', scope: 'skill',
    explain: 'Claude Code identifies a skill by its directory; a different name: makes invocation ambiguous.',
    fix: 'set name: to the directory name, or rename the directory',
    check: (s) => (text(s, 'name') && text(s, 'name') !== s.dirName ? [`name "${text(s, 'name')}" does not match the directory "${s.dirName}"`] : []) },
  { id: 'duplicate-name', level: 'ERROR', scope: 'plugin',
    explain: 'Two skills with one name in a plugin shadow each other; only one of them can be invoked.',
    fix: 'give every skill a unique name (and directory)',
    check: (p) => {
      const byName = new Map();
      for (const s of p.skills) { const n = text(s, 'name'); if (n) byName.set(n, [...(byName.get(n) ?? []), s]); }
      return [...byName].filter(([, list]) => list.length > 1).flatMap(([n, list]) =>
        list.slice(1).map((s) => ({ message: `name "${n}" is also used by ${list[0].rel}`, file: s.rel })));
    } },
  { id: 'description-too-long', level: 'ERROR', scope: 'skill',
    explain: `Descriptions over ${MAX_DESCRIPTION} characters are cut or rejected in the skill list the agent chooses from.`,
    fix: `shorten the description to ${MAX_DESCRIPTION} characters or fewer; move detail into the body`,
    check: (s) => (text(s, 'description').length > MAX_DESCRIPTION ? [`description is ${text(s, 'description').length} characters (limit ${MAX_DESCRIPTION})`] : []) },
  { id: 'manifest-invalid-json', level: 'ERROR', scope: 'plugin',
    explain: 'A plugin.json that does not parse stops the whole plugin from loading.',
    fix: 'fix the JSON syntax in .claude-plugin/plugin.json',
    check: (p) => (p.manifest?.error ? [{ message: `plugin.json is not valid JSON (${p.manifest.error})`, file: p.manifest.rel }] : []) },
  { id: 'manifest-skill-missing', level: 'ERROR', scope: 'plugin',
    explain: 'A skills entry in plugin.json that points nowhere means a skill the author expects is never loaded.',
    fix: 'correct the path in plugin.json "skills", or remove the entry',
    check: (p) => manifestSkillPaths(p.manifest?.json).filter((sp) => !existsSync(path.resolve(p.dir, sp)))
      .map((sp) => ({ message: `plugin.json lists skill path "${sp}", which does not exist`, file: p.manifest.rel })) },
  { id: 'description-too-short', level: 'WARN', scope: 'skill',
    explain: `A description under ${MIN_DESCRIPTION} characters is too vague for the agent to trigger the skill reliably.`,
    fix: 'say what the skill does, when to use it, and the phrases that should trigger it',
    check: (s) => { const d = text(s, 'description'); return d && d.length < MIN_DESCRIPTION ? [`description is only ${d.length} characters`] : []; } },
  { id: 'no-trigger-guidance', level: 'WARN', scope: 'skill',
    explain: 'Without trigger guidance the agent has to guess when the skill applies.',
    fix: 'add a sentence such as "Use when the user asks to ..."',
    check: (s) => { const d = text(s, 'description'); return d && !anyOf(d, TRIGGER_WORDS) ? ['description says what the skill is but not when to use it'] : []; } },
  { id: 'no-negative-scope', level: 'WARN', scope: 'skill',
    explain: 'When a plugin ships several skills, descriptions without a negative scope overlap and misfire.',
    fix: 'add a sentence such as "Do not use for ..." naming the nearby work this skill is not for',
    check: (s, p) => { const d = text(s, 'description'); return d && p.skills.length > 1 && !anyOf(d, NEGATIVE_WORDS) ? ['description has no "do not use" / "not for" scope, and the plugin ships more than one skill'] : []; } },
  { id: 'body-empty', level: 'WARN', scope: 'skill',
    explain: 'A skill with no body gives the agent nothing to follow once it triggers.',
    fix: 'write the instructions below the frontmatter',
    check: (s) => (hasFm(s) && !s.fm.body.trim() ? ['the body below the frontmatter is empty'] : []) },
  { id: 'body-too-long', level: 'WARN', scope: 'skill',
    explain: `Bodies over ${MAX_BODY_LINES} lines dilute what the agent actually follows.`,
    fix: 'move reference material into references/*.md files and link them from the body',
    check: (s) => { const n = s.fm.body.replace(/\s+$/, '').split(/\r?\n/).length; return hasFm(s) && n > MAX_BODY_LINES ? [`the body is ${n} lines (limit ${MAX_BODY_LINES})`] : []; } },
  { id: 'broken-local-ref', level: 'WARN', scope: 'skill',
    explain: 'The body points the agent at a file the skill does not ship, so the agent reads nothing or improvises.',
    fix: 'add the file, or correct the path (skill-relative, or ${CLAUDE_PLUGIN_ROOT}/... for plugin files)',
    check: (s, p) => localRefs(s.fm.body, s.fm.bodyStartLine)
      .filter((r) => !existsSync(path.resolve(r.base === 'plugin' ? p.dir : s.dir, r.path)))
      .map((r) => ({ message: `references ${r.ref}, which does not exist relative to the ${r.base === 'plugin' ? 'plugin' : 'skill'} directory`, line: r.line })) },
  { id: 'frontmatter-typography', level: 'WARN', scope: 'skill',
    explain: 'Em dashes and curly quotes in frontmatter trip some strict loaders and break the repo style.',
    fix: 'use a plain hyphen or colon instead of an em dash, and straight quotes',
    check: (s) => s.fm.raw.split('\n').flatMap((l, i) => {
      const found = [...new Set([...l].filter((c) => TYPOGRAPHY[c]).map((c) => TYPOGRAPHY[c]))];
      return found.length ? [{ message: `frontmatter contains ${found.join(' and ')} characters`, line: i + 2 }] : [];
    }) },
];

function excerpt(s, at) { const from = Math.max(0, at - 20); return `${from ? '...' : ''}${s.slice(from, at + 20)}${at + 20 < s.length ? '...' : ''}`; }

export function manifestSkillPaths(json) {
  const v = json?.skills;
  return (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');
}

export async function findSkillFiles(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.includes(e.name)) await findSkillFiles(path.join(dir, e.name), acc, depth + 1); }
    else if (e.name === 'SKILL.md') acc.push(path.join(dir, e.name));
  }
  return acc.sort();
}

// Pure core: run every rule over already-loaded skills and manifest. Tests build these objects directly.
export function lint(plugin) {
  const findings = [];
  const add = (rule, problems, defaultFile) => {
    for (const pr of problems) {
      const o = typeof pr === 'string' ? { message: pr } : pr;
      findings.push({ level: rule.level, rule: rule.id, file: o.file ?? defaultFile, line: o.line ?? null, message: o.message, fix: rule.fix, explain: rule.explain });
    }
  };
  for (const rule of RULES) {
    if (rule.scope === 'plugin') add(rule, rule.check(plugin), plugin.manifest?.rel ?? '.');
    else for (const s of plugin.skills) add(rule, rule.check(s, plugin), s.rel);
  }
  const order = (f) => (f.level === 'ERROR' ? 0 : 1);
  findings.sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const errors = findings.filter((f) => f.level === 'ERROR').length;
  return { schemaVersion: 1, pluginDir: path.basename(plugin.dir), skills: plugin.skills.length, errors, warnings: findings.length - errors, findings };
}

export function skillFromText(file, content, pluginDir) {
  const dir = path.dirname(file);
  return { file, dir, dirName: path.basename(dir), rel: path.relative(pluginDir, file) || path.basename(file), fm: parseFrontmatter(content) };
}

export async function loadPlugin(dir) {
  const skills = [];
  for (const f of await findSkillFiles(dir)) skills.push(skillFromText(f, await fs.readFile(f, 'utf8'), dir));
  const mp = path.join(dir, '.claude-plugin/plugin.json');
  let manifest = null;
  if (existsSync(mp)) {
    manifest = { rel: path.relative(dir, mp) };
    try { manifest.json = JSON.parse(await fs.readFile(mp, 'utf8')); } catch (e) { manifest.error = e.message; }
  }
  return { dir, skills, manifest };
}

export async function lintPlugin(dir) { return lint(await loadPlugin(path.resolve(dir))); }

export const formatFinding = (f) => `${f.level.padEnd(5)} ${f.file}${f.line ? `:${f.line}` : ''} [${f.rule}] ${f.message}. Fix: ${f.fix}`;
export const summaryLine = (r) => `${r.skills} skill${r.skills === 1 ? '' : 's'} checked, ${r.errors} error${r.errors === 1 ? '' : 's'}, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}`;
export const exitCode = (r, { strict = false } = {}) => (r.errors || (strict && r.warnings) ? 1 : 0);

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  let dir = null, json = null, strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = argv[++i]; else if (a === '--strict') strict = true;
    else if (!a.startsWith('--') && !dir) dir = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  if (!dir || (json !== null && !json)) { console.error('usage: skill-lint.mjs <plugin-dir> [--json out.json] [--strict]'); process.exit(2); }
  if (!existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2); }
  const r = await lintPlugin(dir);
  for (const f of r.findings) console.log(formatFinding(f));
  console.log(summaryLine(r));
  if (json) await fs.writeFile(json, JSON.stringify(r, null, 2) + '\n');
  process.exit(exitCode(r, { strict }));
}
