#!/usr/bin/env node
// config-coverage — which rules in your agent setup have an eval case, and which are untested.
//
//   node tools/config-coverage.mjs <plugin-dir> [--eval-dir evals] [--claude-md <path>] [--json out] [--md out] [--badge out.svg] [--list]
//
// Rules are the bullets in CLAUDE.md and every skill's SKILL.md (outside code fences), plus one rule per
// hook event/matcher. A case claims rules with `covers: [id, …]` in its prompt.md frontmatter.
// `--list` prints every rule id with its text so you can paste ids into `covers:`.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

export const slug = (s) => s.toLowerCase().replace(/`[^`]*`/g, (m) => m.slice(1, -1)).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const STOP = new Set(['a', 'an', 'the', 'in', 'of', 'to', 'on', 'is', 'are', 'for', 'and', 'or', 'with', 'by', 'at', 'as', 'be', 'it', 'its']);
const words = (s, n) => { const w = slug(s).split('-').filter(Boolean).slice(0, n); while (w.length > 3 && STOP.has(w.at(-1))) w.pop(); return w.join('-'); };

// Pull rules out of a markdown file: bullets and numbered items, with their heading, skipping code fences.
export function rulesFromMarkdown(text, scope, source) {
  const out = []; let heading = null, fence = false;
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) start = end + 1; } // frontmatter
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const h = l.match(/^#{1,6}\s+(.*)$/); if (h) { heading = h[1].trim(); continue; }
    const b = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/); if (!b) continue;
    let textLine = b[1].trim();
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i + 1]) && !/^\s*(```|~~~)/.test(lines[i + 1])) textLine += ' ' + lines[++i].trim(); // wrapped bullet
    if (textLine.split(/\s+/).length < 3) continue; // a bare link or a one-word list item is not a rule
    out.push({ scope, source, line: i + 1, heading, text: textLine });
  }
  return out;
}
export function rulesFromHooks(hooks, source) {
  const out = [];
  for (const [event, entries] of Object.entries(hooks?.hooks ?? hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const matcher = e.matcher ?? '*';
      const cmds = (e.hooks ?? []).map((h) => h.command ?? h.type).filter(Boolean).join('; ');
      out.push({ scope: 'hook', source, line: null, heading: event, text: `${event} on ${matcher}${cmds ? ` → ${cmds}` : ''}`, idHint: `${slug(event)}-${slug(matcher) || 'all'}` });
    }
  }
  return out;
}
export function assignIds(rules) {
  const seen = new Map();
  for (const r of rules) {
    const base = `${r.scope}/${r.idHint ?? words(r.text, 6)}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    r.id = n === 1 ? base : `${base}-${n}`;
  }
  return rules;
}

async function readIf(p) { return existsSync(p) ? fs.readFile(p, 'utf8') : null; }
async function findSkillFiles(dir, acc = [], depth = 0) {
  if (depth > 6) return acc;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (['node_modules', '.git', 'results', 'evals', 'target', 'dist'].includes(e.name)) continue; await findSkillFiles(path.join(dir, e.name), acc, depth + 1); }
    else if (e.name === 'SKILL.md') acc.push(path.join(dir, e.name));
  }
  return acc;
}
function parseCovers(frontmatter) {
  const m = frontmatter.match(/^covers:\s*(.*)$/m); if (!m) return [];
  const v = m[1].trim();
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export async function coverage(pluginDir, { evalDir = null, claudeMd = null } = {}) {
  const manifestPath = path.join(pluginDir, '.claude-plugin/plugin.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(await fs.readFile(manifestPath, 'utf8')) : {};
  const rules = [];
  const cm = claudeMd ?? path.join(pluginDir, 'CLAUDE.md');
  const cmText = await readIf(cm);
  if (cmText) rules.push(...rulesFromMarkdown(cmText, 'claude-md', path.relative(pluginDir, cm) || 'CLAUDE.md'));
  const skillFiles = new Set();
  for (const s of manifest.skills ?? []) { const p = path.join(pluginDir, s, 'SKILL.md'); if (existsSync(p)) skillFiles.add(p); }
  for (const p of await findSkillFiles(pluginDir)) skillFiles.add(p);
  for (const p of [...skillFiles].sort()) {
    const t = await fs.readFile(p, 'utf8');
    const name = (t.match(/^---[\s\S]*?^name:\s*(.+)$/m) ?? [])[1]?.trim() ?? path.basename(path.dirname(p));
    rules.push(...rulesFromMarkdown(t, `skill/${slug(name)}`, path.relative(pluginDir, p)));
  }
  const hooksRef = manifest.hooks;
  if (hooksRef) {
    const hooksObj = typeof hooksRef === 'string' ? JSON.parse((await readIf(path.join(pluginDir, hooksRef))) ?? '{}') : hooksRef;
    rules.push(...rulesFromHooks(hooksObj, typeof hooksRef === 'string' ? hooksRef : 'plugin.json#hooks'));
  }
  assignIds(rules);
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const r of rules) r.cases = [];
  const cases = []; const unknown = [];
  const ed = path.join(pluginDir, evalDir ?? manifest.experimental?.evals ?? 'evals');
  if (existsSync(ed)) for (const e of (await fs.readdir(ed, { withFileTypes: true })).filter((x) => x.isDirectory() && !['results', 'mocks'].includes(x.name))) {
    const t = await readIf(path.join(ed, e.name, 'prompt.md')); if (!t) continue;
    const fm = (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? '';
    const covers = parseCovers(fm);
    cases.push({ dir: e.name, covers });
    for (const id of covers) { const r = byId.get(id); if (r) r.cases.push(e.name); else unknown.push({ case: e.name, id }); }
  }
  const covered = rules.filter((r) => r.cases.length);
  return { schemaVersion: 1, pluginDir: path.basename(pluginDir), total: rules.length, covered: covered.length, pct: rules.length ? Math.round((covered.length / rules.length) * 100) : null, rules, uncovered: rules.filter((r) => !r.cases.length).map((r) => r.id), unknownCovers: unknown, cases };
}

export function badgeSvg(pct, label = 'agent-config coverage') {
  const value = pct === null ? 'no rules' : `${pct}%`;
  const color = pct === null ? '#9f9f9f' : pct >= 80 ? '#3fb950' : pct >= 50 ? '#d29922' : '#f85149';
  const lw = 6 + label.length * 6.3, vw = 10 + value.length * 6.6, w = Math.round(lw + vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}"><title>${label}: ${value}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient><rect rx="3" width="${w}" height="20" fill="#555"/><rect rx="3" x="${lw.toFixed(1)}" width="${vw.toFixed(1)}" height="20" fill="${color}"/><rect rx="3" width="${w}" height="20" fill="url(#s)"/><g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11"><text x="${(lw / 2).toFixed(1)}" y="14" fill="#010101" fill-opacity=".3">${label}</text><text x="${(lw / 2).toFixed(1)}" y="13">${label}</text><text x="${(lw + vw / 2).toFixed(1)}" y="14" fill="#010101" fill-opacity=".3">${value}</text><text x="${(lw + vw / 2).toFixed(1)}" y="13">${value}</text></g></svg>`;
}

export function markdown(c) {
  const lines = [`### Agent-config coverage: ${c.pct === null ? 'no rules found' : `**${c.pct}%** (${c.covered} of ${c.total} rules have a case)`}`];
  if (c.uncovered.length) {
    lines.push('', '| untested rule | where |', '|---|---|');
    for (const id of c.uncovered) { const r = c.rules.find((x) => x.id === id); lines.push(`| \`${id}\` — ${r.text.length > 90 ? r.text.slice(0, 87) + '…' : r.text} | ${r.source}${r.line ? `:${r.line}` : ''} |`); }
    lines.push('', `Add \`covers: [${c.uncovered[0]}]\` to a case's prompt.md, or generate one with \`/config-drift-checker:write-case\`.`);
  }
  if (c.unknownCovers.length) lines.push('', `⚠ unknown ids in \`covers:\` — ${c.unknownCovers.map((u) => `${u.case}: \`${u.id}\``).join(', ')} (run \`config-coverage.mjs --list\` for valid ids)`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = { evalDir: null, claudeMd: null, json: null, md: null, badge: null, list: false };
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--eval-dir') opt.evalDir = argv[++i]; else if (a === '--claude-md') opt.claudeMd = path.resolve(argv[++i]);
    else if (a === '--json') opt.json = argv[++i]; else if (a === '--md') opt.md = argv[++i]; else if (a === '--badge') opt.badge = argv[++i];
    else if (a === '--list') opt.list = true; else if (!a.startsWith('--')) dir = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  if (!dir) { console.error('usage: config-coverage.mjs <plugin-dir> [--eval-dir d] [--claude-md f] [--json out] [--md out] [--badge out.svg] [--list]'); process.exit(2); }
  const c = await coverage(dir, opt);
  if (opt.list) { for (const r of c.rules) console.log(`${r.cases.length ? '✓' : '·'} ${r.id}\n    ${r.text}${r.cases.length ? `  [${r.cases.join(', ')}]` : ''}`); }
  else console.log(markdown(c));
  if (opt.json) await fs.writeFile(opt.json, JSON.stringify(c, null, 2) + '\n');
  if (opt.md) await fs.writeFile(opt.md, markdown(c) + '\n');
  if (opt.badge) await fs.writeFile(opt.badge, badgeSvg(c.pct));
}
