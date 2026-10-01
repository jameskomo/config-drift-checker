#!/usr/bin/env node
// suite-doctor: will this eval suite load under the CURRENT official `claude plugin eval` runner?
//
//   node suite-doctor.mjs <plugin-dir> [--fix] [--runner <path-to-claude>] [--json out.json]
//
// Claude Code 2.1.287 tightened the case format: a case that loaded yesterday now fails with
// "N case file(s) failed to load" and silently drops out of the score. This names every such
// problem per case (case, file, key), says the fix, and with --fix applies the known ones in
// place. Two layers:
//
//   1. Static rules (always, no Claude needed): RULES below, one entry per known breaking
//      change, each with a detect and (when the fix is mechanical) a fix function.
//   2. Live load check (when a Claude Code binary is found: --runner, else `claude` on PATH):
//      the real runner loads every case and starts ZERO agent runs. It is invoked with
//      `--max-cost-usd 0`, whose ceiling is checked before each run launches, so the suite is
//      parsed and validated (load errors print as "✗ <case>: <why>") and then the run aborts
//      with partialReason cost_ceiling, costUsd 0, cases []. As a second guard the runner gets
//      an empty CLAUDE_CONFIG_DIR and no API key env, so it has no credential to spend with.
//      Results, the HTML report and the JSON go to a temp dir, never into the suite.
//
// Exit 1 if any ERROR remains (after --fix, when given), else 0. Exit 2 on a usage error.
// --json writes { findings, live, summary } for CI.
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, mkdtempSync, rmSync, realpathSync, accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- the official format (Claude Code 2.1.287) ----------
export const PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env'];
export const GRADER_KEYS = {
  regex: ['pattern', 'flags', 'match', 'target'],
  tool_used: ['tool', 'input_match', 'min', 'max'],
  tool_order: ['before', 'after'],
  file_exists: ['path', 'exists'],
  llm: ['criteria', 'focus'],
  baseline: ['baseline_file', 'criteria'],
};
const COMMON_GRADER_KEYS = ['type', 'weight', 'arm'];
const ARMS = ['with-only', 'both'];
const SCHEMA_VERSION = '1.1';
const SKIP_DIRS = new Set(['results', 'mocks', 'graders', 'node_modules']);

// ---------- tolerant frontmatter parser (the eval-shim approach, plus block lists) ----------
export function parseScalar(v) {
  v = String(v).trim();
  if (v === '') return '';
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => parseScalar(s)).filter((s) => s !== '');
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true; if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Top-level `key: value` entries of a YAML-ish block, with the line range each one spans
// (block scalars, indented children and `- item` lists belong to the key above them).
export function scanKeys(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!kv) continue;
    const raw = (kv[2] ?? '').trim();
    let end = i + 1;
    if (raw === '' || /^[|>][-+0-9]*(\s+#.*)?$/.test(raw)) {
      while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^-\s/.test(lines[end]) || (lines[end].trim() === '' && /^\s+\S/.test(lines[end + 1] ?? '')))) end++;
    }
    let value;
    const kids = lines.slice(i + 1, end);
    if (/^[|>]/.test(raw)) value = dedent(kids).join(raw.startsWith('|') ? '\n' : ' ');
    else if (raw === '' && kids.some((l) => /^\s*-\s/.test(l))) value = kids.filter((l) => /^\s*-\s/.test(l)).map((l) => parseScalar(l.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '')));
    else value = raw === '' && kids.length ? null : parseScalar(raw.replace(/\s+#[^'"]*$/, ''));
    entries.push({ key: kv[1], raw, value, start: i, end });
    i = end - 1;
  }
  return entries;
}

function dedent(lines) {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length));
  return lines.map((l) => (l.trim() ? l.slice(Number.isFinite(ind) ? ind : 0) : ''));
}

// Split a markdown file into frontmatter lines and the rest, keeping the line ending.
export function splitFrontmatter(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { has: false, eol, fm: [], after: lines };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { has: false, eol, fm: [], after: lines };
  return { has: true, eol, fm: lines.slice(1, close), after: lines.slice(close + 1) };
}
export function parseFrontmatter(text) {
  const s = splitFrontmatter(text);
  const entries = scanKeys(s.fm);
  return { meta: Object.fromEntries(entries.map((e) => [e.key, e.value])), entries };
}
function editFrontmatter(file, edit) {
  const s = splitFrontmatter(readFileSync(file, 'utf8'));
  const fm = edit(s.fm.slice(), scanKeys(s.fm));
  writeFileSync(file, ['---', ...fm, '---', ...s.after].join(s.eol));
}

// ---------- load a suite ----------
export function resolveEvalDir(pluginDir) {
  let rel = 'evals';
  try { rel = JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8')).experimental?.evals ?? rel; } catch { /* no manifest: evals/ */ }
  return path.resolve(pluginDir, rel);
}

export function loadCase(evalDir, dir) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const promptText = read(path.join(dir, 'prompt.md'));
  const caseText = read(path.join(dir, 'case.yaml'));
  const gdir = path.join(dir, 'graders');
  const graders = existsSync(gdir)
    ? readdirSync(gdir).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const text = readFileSync(path.join(gdir, f), 'utf8');
      return { file: `graders/${f}`, path: path.join(gdir, f), ...parseFrontmatter(text) };
    })
    : [];
  return {
    name: path.relative(evalDir, dir), dir,
    prompt: promptText === null ? null : { file: 'prompt.md', path: path.join(dir, 'prompt.md'), ...parseFrontmatter(promptText) },
    caseYaml: caseText === null ? null : { file: 'case.yaml', path: path.join(dir, 'case.yaml'), text: caseText, lines: caseText.split(/\r?\n/), entries: scanKeys(caseText.split(/\r?\n/)) },
    graders,
  };
}

export function loadSuite(pluginDir) {
  const evalDir = resolveEvalDir(pluginDir);
  if (!existsSync(evalDir)) throw new Error(`no eval dir at ${evalDir} (manifest experimental.evals, or evals/)`);
  const cases = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const d = path.join(dir, e.name);
      if (existsSync(path.join(d, 'prompt.md')) || existsSync(path.join(d, 'case.yaml'))) cases.push(loadCase(evalDir, d));
      else walk(d);
    }
  };
  walk(evalDir);
  return { pluginDir: path.resolve(pluginDir), evalDir, cases };
}

// ---------- case.yaml scaffold helpers ----------
// Where scaffold_script sits in case.yaml and what form it takes.
export function findScaffold(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)scaffold_script:[ \t]*(.*?)[ \t]*$/);
    if (!m) continue;
    const indent = m[1].length;
    let parent = null;
    if (indent > 0) for (let j = i - 1; j >= 0; j--) { const p = lines[j].match(/^([A-Za-z_][\w-]*):/); if (p) { parent = p[1]; break; } }
    const value = m[2].replace(/\s+#.*$/, '');
    if (/^[|>][-+0-9]*$/.test(value)) {
      let end = i + 1;
      while (end < lines.length && (lines[end].trim() === '' || lines[end].match(/^[ \t]*/)[0].length > indent)) end++;
      while (end > i + 1 && lines[end - 1].trim() === '') end--;
      return { line: i, end, indent, parent, form: 'block', script: dedent(lines.slice(i + 1, end)).join('\n') };
    }
    const unq = value.replace(/^(['"])(.*)\1$/, '$2');
    return { line: i, end: i + 1, indent, parent, form: /\s/.test(unq) ? 'command' : 'file', value: unq, script: unq };
  }
  return null;
}

export function scaffoldFileText(script) {
  const body = script.split('\n');
  while (body.length && (/^#!/.test(body[0]) || /^set -[euxo]+( pipefail)?\s*$/.test(body[0]) || body[0].trim() === '')) body.shift();
  return ['#!/usr/bin/env bash', 'set -euo pipefail', ...body].join('\n').replace(/\s*$/, '\n');
}

// Put `scaffold_script: <file>` under context:, replacing the old entry's lines.
function placeUnderContext(lines, sc, file) {
  if (sc.parent === 'context') { lines.splice(sc.line, sc.end - sc.line, `${' '.repeat(sc.indent)}scaffold_script: ${file}`); return lines; }
  lines.splice(sc.line, sc.end - sc.line);
  const ctx = lines.findIndex((l) => /^context:[ \t]*(#.*)?$/.test(l));
  if (ctx >= 0) {
    const childIndent = (lines[ctx + 1] ?? '').match(/^([ \t]+)\S/)?.[1] ?? '  ';
    lines.splice(ctx + 1, 0, `${childIndent}scaffold_script: ${file}`);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('context:', `  scaffold_script: ${file}`, '');
  }
  return lines;
}
const writeLines = (file, lines, text) => writeFileSync(file, lines.join(text.includes('\r\n') ? '\r\n' : '\n'));

function readCoversFile(p) {
  const t = readFileSync(p, 'utf8').replace(/#[^\n]*/g, '');
  const b = t.match(/\[([^\]]*)\]/);
  const items = b ? b[1].split(',') : [...t.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1]);
  return items.map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const asList = (v) => (Array.isArray(v) ? v : v === '' || v === null || v === undefined ? [] : [v]).map(String);

// ---------- the rules: one entry per known breaking change ----------
// detect(c) returns findings { file, path, key, message, fix, fixable, ...data };
// fix(c, finding) edits the files on disk (re-reading them, so a stale case object is harmless).
const graderFinding = (g, key, message, fix, fixable, extra = {}) => ({ file: g.file, path: g.path, key, message, fix, fixable, ...extra });

export const RULES = [
  {
    id: 'llm-target-is-focus',
    level: 'ERROR',
    description: 'llm graders name what they judge with focus:, not target: (2.1.287 rejects target on llm graders)',
    detect: (c) => c.graders.filter((g) => g.meta.type === 'llm' && 'target' in g.meta).map((g) => graderFinding(g, 'target',
      'llm grader uses target:, which the runner rejects ("Unrecognized key(s) in object: \'target\'")',
      'focus' in g.meta ? 'delete target: by hand (focus: is already set)' : 'rename target: to focus: (value kept)',
      !('focus' in g.meta))),
    fix: (c, f) => editFrontmatter(f.path, (fm, entries) => { const e = entries.find((x) => x.key === 'target'); fm[e.start] = fm[e.start].replace(/^target:/, 'focus:'); return fm; }),
  },
  {
    id: 'scaffold-script-file',
    level: 'ERROR',
    description: 'context.scaffold_script names a script file in the case dir; an inline script (block or one-liner) is the old form and is not run',
    detect: (c) => {
      const sc = c.caseYaml && findScaffold(c.caseYaml.lines);
      if (!sc || sc.form === 'file') return [];
      const target = path.join(c.dir, 'scaffold.sh');
      const clash = existsSync(target) && readFileSync(target, 'utf8') !== scaffoldFileText(sc.script);
      return [{ file: 'case.yaml', path: c.caseYaml.path, key: 'scaffold_script',
        message: `scaffold_script is an inline ${sc.form === 'block' ? 'block' : 'command'}; the runner wants a script file name, so this scaffold never runs`,
        fix: clash ? 'move the script to a file by hand (scaffold.sh already exists with other content) and set context.scaffold_script to its name'
          : 'write the script to scaffold.sh (bash, set -euo pipefail, mode 755) and set context.scaffold_script: scaffold.sh',
        fixable: !clash }];
    },
    fix: (c, f) => {
      const text = readFileSync(f.path, 'utf8');
      const lines = text.split(/\r?\n/);
      const sc = findScaffold(lines);
      const target = path.join(c.dir, 'scaffold.sh');
      writeFileSync(target, scaffoldFileText(sc.script));
      chmodSync(target, 0o755);
      writeLines(f.path, placeUnderContext(lines, sc, 'scaffold.sh'), text);
    },
  },
  {
    id: 'scaffold-under-context',
    level: 'ERROR',
    description: 'scaffold_script belongs under context:; at the top level the runner ignores it and the case runs unstaged',
    detect: (c) => {
      const sc = c.caseYaml && findScaffold(c.caseYaml.lines);
      if (!sc || sc.form !== 'file') return [];
      const out = [];
      if (sc.parent !== 'context') out.push({ file: 'case.yaml', path: c.caseYaml.path, key: 'scaffold_script',
        message: `scaffold_script: ${sc.value} is not under context:, so the runner ignores it`,
        fix: `move it under context: (context:\\n  scaffold_script: ${sc.value})`, fixable: true });
      if (!existsSync(path.join(c.dir, sc.value))) out.push({ file: 'case.yaml', path: c.caseYaml.path, key: 'scaffold_script',
        message: `scaffold_script names ${sc.value}, which does not exist in the case dir`, fix: `create ${sc.value} or fix the name`, fixable: false });
      return out;
    },
    fix: (c, f) => {
      const text = readFileSync(f.path, 'utf8');
      const lines = text.split(/\r?\n/);
      const sc = findScaffold(lines);
      if (sc.parent !== 'context') writeLines(f.path, placeUnderContext(lines, sc, sc.value), text);
    },
  },
  {
    id: 'case-yaml-header',
    level: 'ERROR',
    description: `case.yaml needs schema_version: "${SCHEMA_VERSION}" and name (the runner refuses the case without them)`,
    detect: (c) => {
      if (!c.caseYaml) return [];
      const keys = new Set(c.caseYaml.entries.map((e) => e.key));
      return ['schema_version', 'name'].filter((k) => !keys.has(k)).map((k) => ({ file: 'case.yaml', path: c.caseYaml.path, key: k,
        message: k === 'name' ? 'case.yaml has no name ("name: Required")' : 'case.yaml has no schema_version ("missing required field schema_version")',
        fix: k === 'name' ? `add name: ${path.basename(c.dir)} (the case directory name)` : `add schema_version: "${SCHEMA_VERSION}"`, fixable: true }));
    },
    fix: (c, f) => {
      const text = readFileSync(f.path, 'utf8');
      const lines = text.split(/\r?\n/);
      const entries = scanKeys(lines);
      if (entries.some((e) => e.key === f.key)) return;
      if (f.key === 'schema_version') lines.splice(0, 0, `schema_version: "${SCHEMA_VERSION}"`);
      else { const sv = entries.find((e) => e.key === 'schema_version'); lines.splice(sv ? sv.end : 0, 0, `name: ${path.basename(c.dir)}`); }
      writeLines(f.path, lines, text);
    },
  },
  {
    id: 'tool-used-max-zero-needs-min',
    level: 'ERROR',
    description: 'tool_used with max: 0 needs min: 0 (min defaults to 1, so max: 0 alone means 1..0 and never passes)',
    detect: (c) => c.graders.filter((g) => g.meta.type === 'tool_used' && (g.meta.max === 0 || g.meta.max === '0') && !('min' in g.meta)).map((g) => graderFinding(g, 'max',
      'tool_used grader has max: 0 but no min:, and min defaults to 1, so it can never pass', 'add min: 0', true)),
    fix: (c, f) => editFrontmatter(f.path, (fm, entries) => { if (!entries.some((e) => e.key === 'min')) fm.splice(entries.find((e) => e.key === 'max').end, 0, 'min: 0'); return fm; }),
  },
  {
    id: 'grader-arm-value',
    level: 'ERROR',
    description: `grader arm: must be ${ARMS.join(' or ')}`,
    detect: (c) => c.graders.filter((g) => 'arm' in g.meta && !ARMS.includes(String(g.meta.arm))).map((g) => {
      const v = String(g.meta.arm);
      return graderFinding(g, 'arm', `arm: ${v} is not a valid arm (expected ${ARMS.join(' | ')})`,
        v === 'with' ? 'change arm: with to arm: with-only'
          : v === 'without' ? 'no official equivalent for a without-only grader: drop arm: (grade both arms) or remove the grader'
            : `set arm: to ${ARMS.join(' or ')}`,
        v === 'with');
    }),
    fix: (c, f) => editFrontmatter(f.path, (fm, entries) => { const e = entries.find((x) => x.key === 'arm'); fm[e.start] = fm[e.start].replace(/^arm:([ \t]*)(['"]?)with\2/, 'arm:$1with-only'); return fm; }),
  },
  {
    id: 'grader-known-keys',
    level: 'ERROR',
    description: 'every grader key must be one the runner allows for its type (unknown keys fail the whole case)',
    detect: (c) => c.graders.flatMap((g) => {
      const type = g.meta.type;
      if (!type) return [graderFinding(g, 'type', 'grader has no type:', `add type: (one of ${Object.keys(GRADER_KEYS).join(', ')})`, false)];
      if (!GRADER_KEYS[type]) return [graderFinding(g, 'type', `unknown grader type ${type}`, `use one of ${Object.keys(GRADER_KEYS).join(', ')}`, false)];
      const allowed = [...COMMON_GRADER_KEYS, ...GRADER_KEYS[type]];
      return Object.keys(g.meta)
        .filter((k) => !allowed.includes(k) && !(type === 'llm' && k === 'target')) // llm target: has its own rule and fix
        .map((k) => graderFinding(g, k, `${type} grader has key ${k}:, which the runner rejects`, `remove ${k}: (allowed for ${type}: ${allowed.join(', ')})`, false));
    }),
  },
  {
    id: 'regex-target-files',
    level: 'WARN',
    description: 'regex target: files matches the list of created paths, not file contents, in the official runner',
    detect: (c) => c.graders.filter((g) => g.meta.type === 'regex' && g.meta.target === 'files').map((g) => graderFinding(g, 'target',
      'regex target: files only sees the list of created paths, not their contents',
      'to grade contents use target: { source: file, path: <path> }, or grade last_message', false)),
  },
  {
    id: 'prompt-frontmatter-keys',
    level: 'ERROR',
    description: 'prompt.md frontmatter keys must be in the official whitelist (an unknown key fails the case)',
    detect: (c) => {
      if (!c.prompt) return [];
      return Object.keys(c.prompt.meta).filter((k) => !PROMPT_KEYS.includes(k)).map((k) => {
        if (k !== 'covers') return { file: 'prompt.md', path: c.prompt.path, key: k, message: `unknown frontmatter key ${k}:`, fix: `remove ${k}: (allowed: ${PROMPT_KEYS.join(', ')})`, fixable: false };
        const items = asList(c.prompt.meta.covers);
        const sidecar = path.join(c.dir, 'covers.yaml');
        const merged = !existsSync(sidecar) || items.every((x) => readCoversFile(sidecar).includes(x));
        return { file: 'prompt.md', path: c.prompt.path, key: 'covers', message: 'covers: in prompt.md frontmatter is not an official key',
          fix: merged ? 'move covers: to a covers.yaml sidecar next to prompt.md' : 'merge these ids into the existing covers.yaml by hand, then delete covers: from prompt.md',
          fixable: merged };
      });
    },
    fix: (c, f) => {
      if (f.key !== 'covers') return;
      let items = [];
      editFrontmatter(f.path, (fm, entries) => { const e = entries.find((x) => x.key === 'covers'); items = asList(e.value); fm.splice(e.start, e.end - e.start); return fm; });
      const sidecar = path.join(c.dir, 'covers.yaml');
      if (!existsSync(sidecar)) writeFileSync(sidecar, `# rule ids this case exercises (config-coverage.mjs --list prints valid ids)\n${items.length ? items.map((x) => `- ${x}`).join('\n') : '[]'}\n`);
    },
  },
];

// ---------- static layer ----------
export function diagnose(suite) {
  return suite.cases.flatMap((c) => RULES.flatMap((r) => r.detect(c).map((f) => ({ level: r.level, rule: r.id, case: c.name, source: 'static', ...f }))));
}

// Apply every fixable finding, rule by rule, reloading each case after an edit. Returns what was fixed.
export function applyFixes(suite) {
  const fixed = [];
  for (let i = 0; i < suite.cases.length; i++) {
    for (const r of RULES) {
      if (!r.fix) continue;
      for (const f of r.detect(suite.cases[i])) {
        if (!f.fixable) continue;
        r.fix(suite.cases[i], f);
        fixed.push({ level: r.level, rule: r.id, case: suite.cases[i].name, source: 'static', ...f, fixed: true });
        suite.cases[i] = loadCase(suite.evalDir, suite.cases[i].dir);
      }
    }
  }
  return fixed;
}

// ---------- live layer: the real runner loads the suite, zero runs ----------
export function findRunner(explicit, envPath = process.env.PATH ?? '') {
  const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (explicit) return executable(explicit) ? { path: path.resolve(explicit) } : { path: null, reason: `--runner ${explicit} is not an executable file` };
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'claude');
    if (executable(p)) return { path: p };
  }
  return { path: null, reason: 'no --runner given and no claude on PATH' };
}

const KEY_PATTERNS = [
  [/Unrecognized key\(s\) in object: '([^']+)'/, 1],
  [/unknown frontmatter key "([^"]+)"/, 1],
  [/missing required field (\w+)/, 1],
  [/graders\.\d+\.(\w+):/, 1],
  [/^\s*(\w+): Required/, 1],
];

// Turn the runner's "✗ <path>: <why>" and "⚠ case ..." lines into structured findings.
export function parseRunnerOutput(text, suite) {
  const loadErrors = [], notes = [];
  let failedCount = null;
  for (const line of text.split(/\r?\n/)) {
    const fail = line.match(/^✗\s+(.+?): (.*)$/);
    if (fail) {
      let p = fail[1], why = fail[2].trim(), file = null;
      const fm = p.match(/[\\/](case\.yaml|prompt\.md)$/);
      if (fm) { file = fm[1]; p = p.slice(0, -fm[0].length); }
      const pm = why.match(/^(prompt\.md|case\.yaml): (.*)$/);
      if (pm && pm[1] === 'prompt.md') { file = 'prompt.md'; why = pm[2]; }
      why = why.replace(/^invalid case\.yaml:\s*/, '').replace(/\s+/g, ' ');
      const c = suite.cases.find((x) => path.resolve(x.dir) === path.resolve(p));
      const gi = why.match(/^graders\.(\d+)\b/);
      if (gi && c && !c.caseYaml?.entries.some((e) => e.key === 'graders')) file = c.graders[Number(gi[1])]?.file ?? file;
      file ??= c?.caseYaml ? 'case.yaml' : 'prompt.md';
      const key = KEY_PATTERNS.map(([re, g]) => why.match(re)?.[g]).find(Boolean) ?? null;
      loadErrors.push({ case: c ? c.name : path.relative(suite.evalDir, p) || p, file, key, message: why });
      continue;
    }
    const warn = line.match(/^⚠\s+(.*)$/);
    if (warn) notes.push(warn[1].trim());
    const n = line.match(/(\d+) case file\(s\) failed to load/);
    if (n) failedCount = Number(n[1]);
  }
  return { loadErrors, notes, failedCount: failedCount ?? loadErrors.length };
}

export function liveLoadCheck(suite, runnerPath, { timeoutMs = 180_000 } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'suite-doctor-'));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(work, 'config') };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    const version = (spawnSync(runnerPath, ['--version'], { encoding: 'utf8', env, timeout: 30_000 }).stdout ?? '').trim().split(/\s+/)[0] || null;
    const json = path.join(work, 'result.json');
    const run = (trust) => {
      const args = ['plugin', 'eval', suite.pluginDir, '--max-cost-usd', '0', ...(trust ? ['--trust-plugin'] : []), '--no-publish',
        '--output-dir', path.join(work, 'out'), '--report', path.join(work, 'report.html'), '--json', json];
      const r = spawnSync(runnerPath, args, { encoding: 'utf8', env, cwd: work, timeout: timeoutMs });
      return { r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    };
    let { r, output } = run(true);
    // versions before the trust prompt existed reject the flag; they need no trust either
    if (/unknown option '--trust-plugin'/.test(output)) ({ r, output } = run(false));
    // never retry without the cost ceiling: without it the load check would start real runs
    if (/unknown option '--max-cost-usd'/.test(output)) return { status: 'skipped', reason: `Claude Code ${version ?? '?'} has no --max-cost-usd, so a run-free load check is not possible`, runner: runnerPath, version };
    if (/early access/i.test(output)) return { status: 'skipped', reason: `Claude Code ${version ?? '?'} has no official eval runner yet (early access)`, runner: runnerPath, version };
    const parsed = parseRunnerOutput(output, suite);
    let result = null;
    try { result = JSON.parse(readFileSync(json, 'utf8')); } catch { /* checked below */ }
    const base = { runner: runnerPath, version, ...parsed };
    if (!result) {
      const tail = output.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || (r.error?.message ?? `exit ${r.status}`);
      return { status: 'failed', reason: `the runner wrote no result JSON: ${tail}`, ...base, runsStarted: null, costUsd: null };
    }
    const runsStarted = (result.cases ?? []).reduce((n, c) => n + Object.values(c.arms ?? {}).reduce((m, runs) => m + (runs?.length ?? 0), 0), 0);
    return { status: 'ok', ...base, runsStarted, costUsd: result.costUsd ?? 0, partialReason: result.partialReason ?? null, loaded: suite.cases.length - parsed.failedCount };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Fold runner load errors into the static findings: one the rules already explain is marked
// confirmedByRunner; anything else becomes its own ERROR the rules do not know about yet.
export function mergeLive(findings, loadErrors) {
  const extra = [];
  for (const le of loadErrors) {
    const hit = findings.find((f) => f.level === 'ERROR' && f.case === le.case && f.file === le.file && (!le.key || f.key === le.key));
    if (hit) { hit.confirmedByRunner = true; hit.runnerMessage = le.message; continue; }
    extra.push({ level: 'ERROR', rule: 'runner-load', case: le.case, file: le.file, key: le.key, source: 'runner',
      message: `the runner refused this case: ${le.message}`, fix: 'no doctor rule covers this yet; fix it from the runner message', fixable: false });
  }
  return [...findings, ...extra];
}

// ---------- report ----------
// Runner notes that only reflect how the doctor invokes it (no tools granted, scaffolds off).
const INVOCATION_NOTE = /not run without --scaffold|is not granted/;

export function formatReport(res) {
  const out = [];
  const line = (f, tag = f.level) => `  ${tag.padEnd(5)}  ${f.case}  ${f.file}${f.key ? `  ${f.key}:` : ''}  ${f.message}. Fix: ${f.fix}. ${tag === 'FIXED' ? '[fixed]' : f.fixable ? '[--fix can apply]' : '[manual]'}${f.confirmedByRunner ? ' [runner agrees]' : ''}`;
  out.push(`suite-doctor: ${res.cases} case(s) in ${res.evalDir}`);
  for (const f of res.fixed) out.push(line(f, 'FIXED'));
  for (const f of res.findings) out.push(line(f));
  const lv = res.live;
  if (lv.status === 'skipped') out.push(`live load check: skipped (${lv.reason}); static rules only`);
  else if (lv.status === 'failed') out.push(`live load check: could not complete with ${lv.runner}: ${lv.reason}`);
  else {
    out.push(`live load check: claude ${lv.version ?? '(unknown version)'} loaded ${lv.loaded} of ${res.cases} case(s), ${lv.failedCount} failed to load; ${lv.runsStarted} agent run(s) started, $${Number(lv.costUsd).toFixed(2)} spent`);
    const shown = lv.notes.filter((n) => !INVOCATION_NOTE.test(n));
    for (const n of shown) out.push(`  INFO   runner: ${n}`);
    if (lv.notes.length > shown.length) out.push(`  (${lv.notes.length - shown.length} runner note(s) about tool grants and scaffolds omitted: they depend on the eval flags you run with; see --json)`);
  }
  const s = res.summary;
  const confirmed = res.live?.status === 'ok';
  const verdict = s.errors ? 'Some cases will not load under the official runner.'
    : confirmed ? 'Every case is valid for the official runner.'
    : 'Static checks passed; not confirmed against the runner because the live load check did not run.';
  out.push(`summary: ${s.errors} error(s), ${s.warnings} warning(s)${res.fixApplied ? `, ${s.fixed} fixed` : s.fixable ? `, ${s.fixable} fixable with --fix` : ''}. ${verdict}`);
  return out.join('\n');
}

// ---------- orchestration ----------
const displayPath = (p) => { const r = path.relative(process.cwd(), p); return !r ? '.' : r.startsWith('..') ? p : r; };
export function doctor(pluginDir, { fix = false, runner = null, live = true, envPath } = {}) {
  let suite = loadSuite(pluginDir);
  const fixed = fix ? applyFixes(suite) : [];
  if (fix) suite = loadSuite(pluginDir);
  let findings = diagnose(suite);
  let liveRes = { status: 'skipped', reason: 'live check disabled' };
  if (live) {
    const found = findRunner(runner, envPath);
    liveRes = found.path ? liveLoadCheck(suite, found.path) : { status: 'skipped', reason: found.reason };
    if (liveRes.status === 'ok' || liveRes.status === 'failed') findings = mergeLive(findings, liveRes.loadErrors ?? []);
    if (liveRes.status === 'ok' && (liveRes.runsStarted > 0 || liveRes.costUsd > 0)) findings.push({ level: 'WARN', rule: 'live-zero-runs', case: '(suite)', file: '-', key: null, source: 'runner',
      message: `the load check started ${liveRes.runsStarted} run(s) costing $${liveRes.costUsd}; --max-cost-usd 0 no longer stops before the first run`, fix: 'report this; run the doctor with no runner until it is fixed', fixable: false });
  }
  const summary = {
    errors: findings.filter((f) => f.level === 'ERROR').length,
    warnings: findings.filter((f) => f.level === 'WARN').length,
    fixed: fixed.length,
    fixable: findings.filter((f) => f.fixable).length,
  };
  const strip = ({ path: _p, ...f }) => f;
  return { pluginDir: suite.pluginDir, evalDir: displayPath(suite.evalDir), cases: suite.cases.length, fixApplied: fix,
    fixed: fixed.map(strip), findings: findings.map(strip), live: liveRes, summary, exitCode: summary.errors ? 1 : 0 };
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  let dir = null, fix = false, runner = null, jsonOut = null;
  const usage = 'usage: suite-doctor.mjs <plugin-dir> [--fix] [--runner <path-to-claude>] [--json out.json]';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') fix = true;
    else if (a === '--runner') runner = argv[++i];
    else if (a === '--json') jsonOut = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else if (!a.startsWith('--') && !dir) dir = a;
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  if (!dir || (argv.includes('--runner') && !runner) || (argv.includes('--json') && !jsonOut)) { console.error(usage); process.exit(2); }
  let res;
  try { res = doctor(dir, { fix, runner }); } catch (e) { console.error(`suite-doctor: ${e.message}`); process.exit(2); }
  console.log(formatReport(res));
  if (jsonOut) { const { exitCode: _e, ...data } = res; await fs.writeFile(jsonOut, JSON.stringify(data, null, 2) + '\n'); }
  process.exit(res.exitCode);
}
