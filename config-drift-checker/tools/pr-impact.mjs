#!/usr/bin/env node
// pr-impact: what a pull request does to your agent setup, worked out from git alone (no model runs).
//
//   node tools/pr-impact.mjs --base <git-ref> [--head <git-ref>] --plugin <dir> [--repo <dir>] [--runner <claude>]
//        [--md <out>|-] [--json <out>|-]
//
// For a PR that touches agent-config files (CLAUDE.md, skills, hooks and their scripts, agents,
// commands, .mcp.json, the plugin manifest), it reads the plugin dir at the merge base and at head
// straight from git objects into two temp dirs and reports:
//   1. context cost: the always-on and on-invoke tokens per component, before and after
//      (context-cost.mjs; the static estimate, or `claude plugin details` when --runner is given);
//   2. which rules changed (config-coverage.mjs rule ids, edited, added or removed) and which eval
//      cases cover them: the minimal case selection, printed as a `--case` glob;
//   3. changed rules no case tests, and covers.yaml ids the PR left pointing at a renamed rule.
// The glob uses only `*`, the one wildcard both runners' --case accept (the official runner's has
// no {a,b} alternation). When no single pattern names exactly the selected cases, it is the
// narrowest one that covers them all, and the extra cases it also matches are listed.
// Symlinks and submodules in the tree are skipped, never followed, so a PR cannot make this tool
// read files outside the repository into its comment.
// Exit 0 on success, 2 on a usage or git error.
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, diffComponents, change, fmtPct } from './context-cost.mjs';
import { coverage } from './config-coverage.mjs';

export const MARKER = '<!-- cdc-pr-impact -->';

// ---------- git ----------
function git(repo, args, { input, buffer = false } = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { input, ...(buffer ? {} : { encoding: 'utf8' }), maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr ?? r.error?.message ?? '').trim().split('\n')[0]}`);
  return r.stdout;
}
const commit = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();

// Write the tree of `ref` under `rel` into `dest`, from git objects: no checkout, no index, no hooks.
export function materialize(repo, ref, rel, dest) {
  mkdirSync(dest, { recursive: true });
  const ls = git(repo, ['ls-tree', '-r', '-z', '--full-tree', ref, ...(rel ? ['--', rel] : [])]);
  const blobs = [], skipped = [];
  for (const entry of ls.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, type, sha] = entry.slice(0, tab).split(' '), p = entry.slice(tab + 1);
    const inside = rel ? path.posix.relative(rel, p) : p;
    if (!inside || inside.startsWith('..')) continue;
    if (type !== 'blob' || mode === '120000') { skipped.push(inside); continue; } // submodule or symlink: never followed
    blobs.push({ sha, inside });
  }
  if (!blobs.length) return { files: 0, skipped };
  const out = git(repo, ['cat-file', '--batch'], { input: blobs.map((b) => b.sha).join('\n') + '\n', buffer: true });
  let pos = 0;
  const root = path.resolve(dest);
  for (const b of blobs) {
    const nl = out.indexOf(10, pos), header = out.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]), body = out.subarray(pos, pos + size);
    pos += size + 1;
    const target = path.resolve(root, b.inside);
    if (!target.startsWith(root + path.sep)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return { files: blobs.length, skipped };
}

// name-status between two commits under `rel`, paths relative to the plugin dir
export function changedFiles(repo, base, head, rel) {
  const out = git(repo, ['diff', '--name-status', '-z', '-M', base, head, ...(rel ? ['--', rel] : [])]).split('\0');
  const files = [];
  for (let i = 0; i < out.length - 1;) {
    const status = out[i++];
    if (!status) continue;
    const from = /^[RC]/.test(status) ? out[i++] : null, to = out[i++];
    const strip = (p) => (p && rel ? path.posix.relative(rel, p) : p);
    files.push({ status: status[0], path: strip(to), ...(from ? { from: strip(from) } : {}) });
  }
  return files;
}

// ---------- what counts as agent config ----------
const CONFIG_NAMES = new Set(['CLAUDE.md', 'SKILL.md', '.mcp.json', 'hooks.json', 'plugin.json', 'settings.json']);
const CONFIG_DIRS = new Set(['skills', 'agents', 'commands', 'hooks', '.claude-plugin']);
export function kindOf(p, { evalDir = 'evals', hookTexts = [] } = {}) {
  const seg = p.split('/');
  if (seg[0] === evalDir) return seg.length > 2 && !['results', 'mocks'].includes(seg[1]) ? 'case' : 'eval';
  if (CONFIG_NAMES.has(seg.at(-1)) || seg.slice(0, -1).some((s) => CONFIG_DIRS.has(s))) return 'config';
  if (hookTexts.some((t) => t.includes(p))) return 'hook-script';
  return 'other';
}

// ---------- rules: which changed ----------
const wordSet = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []);
const similarity = (a, b) => { const x = wordSet(a), y = wordSet(b); const both = [...x].filter((w) => y.has(w)).length; return both / (x.size + y.size - both || 1); };

// Pairs base and head rules: identical text first (unchanged, even if the id moved), then the same id
// (edited), then the closest text in the same file and heading (edited, id renamed), then added/removed.
export function diffRules(before, after) {
  const left = new Set(before), right = new Set(after), out = [];
  const take = (a, b, kind) => { left.delete(a); right.delete(b); if (kind) out.push({ change: kind, id: b.id, ...(a.id !== b.id ? { was: a.id } : {}), scope: b.scope, source: b.source, text: b.text, before: a.text, base: a, head: b }); };
  for (const a of [...left]) { const b = [...right].find((r) => r.scope === a.scope && r.text === a.text); if (b) take(a, b, a.id !== b.id ? 'moved' : null); }
  for (const a of [...left]) { const b = [...right].find((r) => r.id === a.id); if (b) take(a, b, 'edited'); }
  const pairs = [];
  for (const a of left) for (const b of right) if (a.scope === b.scope && a.source === b.source && a.heading === b.heading) { const s = similarity(a.text, b.text); if (s >= 0.5) pairs.push([s, a, b]); }
  for (const [, a, b] of pairs.sort((p, q) => q[0] - p[0])) if (left.has(a) && right.has(b)) take(a, b, 'edited');
  for (const a of left) out.push({ change: 'removed', id: a.id, scope: a.scope, source: a.source, text: a.text, base: a, head: null });
  for (const b of right) out.push({ change: 'added', id: b.id, scope: b.scope, source: b.source, text: b.text, base: null, head: b });
  return out;
}

// ---------- the narrowest single-wildcard glob ----------
const lcp = (xs) => xs.reduce((p, x) => { let i = 0; while (i < p.length && p[i] === x[i]) i++; return p.slice(0, i); });
const lcs = (xs) => [...lcp(xs.map((x) => [...x].reverse().join('')))].reverse().join('');
const matches = (glob, name) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name);
export function globFor(selected, all) {
  if (!selected.length) return { glob: null, exact: true, alsoMatches: [] };
  if (selected.length === 1) return { glob: selected[0], exact: true, alsoMatches: [] };
  const pre = lcp(selected), suf = lcs(selected.map((x) => x.slice(pre.length)));
  const glob = `${pre}*${suf}`;
  const alsoMatches = all.filter((n) => !selected.includes(n) && matches(glob, n));
  return { glob, exact: !alsoMatches.length, alsoMatches };
}

// ---------- the whole analysis ----------
const caseDirs = (dir, evalDir) => { const d = path.join(dir, evalDir); return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !['results', 'mocks'].includes(e.name) && (existsSync(path.join(d, e.name, 'prompt.md')) || existsSync(path.join(d, e.name, 'case.yaml')))).map((e) => e.name).sort() : []; };
const evalDirOf = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')).experimental?.evals ?? 'evals'; } catch { return 'evals'; } };

export async function prImpact({ repo = process.cwd(), base, head = 'HEAD', plugin, runner = null }) {
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const abs = path.resolve(repo, plugin);
  const rel = path.relative(top, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new Error(`--plugin ${plugin} is outside the repository ${top}`);
  const headSha = commit(top, head), tipSha = commit(top, base);
  let baseSha = tipSha, mergeBase = false;
  try { baseSha = git(top, ['merge-base', tipSha, headSha]).trim(); mergeBase = true; } catch { /* shallow clone: compare with the base tip */ }
  const work = mkdtempSync(path.join(os.tmpdir(), 'pr-impact-'));
  try {
    const dirs = { base: path.join(work, 'base'), head: path.join(work, 'head') };
    const trees = { base: materialize(top, baseSha, rel, dirs.base), head: materialize(top, headSha, rel, dirs.head) };
    const evalDir = evalDirOf(dirs.head);

    // 1. context cost, before and after
    const m = { base: measure(dirs.base, { runner, official: !!runner }), head: measure(dirs.head, { runner, official: !!runner }) };
    const cost = {
      source: m.head.source, comparable: m.base.source === m.head.source,
      reasons: [...new Set([m.base, m.head].filter((x) => x.source === 'estimate' && runner).map((x) => x.official.reason))],
      alwaysOn: change(m.base.totals.alwaysOn, m.head.totals.alwaysOn), onInvoke: change(m.base.totals.onInvoke, m.head.totals.onInvoke),
      components: diffComponents(m.base.components, m.head.components),
    };
    cost.headline = costHeadline(cost);

    // 2. rules and the cases that cover them
    const cov = { base: await coverage(dirs.base, {}), head: await coverage(dirs.head, {}) };
    const hookTexts = [...cov.base.rules, ...cov.head.rules].filter((r) => r.scope === 'hook').map((r) => r.text);
    const files = changedFiles(top, baseSha, headSha, rel).map((f) => ({ ...f, kind: kindOf(f.path, { evalDir, hookTexts }) }));
    const rules = diffRules(cov.base.rules, cov.head.rules);
    // a hook's script changed while its command line did not: the hook rule changed all the same
    for (const f of files.filter((x) => x.kind === 'hook-script')) {
      for (const r of cov.head.rules.filter((x) => x.scope === 'hook' && x.text.includes(f.path))) {
        const hit = rules.find((x) => x.id === r.id);
        if (hit) (hit.why ??= []).push(`its script ${f.path} changed`);
        else { const b = cov.base.rules.find((x) => x.id === r.id) ?? null; rules.push({ change: 'edited', id: r.id, scope: r.scope, source: r.source, text: r.text, before: b?.text ?? null, base: b, head: r, why: [`its script ${f.path} changed`] }); }
      }
    }
    const reasons = new Map(); // case -> [why]
    const because = (c, why) => { if (!reasons.has(c)) reasons.set(c, []); if (!reasons.get(c).includes(why)) reasons.get(c).push(why); };
    const changed = rules.filter((r) => r.change !== 'moved').map((r) => {
      const cases = [...new Set([...(r.head?.cases ?? []), ...(r.change === 'removed' || r.was ? r.base?.cases ?? [] : [])])].sort();
      for (const c of cases) because(c, `covers \`${r.was && !(r.head?.cases ?? []).includes(c) ? r.was : r.id}\` (${r.change})`);
      const { base: _b, head: _h, ...rest } = r;
      return { ...rest, cases };
    });
    // A config file changed outside its bullets (a skill description, prose), or a bullet no case tests:
    // the cases of the file's other rules are the nearest evidence, so they run.
    const uncovered = changed.filter((r) => r.change !== 'removed' && !r.cases.length).map((r) => ({ kind: 'rule', id: r.id, change: r.change, source: r.source }));
    for (const f of files.filter((x) => x.kind === 'config')) {
      const own = changed.filter((r) => r.source === f.path);
      const untested = uncovered.filter((u) => u.source === f.path);
      if (own.length && !untested.length) continue;
      const fileRules = [...cov.head.rules, ...cov.base.rules].filter((r) => r.source === f.path || r.source === f.from);
      const cases = [...new Set(fileRules.flatMap((r) => r.cases))].sort();
      for (const c of cases) because(c, untested.length ? `nearest case: covers another rule in \`${f.path}\`, where an untested rule changed` : `covers a rule in \`${f.path}\`, which changed outside its rules`);
      if (own.length) continue;
      const modelled = /(^|\/)(CLAUDE\.md|SKILL\.md)$/.test(f.path) || /(^|\/)(agents|commands)\/[^/]+\.md$/.test(f.path);
      if (!cases.length && modelled && f.status !== 'D') uncovered.push({ kind: 'file', file: f.path, change: f.status === 'A' ? 'added' : 'edited' });
    }
    // a case whose own files changed runs too, unless the PR deleted it
    const headCases = caseDirs(dirs.head, evalDir);
    for (const f of files.filter((x) => x.kind === 'case')) { const c = f.path.split('/')[1]; if (headCases.includes(c)) because(c, 'its own files changed'); }
    // covers.yaml ids this PR left dangling
    const renamed = new Map(changed.filter((r) => r.was).map((r) => [r.was, r.id]));
    const knownBefore = new Set(cov.base.unknownCovers.map((u) => `${u.case}\0${u.id}`));
    const staleCovers = cov.head.unknownCovers.filter((u) => !knownBefore.has(`${u.case}\0${u.id}`)).map((u) => ({ ...u, renamedTo: renamed.get(u.id) ?? null }));

    const touched = files.some((f) => ['config', 'hook-script', 'case'].includes(f.kind));
    const cases = [...reasons.keys()].filter((c) => headCases.includes(c)).sort();
    const g = globFor(cases, headCases);
    const selection = !touched ? 'none' : cases.length ? 'cases' : 'all';
    return {
      schemaVersion: 1, tool: 'pr-impact', plugin: rel || '.', evalDir,
      base: { ref: base, sha: baseSha, tip: tipSha, mergeBase }, head: { ref: head, sha: headSha },
      touched, selection, cases, reasons: Object.fromEntries(cases.map((c) => [c, reasons.get(c)])),
      glob: selection === 'cases' ? g.glob : null, globExact: g.exact, globAlsoMatches: g.alsoMatches,
      braceGlob: cases.length > 1 ? `{${cases.join(',')}}` : cases[0] ?? null,
      files, contextCost: cost, rules: { changed, counts: countBy(changed.map((r) => r.change)) }, uncovered, staleCovers,
      skipped: [...new Set([...trees.base.skipped, ...trees.head.skipped])],
      coverage: { before: cov.base.pct, after: cov.head.pct },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const countBy = (xs) => xs.reduce((o, x) => ({ ...o, [x]: (o[x] ?? 0) + 1 }), {});

// ---------- words ----------
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${num(Math.abs(n))}`;
export function costHeadline(c) {
  const d = c.alwaysOn.delta, pct = c.alwaysOn.before ? ` (${fmtPct(c.alwaysOn.pct)})` : '';
  const main = d > 0 ? `This PR adds ${num(d)} always-on tokens to every session${pct}`
    : d < 0 ? `This PR removes ${num(-d)} always-on tokens from every session${pct}`
    : `This PR does not change the always-on tokens (${num(c.alwaysOn.after)} per session)`;
  const inv = c.onInvoke.delta ? `; ${signed(c.onInvoke.delta)} on-invoke tokens across components when each fires` : '';
  return `${main}${inv}.`;
}
const SOURCE = { official: 'official, from `claude plugin details`', estimate: 'estimate, characters / 4' };
const cell = (ch) => (ch.before === ch.after ? num(ch.after) : `${num(ch.before)} to ${num(ch.after)} (${signed(ch.delta)})`);
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

export function markdown(r) {
  const out = [MARKER, '### Agent-config impact of this PR', ''];
  if (!r.touched) {
    out.push('This PR touches no agent-config files (CLAUDE.md, skills, hooks, agents, commands, .mcp.json), so no eval case needs to run for it.');
    return out.join('\n') + '\n';
  }
  const c = r.contextCost;
  out.push(`**${c.headline}** Always-on: ${num(c.alwaysOn.before)} to ${num(c.alwaysOn.after)} tokens. Source: ${SOURCE[c.source]}${c.comparable ? '' : ' (base and head were measured differently, so compare with care)'}.`);
  if (c.reasons.length) out.push('', `> official figure unavailable: ${c.reasons.join('; ')}`);
  if (c.components.length) {
    out.push('', '| component | kind | always-on | on-invoke |', '|---|---|---:|---:|');
    for (const mv of c.components) out.push(`| ${esc(mv.name)}${mv.status === 'changed' ? '' : ` (${mv.status})`} | ${mv.kind} | ${cell(mv.alwaysOn)} | ${cell(mv.onInvoke)} |`);
  }
  const ch = r.rules.changed;
  out.push('', ch.length ? `**Rules changed: ${ch.length}** (${Object.entries(r.rules.counts).map(([k, n]) => `${n} ${k}`).join(', ')})` : '**Rules changed: none** (the edits are outside the rule bullets)');
  if (ch.length) {
    out.push('', '| rule | change | tested by |', '|---|---|---|');
    for (const x of ch) out.push(`| ${code(x.id)}<br><sub>${esc(clip(x.text))}</sub> | ${x.change}${x.was ? `, id was ${code(x.was)}` : ''}${x.why ? `, ${x.why.join(', ')}` : ''} | ${x.cases.length ? x.cases.map(code).join(', ') : 'no case'} |`);
  }
  out.push('');
  if (r.selection === 'cases') {
    out.push(`**Cases to run: ${r.cases.length}**, \`--case '${r.glob}'\`${r.globExact ? (r.cases.length > 1 ? ' (matches exactly these)' : '') : ` (one pattern also matches ${r.globAlsoMatches.map(code).join(', ')}: the runners' --case takes a single \`*\` pattern)`}`, '');
    for (const k of r.cases) out.push(`- ${code(k)}: ${r.reasons[k].join('; ')}`);
  } else out.push('**Cases to run: the full suite.** Agent config changed, but no case covers what changed, so no smaller selection applies.');
  if (r.uncovered.length) {
    out.push('', '**Not tested by any case:**', '');
    for (const u of r.uncovered) out.push(u.kind === 'rule' ? `- rule ${code(u.id)} ${u.change === 'added' ? 'was added' : 'changed'} and no case tests it (${u.source})` : `- ${code(u.file)} ${u.change === 'added' ? 'was added' : 'changed'} and no case tests it`);
    out.push('', `Add the id to a case's \`covers.yaml\` (ids: \`config-coverage.mjs --list\`), or write a case with \`/config-drift-checker:write-case\`.`);
  }
  if (r.staleCovers.length) {
    out.push('', '**covers.yaml left behind:**', '');
    for (const s of r.staleCovers) out.push(`- ${code(s.case)} names ${code(s.id)}, ${s.renamedTo ? `which this PR renamed to ${code(s.renamedTo)}` : 'which no longer exists'}: update its covers.yaml`);
  }
  out.push('', `<sub>Compared ${r.base.mergeBase ? 'the merge base' : 'the base tip'} ${r.base.sha.slice(0, 7)} with ${r.head.sha.slice(0, 7)} under \`${r.plugin}\`, from git alone, no model runs. Coverage ${r.coverage.before ?? 'n/a'}% to ${r.coverage.after ?? 'n/a'}%.${r.skipped.length ? ` Skipped (symlinks or submodules, never followed): ${r.skipped.map(code).join(', ')}.` : ''}</sub>`);
  return out.join('\n') + '\n';
}

// ---------- CLI ----------
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = 'usage: pr-impact.mjs --base <git-ref> [--head <git-ref>] --plugin <dir> [--repo <dir>] [--runner <claude>] [--md <out>|-] [--json <out>|-]';
  const argv = process.argv.slice(2), opt = { base: null, head: 'HEAD', plugin: null, repo: process.cwd(), runner: null, md: null, json: null };
  const VALUE = { '--base': 'base', '--head': 'head', '--plugin': 'plugin', '--repo': 'repo', '--runner': 'runner', '--md': 'md', '--json': 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE[a]) { const v = argv[++i]; if (v === undefined || (v.startsWith('--') && v !== '-')) { console.error(usage); process.exit(2); } opt[VALUE[a]] = v; }
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  if (!opt.base || !opt.plugin) { console.error(usage); process.exit(2); }
  let r;
  try { r = await prImpact(opt); } catch (e) { console.error(`pr-impact: ${e.message}`); process.exit(2); }
  const md = markdown(r);
  const emit = async (target, text) => { if (target === '-') process.stdout.write(text); else await fs.writeFile(target, text); };
  if (opt.md !== '-' && opt.json !== '-') process.stdout.write(md);
  if (opt.md) await emit(opt.md, md);
  if (opt.json) await emit(opt.json, JSON.stringify(r, null, 2) + '\n');
}
