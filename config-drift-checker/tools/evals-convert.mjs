#!/usr/bin/env node
// evals-convert: move eval cases between skill-creator's evals/evals.json and the official
// `claude plugin eval` case format. The two tools never read each other's cases, so a skill
// built with skill-creator starts its plugin-eval life with an empty suite; this closes the gap.
//
//   node evals-convert.mjs import <evals.json> [--plugin <dir>] [--eval-dir <dir>] [--skill <name>]
//        [--skill-dir <dir>] [--allowed-tools a,b] [--covers id,id] [--force] [--dry-run]
//   node evals-convert.mjs export <plugin-dir> [--eval-dir <dir>] [--skill <name>] [--out evals.json] [--force]
//
// import: one case directory per eval, named by a deterministic slug. prompt -> prompt.md body;
//   each expectation (and expected_output) -> an llm grader whose body is the criteria, focus
//   last_message, or files when the statement is about files; input files -> scaffold.sh plus
//   case.yaml that copy them into the workspace; a known skill name -> a with-only tool_used: Skill
//   trigger grader. A trigger eval set ([{ query, should_trigger }], skill-creator's description
//   optimizer input) becomes one trigger case per query. Existing case dirs are never touched
//   unless --force (then replaced whole); with any clash nothing is written. covers.yaml only with
//   --covers. --dry-run prints the plan and writes nothing.
// export: plugin-eval cases -> evals.json on stdout (or --out). What maps cleanly is carried over
//   (prompt, llm criteria -> expectations, expected_outcome -> expected_output, imported input
//   files -> files, the Skill trigger's name -> skill_name); everything else is listed in a
//   "not carried over" report on stderr, never silently dropped.
//
// Exit 0 on success, 1 when import refuses (existing case dirs, missing input files) or export
// cannot write, 2 on a usage error.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEvalDir, loadSuite, loadCase, splitFrontmatter } from './suite-doctor.mjs';

export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'Bash', 'Write', 'Edit'];
const GATED_TOOLS = ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'];
const SCAFFOLD_MARK = '# evals-convert input: ';
const INPUTS_LINE = 'Input files (copied into the working directory): ';

// ---------- small helpers ----------
export function slugify(text, max = 48) {
  const s = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return (cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut).replace(/-+$/, '');
}
const firstWords = (text, n = 5) => slugify(String(text).split(/\s+/).filter(Boolean).slice(0, n).join(' '), 40);
const yamlString = (s) => JSON.stringify(String(s)); // a JSON string is a valid YAML double-quoted scalar
const sq = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`; // bash single-quote
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (p) => p.split(path.sep).join('/');
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Statements about files get focus: files (the list of paths Claude created); the rest are judged
// on the final reply. A concrete file name or the words file/folder/directory make it file-ish.
const FILE_WORDS = /\b(files?|filenames?|folders?|directory|directories)\b/i;
const FILE_NAME = /\b[\w./-]+\.(pdf|docx?|xlsx?|csv|tsv|json|jsonl|md|txt|png|jpe?g|gif|svg|html?|pptx?|ya?ml|py|js|mjs|ts|tsx|java|go|rs|rb|sh|zip|xml|toml|ipynb)\b/i;
export const isAboutFiles = (text) => FILE_WORDS.test(text) || FILE_NAME.test(text);

export const triggerMatch = (skill) => `"skill"\\s*:\\s*"(?:[\\w-]+:)?${escapeRe(skill)}"`;
function skillFromMatch(im) {
  const s = String(im ?? '');
  const m = s.match(/\(\?:\[\\w-\]\+:\)\?([\w.-]+?)"?$/) ?? s.match(/^([\w-]+)$/);
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

// ---------- read skill-creator input ----------
// evals.json ({ skill_name, evals: [...] }) or a trigger eval set ([{ query, should_trigger }]).
export function readSkillCreator(data) {
  if (Array.isArray(data)) {
    const bad = data.findIndex((x) => !x || typeof x.query !== 'string' || typeof x.should_trigger !== 'boolean');
    if (bad >= 0) throw new Error(`trigger eval set item ${bad} needs a string query and a boolean should_trigger`);
    return { kind: 'triggers', skillName: null, items: data.map((x, i) => ({ id: i + 1, prompt: x.query, shouldTrigger: x.should_trigger })) };
  }
  if (!data || !Array.isArray(data.evals)) throw new Error('not a skill-creator evals.json: expected { "skill_name", "evals": [...] } or a trigger set [{ "query", "should_trigger" }]');
  const items = data.evals.map((e, i) => {
    if (!e || typeof e.prompt !== 'string' || !e.prompt.trim()) throw new Error(`evals[${i}] has no prompt`);
    const exp = e.expectations ?? e.assertions ?? [];
    return {
      id: e.id ?? i + 1,
      name: e.name ?? e.eval_name ?? null,
      prompt: e.prompt,
      expectedOutput: typeof e.expected_output === 'string' && e.expected_output.trim() ? e.expected_output.trim() : null,
      files: (e.files ?? []).map(String),
      expectations: (Array.isArray(exp) ? exp : [exp]).map((x) => (typeof x === 'string' ? x : x?.text ?? '')).map((s) => s.trim()).filter(Boolean),
    };
  });
  return { kind: 'evals', skillName: data.skill_name ? String(data.skill_name) : null, items };
}

// ---------- import: build the plan ----------
const frontmatter = (pairs) => ['---', ...pairs.filter((pair) => pair.length === 1 || (pair[1] !== undefined && pair[1] !== null)).map(([k, v]) => (k.startsWith('#') ? k : `${k}: ${v}`)), '---'].join('\n');
const list = (xs) => `[${xs.join(', ')}]`;

function llmGrader(criteria) {
  const files = isAboutFiles(criteria);
  return {
    focus: files ? 'files' : 'last_message',
    text: `${frontmatter([
      ['type', 'llm'],
      ['focus', files ? 'files' : 'last_message'],
      ...(files ? [['# focus files shows the judge the paths Claude created, not their contents; to judge a file\'s contents use focus: { source: file, path: <path> }']] : []),
    ])}\n${criteria}\n`,
  };
}

// Where an input file lands in the workspace: its path as written, unless that escapes the workspace.
const workspacePath = (f) => { const n = path.posix.normalize(f.replace(/\\/g, '/')); return n.startsWith('../') || n === '..' || path.posix.isAbsolute(n) ? path.posix.basename(n) : n; };

export function planImport(input, { pluginDir, evalDir = resolveEvalDir(pluginDir), skillDir, skill = null, allowedTools = DEFAULT_ALLOWED_TOOLS, covers = null } = {}) {
  const src = readSkillCreator(input);
  const skillName = skill ?? src.skillName;
  if (src.kind === 'triggers' && !skillName) throw new Error('a trigger eval set names no skill: pass --skill <name>');
  if (skillName && !/^[\w.-]+$/.test(skillName)) throw new Error(`skill name ${JSON.stringify(skillName)} is not a skill directory name (letters, digits, - _ .)`);
  const used = new Set();
  const errors = [];
  const cases = src.items.map((it) => {
    const stem = src.kind === 'triggers' ? `${slugify(skillName, 24)}-${it.shouldTrigger ? 'trigger' : 'no-trigger'}-${it.id}` : it.name ? slugify(it.name) : `${slugify(skillName ?? 'eval', 24) || 'eval'}-${slugify(String(it.id), 12) || 'x'}`;
    let slug = src.kind === 'evals' && it.name ? stem : [stem, firstWords(it.prompt)].filter(Boolean).join('-');
    for (let n = 2; used.has(slug); n++) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
    used.add(slug);
    const dir = path.join(evalDir, slug);
    const files = [];
    const copies = [];
    const notes = [];

    // input files -> scaffold.sh copies them from the plugin (or from a copy kept in the case dir)
    const inputs = (it.files ?? []).map((f) => {
      const abs = path.resolve(skillDir, f);
      const dest = workspacePath(f);
      if (!existsSync(abs)) errors.push(`${slug}: input file ${f} not found at ${abs}`);
      let fromRoot;
      if (inside(abs, pluginDir)) fromRoot = posix(path.relative(pluginDir, abs));
      else { copies.push({ from: abs, rel: `files/${dest}` }); fromRoot = posix(path.relative(pluginDir, path.join(dir, 'files', dest))); }
      return { written: f, dest, fromRoot };
    });

    const prompt = it.prompt.trim() + (inputs.length ? `\n\n${INPUTS_LINE}${inputs.map((x) => `\`${x.dest}\``).join(', ')}` : '');
    files.push({ rel: 'prompt.md', text: `${frontmatter([
      ['description', yamlString(src.kind === 'triggers'
        ? `Imported from a skill-creator trigger eval set: the ${skillName} skill should ${it.shouldTrigger ? '' : 'not '}fire on this request.`
        : `Imported from skill-creator evals.json${skillName ? ` (${skillName})` : ''}, eval ${it.id}.`)],
      ['tags', list(['skill-creator', ...(skillName ? [slugify(skillName)] : []), ...(src.kind === 'triggers' ? [it.shouldTrigger ? 'trigger' : 'negative-trigger'] : [])])],
      ['expected_outcome', it.expectedOutput ? yamlString(it.expectedOutput) : undefined],
      ['allowed_tools', allowedTools.length ? list(allowedTools) : undefined],
    ])}\n${prompt}\n` });

    const graders = [];
    if (skillName) {
      const fired = src.kind !== 'triggers' || it.shouldTrigger;
      graders.push({ rel: fired ? 'graders/skill-fired.md' : 'graders/skill-not-fired.md', kind: fired ? 'tool_used Skill, with-only' : 'tool_used Skill, never (both arms)',
        text: `${frontmatter([['type', 'tool_used'], ['tool', 'Skill'], ['input_match', `'${triggerMatch(skillName)}'`], ...(fired ? [['min', 1], ['arm', 'with-only']] : [['min', 0], ['max', 0], ['arm', 'both']])])}\n${fired
          ? `The ${skillName} skill fired (also matches its namespaced plugin:${skillName} form). An indicator only: never scored against the no-plugin arm.`
          : `The ${skillName} skill must NOT fire on this request.`}\n` });
    }
    if (it.expectedOutput) { const g = llmGrader(it.expectedOutput); graders.push({ rel: 'graders/expected-output.md', kind: `llm, focus ${g.focus}`, text: g.text }); }
    (it.expectations ?? []).forEach((e, i) => {
      const g = llmGrader(e);
      graders.push({ rel: `graders/expect-${String(i + 1).padStart(2, '0')}-${firstWords(e, 6) || 'statement'}.md`, kind: `llm, focus ${g.focus}`, text: g.text });
    });
    if (!graders.length) notes.push('no expectations, expected_output or skill name: the case has no graders and scores nothing until you add one');
    files.push(...graders);

    if (inputs.length) {
      const up = posix(path.relative(dir, pluginDir)) || '.';
      const dirs = [...new Set(inputs.map((x) => path.posix.dirname(x.dest)).filter((d) => d !== '.'))];
      files.push({ rel: 'scaffold.sh', mode: 0o755, text: [
        '#!/usr/bin/env bash',
        '# runs in the empty workspace before the agent starts (claude plugin eval --scaffold):',
        '# copies the skill-creator eval\'s input files into the workspace, at the paths the prompt names',
        'set -euo pipefail',
        `ROOT="\${EVAL_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/${up}" && pwd)}"`,
        ...(dirs.length ? [`mkdir -p ${dirs.map(sq).join(' ')}`] : []),
        ...inputs.flatMap((x) => [`${SCAFFOLD_MARK}${x.dest}`, `cp "$ROOT"/${sq(x.fromRoot)} ${sq(x.dest)}`]),
        '',
      ].join('\n') });
      files.push({ rel: 'case.yaml', text: `schema_version: "1.1"\n# name matches the directory so --case globs work the same under both runners\nname: ${slug}\ncontext:\n  scaffold_script: scaffold.sh\n` });
    }
    if (covers?.length) files.push({ rel: 'covers.yaml', text: `# rule ids this case exercises (config-coverage.mjs --list prints valid ids)\n${covers.map((x) => `- ${x}`).join('\n')}\n` });
    return { slug, id: it.id, dir, exists: existsSync(dir), files, copies, inputs, graders: graders.map((g) => ({ file: g.rel, kind: g.kind })), notes };
  });
  return { kind: src.kind, skillName, pluginDir, evalDir, cases, errors };
}

export function applyImport(plan, { force = false } = {}) {
  const clashes = plan.cases.filter((c) => c.exists);
  if (plan.errors.length) return { written: [], refused: plan.errors };
  if (clashes.length && !force) return { written: [], refused: clashes.map((c) => `${c.slug}: case dir already exists (use --force to replace it)`) };
  const written = [];
  for (const c of plan.cases) {
    if (c.exists) rmSync(c.dir, { recursive: true, force: true });
    for (const f of c.files) {
      const p = path.join(c.dir, f.rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, f.text);
      if (f.mode) chmodSync(p, f.mode);
    }
    for (const cp of c.copies) { const p = path.join(c.dir, cp.rel); mkdirSync(path.dirname(p), { recursive: true }); copyFileSync(cp.from, p); }
    written.push(c.slug);
  }
  return { written, refused: [] };
}

const displayPath = (p) => { const r = path.relative(process.cwd(), p); return !r ? '.' : r.startsWith('..') ? p : r; };
export function formatImportPlan(plan, { dryRun = false, force = false, allowedTools = DEFAULT_ALLOWED_TOOLS } = {}) {
  const out = [`evals-convert import: ${plan.cases.length} ${plan.kind === 'triggers' ? 'trigger quer(ies)' : 'eval(s)'}${plan.skillName ? `, skill ${plan.skillName}` : ', no skill name (no trigger grader)'} -> ${displayPath(plan.evalDir)}/`];
  for (const c of plan.cases) {
    const verb = c.exists ? (force ? 'replace' : 'exists ') : 'create ';
    out.push(`  ${verb}  ${c.slug}/`);
    out.push(`           prompt.md${c.inputs.length ? `, case.yaml + scaffold.sh (${c.inputs.length} input file(s)${c.copies.length ? `, ${c.copies.length} copied into files/` : ''})` : ''}${c.files.some((f) => f.rel === 'covers.yaml') ? ', covers.yaml' : ''}`);
    for (const g of c.graders) out.push(`           ${g.file}  (${g.kind})`);
    for (const n of c.notes) out.push(`           note: ${n}`);
  }
  for (const e of plan.errors) out.push(`  ERROR  ${e}`);
  const clashes = plan.cases.filter((c) => c.exists).length;
  if (clashes && !force) out.push(`  ERROR  ${clashes} case dir(s) already exist; nothing is written unless you pass --force (which replaces them whole)`);
  const gated = allowedTools.filter((t) => GATED_TOOLS.includes(t));
  const scaffolds = plan.cases.some((c) => c.inputs.length);
  out.push(`run it: claude plugin eval ${displayPath(plan.pluginDir)}${scaffolds ? ' --scaffold' : ''}${gated.length ? ` --allow-tools ${gated.join(',')}` : ''}  (skill-creator runs had every tool; the official runner grants only read-only ones unless you pass --allow-tools)`);
  if (dryRun) out.push('dry run: nothing written.');
  return out.join('\n');
}

// ---------- export ----------
function decodeScalar(entry) {
  if (!entry) return null;
  const raw = entry.raw.replace(/\s+#[^'"]*$/, '');
  if (/^".*"$/.test(raw)) { try { return JSON.parse(raw); } catch { /* fall through */ } }
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  return typeof entry.value === 'string' ? entry.value : entry.value === null ? null : String(entry.value);
}
const bodyOf = (text) => splitFrontmatter(text).after.join('\n').trim();

export function exportSuite(pluginDir, { evalDir = null, skill = null } = {}) {
  const cases = evalDir ? loadCasesAt(path.resolve(evalDir)) : loadSuite(pluginDir).cases;
  const lost = [];
  const skillsSeen = new Set();
  const evals = [];
  for (const c of cases) {
    const miss = (file, what) => lost.push({ case: c.name, file, what });
    if (!c.prompt) { miss('case.yaml', 'case has no prompt.md, so there is no prompt to carry over: whole case skipped'); continue; }
    let prompt = bodyOf(readFileSync(c.prompt.path, 'utf8'));
    const entries = Object.fromEntries(c.prompt.entries.map((e) => [e.key, e]));
    const expected = decodeScalar(entries.expected_outcome);
    for (const k of Object.keys(entries).filter((k) => k !== 'expected_outcome')) {
      if (['description', 'tags'].includes(k)) continue;
      miss('prompt.md', `${k}: ${entries[k].raw || '(block)'} (run settings have no place in evals.json)`);
    }

    // input files the importer wrote, recovered from scaffold.sh markers; any other scaffold is lost
    let files = [];
    const sc = c.caseYaml?.lines.join('\n').match(/scaffold_script:[ \t]*["']?([^\s"'|>]+)["']?/);
    const scPath = sc && path.join(c.dir, sc[1]);
    const marked = scPath && existsSync(scPath) ? readFileSync(scPath, 'utf8').split('\n').filter((l) => l.startsWith(SCAFFOLD_MARK)).map((l) => l.slice(SCAFFOLD_MARK.length).trim()) : [];
    if (marked.length) {
      files = marked;
      const footer = prompt.lastIndexOf(`\n${INPUTS_LINE}`);
      if (footer >= 0) prompt = prompt.slice(0, footer).trim();
    } else if (c.caseYaml?.lines.some((l) => /scaffold_script:/.test(l))) miss(sc ? sc[1] : 'case.yaml', 'scaffold script (skill-creator has no setup step; list the files it creates under files by hand)');
    for (const e of c.caseYaml?.entries ?? []) if (!['schema_version', 'name', 'context'].includes(e.key)) miss('case.yaml', `${e.key}: (no evals.json field)`);
    for (const l of c.caseYaml?.lines ?? []) { const m = l.match(/^\s+(history_file|add_dirs):/); if (m) miss('case.yaml', `context.${m[1]} (skill-creator starts every eval from a fresh prompt and its listed files)`); }
    if (existsSync(path.join(c.dir, 'covers.yaml'))) miss('covers.yaml', 'rule coverage ids (ours; no evals.json field)');
    if (existsSync(path.join(c.dir, 'mocks'))) miss('mocks/', 'MCP mocks');

    const expectations = [];
    for (const g of c.graders) {
      const m = g.meta;
      const extra = ['weight', 'arm'].filter((k) => k in m && !(k === 'arm' && m.type === 'tool_used' && m.tool === 'Skill'));
      if (m.type === 'llm') {
        const criteria = decodeScalar(g.entries.find((e) => e.key === 'criteria')) ?? bodyOf(readFileSync(g.path, 'utf8'));
        if (!criteria) { miss(g.file, 'llm grader with no criteria'); continue; }
        if (expected && criteria.trim() === expected.trim()) continue; // the expected_output grader the importer wrote
        expectations.push(criteria.trim());
        const focus = typeof m.focus === 'string' ? m.focus : m.focus == null ? 'last_message' : 'a file';
        if (!['last_message', 'files'].includes(focus) || g.entries.some((e) => e.key === 'focus' && e.raw === '')) miss(g.file, `focus ${g.entries.find((e) => e.key === 'focus')?.raw || focus} (criteria carried over; skill-creator's grader reads the whole transcript and outputs)`);
        for (const k of extra) miss(g.file, `${k}: ${m[k]} (expectations are unweighted and graded once)`);
      } else if (m.type === 'tool_used' && m.tool === 'Skill' && Number(m.min ?? 1) >= 1) {
        const name = skillFromMatch(m.input_match);
        if (name) skillsSeen.add(name);
        miss(g.file, `tool_used Skill${name ? ` (${name})` : ''}: a trigger check (skill-creator always loads the skill; ${name ? 'the name became skill_name' : 'pass --skill to set skill_name'})`);
      } else {
        const detail = m.type === 'regex' ? `regex ${m.match ?? 'contains'} /${m.pattern}/ on ${m.target ?? 'last_message'}`
          : m.type === 'tool_used' ? `tool_used ${m.tool}${m.input_match ? ` matching ${m.input_match}` : ''} (min ${m.min ?? 1}${m.max !== undefined ? `, max ${m.max}` : ''})`
            : m.type === 'tool_order' ? `tool_order ${m.before} before ${m.after}`
              : m.type === 'file_exists' ? `file_exists ${m.path}`
                : m.type === 'baseline' ? `baseline against ${m.baseline_file}` : `${m.type ?? 'untyped'} grader`;
        miss(g.file, `${detail} (a deterministic check; restate it as an expectation by hand if you need it)`);
      }
    }
    evals.push({ id: evals.length + 1, prompt, expected_output: expected ?? '', files, expectations });
  }
  const skillName = skill ?? (skillsSeen.size === 1 ? [...skillsSeen][0] : null);
  if (!skill && skillsSeen.size > 1) lost.push({ case: '(suite)', file: '-', what: `cases trigger different skills (${[...skillsSeen].join(', ')}); evals.json holds one skill_name: pass --skill` });
  return { json: { ...(skillName ? { skill_name: skillName } : {}), evals }, lost, cases: cases.length };
}
// cases under an explicit eval dir (export --eval-dir), walked the way suite-doctor walks a suite
function loadCasesAt(evalDir) {
  if (!existsSync(evalDir)) throw new Error(`no eval dir at ${evalDir}`);
  const cases = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (!e.isDirectory() || ['results', 'mocks', 'graders', 'node_modules'].includes(e.name) || e.name.startsWith('.')) continue;
      const d = path.join(dir, e.name);
      if (existsSync(path.join(d, 'prompt.md')) || existsSync(path.join(d, 'case.yaml'))) cases.push(loadCase(evalDir, d));
      else walk(d);
    }
  };
  walk(evalDir);
  return cases;
}

export function formatExportReport(res, { out = null } = {}) {
  const j = res.json;
  const lines = [`evals-convert export: ${j.evals.length} of ${res.cases} case(s) -> ${out ?? 'stdout'}${j.skill_name ? ` (skill_name ${j.skill_name})` : ' (no skill_name: pass --skill)'}`,
    `  carried over: ${j.evals.length} prompt(s), ${j.evals.reduce((n, e) => n + e.expectations.length, 0)} expectation(s), ${j.evals.filter((e) => e.expected_output).length} expected_output, ${j.evals.reduce((n, e) => n + e.files.length, 0)} input file(s)`];
  if (!res.lost.length) lines.push('  not carried over: nothing');
  else {
    lines.push(`  not carried over (${res.lost.length}; evals.json has no place for these):`);
    for (const l of res.lost) lines.push(`    ${l.case}  ${l.file}  ${l.what}`);
  }
  return lines.join('\n');
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
  const usage = [
    'usage: evals-convert.mjs import <evals.json> [--plugin <dir>] [--eval-dir <dir>] [--skill <name>] [--skill-dir <dir>] [--allowed-tools a,b] [--covers id,id] [--force] [--dry-run]',
    '       evals-convert.mjs export <plugin-dir> [--eval-dir <dir>] [--skill <name>] [--out evals.json] [--force]',
  ].join('\n');
  const fail = (msg, code = 2) => { console.error(msg ? `${msg}\n${usage}` : usage); process.exit(code); };
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '-h' || mode === '--help') { console.log(usage); process.exit(0); }
  if (!['import', 'export'].includes(mode)) fail(mode ? `unknown command ${mode}` : '');
  const opt = { force: false, dryRun: false };
  const VALUED = { '--plugin': 'plugin', '--eval-dir': 'evalDir', '--skill': 'skill', '--skill-dir': 'skillDir', '--allowed-tools': 'allowedTools', '--covers': 'covers', '--out': 'out' };
  let target = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') opt.force = true;
    else if (a === '--dry-run' && mode === 'import') opt.dryRun = true;
    else if (VALUED[a]) { if (rest[i + 1] === undefined) fail(`${a} needs a value`); opt[VALUED[a]] = rest[++i]; }
    else if (!a.startsWith('--') && !target) target = a;
    else fail(`unknown option ${a}`);
  }
  if (!target) fail('');
  const csv = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

  if (mode === 'import') {
    let data;
    try { data = JSON.parse(readFileSync(target, 'utf8')); } catch (e) { fail(`cannot read ${target}: ${e.message}`); }
    const found = opt.plugin ?? findPluginRoot(path.dirname(path.resolve(target)));
    if (!found) fail(`no plugin found above ${target}: pass --plugin <dir>`);
    const pluginDir = path.resolve(found);
    const jsonDir = path.dirname(path.resolve(target));
    const skillDir = path.resolve(opt.skillDir ?? (path.basename(jsonDir) === 'evals' ? path.dirname(jsonDir) : jsonDir));
    const allowedTools = opt.allowedTools !== undefined ? csv(opt.allowedTools) : DEFAULT_ALLOWED_TOOLS;
    let plan;
    try {
      plan = planImport(data, { pluginDir, evalDir: opt.evalDir ? path.resolve(opt.evalDir) : resolveEvalDir(pluginDir), skillDir, skill: opt.skill ?? null, allowedTools, covers: opt.covers ? csv(opt.covers) : null });
    } catch (e) { fail(`evals-convert: ${e.message}`); }
    console.log(formatImportPlan(plan, { dryRun: opt.dryRun, force: opt.force, allowedTools }));
    const blocked = plan.errors.length || (plan.cases.some((c) => c.exists) && !opt.force);
    if (opt.dryRun) process.exit(blocked ? 1 : 0);
    const res = applyImport(plan, { force: opt.force });
    if (res.refused.length) { console.log('refused: nothing written.'); process.exit(1); }
    console.log(`wrote ${res.written.length} case(s). Check them with: node tools/suite-doctor.mjs ${displayPath(pluginDir)}`);
    process.exit(0);
  }

  let res;
  try { res = exportSuite(target, { evalDir: opt.evalDir ?? null, skill: opt.skill ?? null }); } catch (e) { fail(`evals-convert: ${e.message}`); }
  const text = JSON.stringify(res.json, null, 2) + '\n';
  if (opt.out) {
    if (existsSync(opt.out) && !opt.force) { console.error(formatExportReport(res, { out: opt.out })); console.error(`refused: ${opt.out} exists (use --force to replace it)`); process.exit(1); }
    writeFileSync(opt.out, text);
  } else process.stdout.write(text);
  console.error(formatExportReport(res, { out: opt.out }));
  process.exit(0);
}
