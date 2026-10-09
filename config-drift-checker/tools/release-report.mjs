#!/usr/bin/env node
// release-report: which public plugin eval suites still load on a new Claude Code release?
//
//   node tools/release-report.mjs [--version <new>] [--previous <old>] [--suites suites.yml] [--discover]
//        [--opt-out opt-out.txt] [--out-dir docs/release-report] [--runner <version>=<claude or npm prefix>]
//        [--work-dir <dir>] [--max-suites 40] [--max-repo-mb 200]
//
// For each suite (an explicit list, plus GitHub code search with --discover, plus every suite the last
// report covered) it makes a shallow clone and asks the official runner to LOAD the suite under both
// versions: `claude plugin eval <dir> --max-cost-usd 0 --trust-plugin --no-publish`, whose cost ceiling
// stops the run before the first agent starts. The runner gets a bare environment (PATH and an empty
// HOME, nothing else), so no credential exists to spend with and no token leaks in. Static checks come
// from suite-doctor. Nothing from the cloned repo is installed or executed: no --scaffold, no npm.
//
// Each case is classified: loads | broke (loaded on --previous, fails on --version) | never-loaded
// (fails on both) | fixed (fails on --previous, loads on --version) | fails (fails, previous unchecked)
// | unchecked (the new version's load check did not complete).
//
// Writes <out-dir>/report.json, <out-dir>/index.html and <out-dir>/archive/<version>.json.
// Defaults: --version is npm latest, --previous the release before it. A --runner <version>=<path>
// reuses an installed binary (a claude executable, or an npm prefix holding node_modules/.bin/claude);
// otherwise each version is installed into a temp npm prefix, never globally.
//
// The opt-out list (one owner/repo per line, # comments) is honoured for every source, always.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSuite, diagnose, parseRunnerOutput, resolveEvalDir } from './suite-doctor.mjs';

const PACKAGE = '@anthropic-ai/claude-code';
const REPO_URL = 'https://github.com/jameskomo/config-drift-checker';
export const DISCOVERY_QUERIES = ['filename:prompt.md path:evals graders'];
export const STATUSES = ['loads', 'broke', 'fixed', 'never-loaded', 'fails', 'unchecked'];
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/; // GitHub owner / repo name, never . or ..
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

// ---------- versions ----------
export const cmpV = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
};
// the stable release published right before `version`
export function previousVersion(all, version) {
  return all.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && cmpV(v, version) < 0).sort(cmpV).at(-1) ?? null;
}

// ---------- suite lists ----------
// suites.yml: a YAML list of { repo, path, ref }; JSON arrays work too.
export function parseSuitesFile(text) {
  const t = text.trim();
  if (t.startsWith('[')) return JSON.parse(t);
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^(\s*-\s+|\s+)([A-Za-z_]+):\s*(.*?)\s*$/);
    if (!m) throw new Error(`suites file: cannot read line "${raw.trim()}"`);
    if (/-/.test(m[1])) out.push({});
    if (!out.length) throw new Error('suites file: expected a list (- repo: owner/name)');
    out.at(-1)[m[2]] = m[3].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
export function parseOptOut(text) {
  return new Set(text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean));
}
// The plugin dir a code-search hit belongs to: everything before the first `evals` path segment.
export function pluginDirFromPath(p) {
  const parts = p.split('/');
  const i = parts.indexOf('evals');
  return i < 0 ? null : parts.slice(0, i).join('/') || '.';
}
// Validate and normalise one suite entry; returns null (with a reason) when it is unusable.
export function normaliseSuite(s, source) {
  const repo = String(s.repo ?? '').trim();
  const p = String(s.path ?? '.').trim().replace(/^\.\/|\/$/g, '') || '.';
  const ref = s.ref ? String(s.ref).trim() : null;
  if (!REPO_RE.test(repo)) return { error: `not an owner/name repo: ${repo || '(empty)'}` };
  if (p.split('/').some((seg) => seg === '..') || path.isAbsolute(p)) return { error: `${repo}: path must stay inside the repo: ${p}` };
  if (ref && !REF_RE.test(ref)) return { error: `${repo}: not a branch or tag name: ${ref}` };
  return { repo, path: p, ref, source };
}
export function mergeSuites(lists, optOut) {
  const seen = new Map();
  for (const s of lists.flat()) {
    if (!s || s.error) continue;
    if (optOut.has(s.repo.toLowerCase())) continue;
    const k = `${s.repo.toLowerCase()}:${s.path}`;
    if (!seen.has(k)) seen.set(k, s);
    else if (s.source === 'list') seen.set(k, { ...seen.get(k), ...s }); // the explicit list wins (ref)
  }
  return [...seen.values()];
}

// ---------- GitHub (code search and repo metadata) ----------
// With GITHUB_TOKEN or GH_TOKEN: fetch against CDC_GITHUB_API (default api.github.com). Otherwise the gh CLI.
export async function githubApi(endpoint, { env = process.env } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const base = (env.CDC_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  if (token || env.CDC_GITHUB_API) {
    const res = await fetch(`${base}/${endpoint}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'config-drift-checker-release-report', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub API ${endpoint.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }
  const r = spawnSync('gh', ['api', '-X', 'GET', endpoint], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`gh api ${endpoint.split('?')[0]}: ${(r.stderr || r.error?.message || 'failed').trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}
export async function discover(api = githubApi) {
  const found = [];
  for (const q of DISCOVERY_QUERIES) {
    const j = await api(`search/code?q=${encodeURIComponent(q)}&per_page=100`);
    for (const item of j.items ?? []) {
      const dir = pluginDirFromPath(item.path ?? '');
      const repo = item.repository?.full_name;
      if (dir && repo) found.push(normaliseSuite({ repo, path: dir }, 'discovered'));
    }
  }
  return found;
}

// ---------- clone (shallow, no submodules, no LFS, no hooks, size cap, timeout) ----------
function dirBytes(dir) {
  let n = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.isSymbolicLink()) n += statSync(p).size; } };
  walk(dir);
  return n;
}
export function shallowClone({ repo, ref }, dest, { cloneBase = 'https://github.com/', timeoutMs = 120_000, maxBytes = 200 * 2 ** 20 } = {}) {
  const env = { PATH: process.env.PATH, HOME: path.dirname(dest), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
    'clone', '--quiet', '--depth', '1', '--single-branch', '--no-recurse-submodules', ...(ref ? ['--branch', ref] : []), '--', `${cloneBase}${repo}.git`, dest];
  const r = spawnSync('git', args, { encoding: 'utf8', env, timeout: timeoutMs });
  if (r.status !== 0) return { ok: false, reason: r.error?.code === 'ETIMEDOUT' ? `clone timed out after ${timeoutMs / 1000}s` : `clone failed: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}` };
  const bytes = dirBytes(dest);
  if (bytes > maxBytes) return { ok: false, reason: `the checkout is ${(bytes / 2 ** 20).toFixed(0)} MB, over the ${(maxBytes / 2 ** 20).toFixed(0)} MB cap` };
  const commit = spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8', env }).stdout?.trim() || null;
  return { ok: true, commit };
}

// ---------- the $0 load check, in a bare environment ----------
export function runnerEnv(claudePath, home) {
  // env -i: PATH (the runner's own dir, the node running us, system bins) and an empty HOME. Nothing else.
  return { PATH: [path.dirname(claudePath), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: home };
}
export function loadCheck(suite, claudePath, { timeoutMs = 120_000 } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'cdc-release-load-'));
  try {
    const home = path.join(work, 'home');
    mkdirSync(home);
    const env = runnerEnv(claudePath, home);
    const json = path.join(work, 'result.json');
    const run = (trust) => {
      const args = ['plugin', 'eval', suite.pluginDir, '--max-cost-usd', '0', ...(trust ? ['--trust-plugin'] : []), '--no-publish',
        '--output-dir', path.join(work, 'out'), '--report', path.join(work, 'report.html'), '--json', json];
      const r = spawnSync(claudePath, args, { encoding: 'utf8', env, cwd: work, timeout: timeoutMs });
      return { r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    };
    let { r, output } = run(true);
    if (/unknown option '--trust-plugin'/.test(output)) ({ r, output } = run(false));
    // never retry without the cost ceiling: without it the check could start real runs
    if (/unknown option '--max-cost-usd'/.test(output)) return { status: 'skipped', reason: 'this version has no --max-cost-usd, so a run-free load check is not possible' };
    if (/early access/i.test(output)) return { status: 'skipped', reason: 'this version has no official eval runner' };
    const parsed = parseRunnerOutput(output, suite);
    let result = null;
    try { result = JSON.parse(readFileSync(json, 'utf8')); } catch { /* reported below */ }
    if (!result) {
      const tail = output.trim().split('\n').filter(Boolean).slice(-1).join('') || (r.error?.code === 'ETIMEDOUT' ? 'timed out' : `exit ${r.status}`);
      return { status: 'failed', reason: `the runner wrote no result: ${tail}`, ...parsed };
    }
    const runsStarted = (result.cases ?? []).reduce((n, c) => n + Object.values(c.arms ?? {}).reduce((m, runs) => m + (runs?.length ?? 0), 0), 0);
    return { status: 'ok', ...parsed, runsStarted, costUsd: result.costUsd ?? 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- classification ----------
// Code search also finds other harnesses' evals/ folders; only a case with graders or a case.yaml is in the plugin eval format.
export const isEvalSuite = (suite) => suite.cases.some((c) => c.graders.length > 0 || c.caseYaml);

// prev/next: true (loaded), false (failed to load), null (not checked)
export function classifyCase(prev, next) {
  if (next === null) return 'unchecked';
  if (next) return prev === false ? 'fixed' : 'loads';
  return prev === true ? 'broke' : prev === false ? 'never-loaded' : 'fails';
}
const tidy = (msg, root) => String(msg ?? '').split(root + path.sep).join('').split(root).join('.').replace(/\s+/g, ' ').trim().slice(0, 400);

// One suite's per-case result from its two load checks and the static findings.
export function classifySuite(suite, loads, findings) {
  const failMap = (lc) => (lc?.status === 'ok' ? new Map(lc.loadErrors.map((e) => [e.case, e.message])) : null);
  const errKey = new Map([...(loads.previous?.loadErrors ?? []), ...(loads.next?.loadErrors ?? [])].map((e) => [e.case, e]));
  const prevFail = failMap(loads.previous), nextFail = failMap(loads.next);
  const names = [...new Set([...suite.cases.map((c) => c.name), ...(loads.next?.loadErrors ?? []).map((e) => e.case), ...(loads.previous?.loadErrors ?? []).map((e) => e.case)])];
  return names.map((name) => {
    const state = (m) => (m ? !m.has(name) : null);
    const status = classifyCase(state(prevFail), state(nextFail));
    const own = findings.filter((f) => f.case === name && f.level === 'ERROR');
    // the suggestion that answers the runner's own complaint first: same key, then same file, then any fixable one
    const le = errKey.get(name);
    const fixFinding = (le && own.find((f) => le.key && f.key === le.key && f.file === le.file)) ?? (le && own.find((f) => le.key && f.key === le.key))
      ?? (le && own.find((f) => f.file === le.file)) ?? own.find((f) => f.fixable) ?? own[0] ?? null;
    return {
      name, status,
      error: nextFail?.get(name) ? tidy(nextFail.get(name), suite.pluginDir) : null,
      previousError: status === 'fixed' || status === 'never-loaded' ? tidy(prevFail?.get(name) ?? '', suite.pluginDir) || null : null,
      doctor: fixFinding ? { rule: fixFinding.rule, file: fixFinding.file, fix: fixFinding.fix, fixable: !!fixFinding.fixable, more: own.length - 1 } : null,
    };
  });
}

export function totalsOf(suites) {
  const t = { suites: 0, cases: 0, loads: 0, broke: 0, fixed: 0, neverLoaded: 0, fails: 0, unchecked: 0 };
  for (const s of suites) {
    if (s.status !== 'checked') continue;
    t.suites++;
    for (const c of s.cases) { t.cases++; t[c.status === 'never-loaded' ? 'neverLoaded' : c.status]++; }
  }
  return t;
}
export function headline(version, t) {
  const parts = [`${t.loads} load`, `${t.broke} broke on this release`];
  if (t.fixed) parts.push(`${t.fixed} fixed on this release`);
  parts.push(`${t.neverLoaded} never loaded`);
  if (t.fails) parts.push(`${t.fails} fail to load`);
  if (t.unchecked) parts.push(`${t.unchecked} unchecked`);
  return `Claude Code ${version}: ${t.suites} public suite${t.suites === 1 ? '' : 's'}, ${t.cases} case${t.cases === 1 ? '' : 's'}. ${parts.join(', ')}`;
}

// ---------- runners ----------
function resolveRunner(p) {
  const bin = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'node_modules', '.bin', 'claude') : p;
  if (!existsSync(bin)) throw new Error(`--runner ${p}: no claude binary there`);
  return path.resolve(bin);
}
function binaryVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: runnerEnv(bin, os.tmpdir()), timeout: 30_000 });
  return (r.stdout ?? '').trim().split(/\s+/)[0] || null;
}
function installVersion(version, workDir) {
  const prefix = path.join(workDir, `cc-${version}`);
  mkdirSync(prefix, { recursive: true });
  const r = spawnSync('npm', ['install', `${PACKAGE}@${version}`, '--prefix', prefix, '--no-fund', '--no-audit', '--loglevel', 'error'], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`could not install ${PACKAGE}@${version}: ${(r.stderr ?? '').trim().split('\n').pop()}`);
  return path.join(prefix, 'node_modules', '.bin', 'claude');
}

// ---------- the page ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { loads: 'loads', broke: 'broke on this release', fixed: 'fixed on this release', 'never-loaded': 'never loaded', fails: 'fails to load', unchecked: 'unchecked' };
const TONE = { loads: 'pass', fixed: 'pass', broke: 'fail', 'never-loaded': 'warn', fails: 'warn', unchecked: 'muted' };

const CSS = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"tnum"}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
a{color:var(--track);text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:1080px;margin:0 auto;padding:28px 28px 80px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;max-width:30ch}
.lede{font-size:16px;color:var(--muted);margin:0;max-width:70ch}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:22px 0}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:12px 14px;box-shadow:var(--shadow)}
.tile .tl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}.tile .tb{font-size:26px;font-weight:600;line-height:1.25}
.hist{display:flex;gap:8px;flex-wrap:wrap}.hv{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:6px 10px;font-size:12.5px;min-width:120px}.hv b{display:block;font-weight:600}.hv.cur{border-color:var(--track)}
.bar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--code);margin-top:5px}.bar i{display:block;height:100%}.bar .pass{background:var(--pass)}.bar .fail{background:var(--fail)}.bar .warn{background:var(--warn)}.bar .muted{background:var(--muted)}
.note{background:var(--track-bg);border-radius:8px;padding:12px 16px;font-size:14px;margin:18px 0}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;box-shadow:var(--shadow);margin:0 0 14px;overflow:hidden}
.ch{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--rule)}
.ch h3{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}.ch .meta{font-size:12.5px;color:var(--muted)}.ch .desc{font-size:13px;color:var(--muted);margin:2px 0 0;max-width:70ch}
.sum{font-size:13px;white-space:nowrap}.sum span{margin-left:10px}
.cases{width:100%;border-collapse:collapse;font-size:13.5px}.cases td{padding:8px 16px;border-top:1px solid var(--rule);vertical-align:top}.cases tr:first-child td{border-top:0}
.cases td.st{white-space:nowrap;width:1%}.cases td.nm{font-weight:500;overflow-wrap:anywhere;width:24%}
.pill{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:10px;background:var(--code);color:var(--muted)}.pill.pass{background:var(--pass-bg);color:var(--pass)}.pill.fail{background:var(--fail-bg);color:var(--fail)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.err{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.fix{font-size:12.5px;color:var(--muted);margin-top:3px}
details>summary{cursor:pointer;padding:8px 16px;font-size:13px;color:var(--muted)}details[open]>summary{border-bottom:1px solid var(--rule)}
.skip{padding:12px 16px;font-size:13.5px;color:var(--muted)}
.foot{color:var(--muted);font-size:12.5px;margin-top:26px;max-width:80ch}
:focus-visible{outline:2px solid var(--track);outline-offset:2px}
@media (max-width:700px){.wrap{padding:20px 16px 60px}h1{font-size:24px}.cases td{padding:8px 12px}.cases td.nm{width:auto}.cases tr{display:grid;grid-template-columns:auto 1fr}.cases td.detail{grid-column:1/-1;padding-top:0}.sum span{margin:0 10px 0 0}}`;

function bar(t) {
  if (!t.cases) return '';
  const seg = (n, cls) => (n ? `<i class="${cls}" style="width:${((n / t.cases) * 100).toFixed(2)}%"></i>` : '');
  return `<span class="bar">${seg(t.loads + t.fixed, 'pass')}${seg(t.broke, 'fail')}${seg(t.neverLoaded + t.fails, 'warn')}${seg(t.unchecked, 'muted')}</span>`;
}
const suiteOrder = (a, b) => {
  const k = (s) => [s.status === 'checked' ? 0 : 1, -s.cases.filter((c) => c.status === 'broke').length, -(s.stars ?? 0)];
  const ka = k(a), kb = k(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.repo.localeCompare(b.repo);
};

export function renderHtml(report) {
  const { claudeCode: cc, totals: t } = report;
  const tile = (label, n, cls = '') => `<div class="tile"><div class="tl">${label}</div><div class="tb ${cls}">${n}</div></div>`;
  const hist = (report.history ?? []).slice(-12).reverse().map((h) => `<div class="hv${h.version === cc.version ? ' cur' : ''}"><b class="mono">${esc(h.version)}</b>${h.totals.loads + (h.totals.fixed ?? 0)} of ${h.totals.cases} load${h.totals.broke ? `, <span class="fail">${h.totals.broke} broke</span>` : ''}${bar(h.totals)}</div>`).join('');
  const notSuites = report.suites.filter((s) => s.status === 'not-a-suite').length;
  const cards = report.suites.filter((s) => s.status !== 'not-a-suite').sort(suiteOrder).map((s) => {
    const repoUrl = `https://github.com/${s.repo}`;
    const treeUrl = `${repoUrl}/tree/${s.commit ?? s.ref ?? 'HEAD'}${s.path === '.' ? '' : `/${s.path.split('/').map(encodeURIComponent).join('/')}`}`;
    const counts = Object.fromEntries(STATUSES.map((st) => [st, s.cases.filter((c) => c.status === st).length]));
    const sum = s.status === 'checked' ? STATUSES.filter((st) => counts[st]).map((st) => `<span class="${TONE[st]}">${counts[st]} ${LABEL[st]}</span>`).join('') : '<span class="muted">not checked</span>';
    const rows = s.status !== 'checked' ? `<div class="skip">Not checked on this release: ${esc(s.reason)}</div>`
      : `<details${counts.broke || counts.fixed || s.cases.length <= 8 ? ' open' : ''}><summary>${s.cases.length} case${s.cases.length === 1 ? '' : 's'}</summary><table class="cases">${s.cases.map((c) => `<tr><td class="st"><span class="pill ${TONE[c.status]}">${LABEL[c.status]}</span></td><td class="nm">${esc(c.name)}</td><td class="detail">${c.error ? `<div class="err">${esc(c.error)}</div>` : c.status === 'fixed' && c.previousError ? `<div class="err muted">on ${esc(cc.previous)}: ${esc(c.previousError)}</div>` : ''}${c.doctor && c.status !== 'loads' && c.status !== 'fixed' ? `<div class="fix">suite-doctor: ${esc(c.doctor.fix)}${c.doctor.fixable ? ' (<code>--fix</code> applies this)' : ''}${c.doctor.more > 0 ? `, plus ${c.doctor.more} more` : ''}</div>` : ''}</td></tr>`).join('')}</table></details>`;
    return `<section class="card" id="${esc(s.repo.replace('/', '-') + (s.path === '.' ? '' : '-' + s.path.replace(/\//g, '-')))}"><div class="ch"><div><h3><a href="${esc(repoUrl)}">${esc(s.repo)}</a>${s.path !== '.' ? ` <span class="muted mono">${esc(s.path)}</span>` : ''}</h3><div class="meta">${s.stars != null ? `${s.stars} star${s.stars === 1 ? '' : 's'} · ` : ''}${s.commit ? `<a href="${esc(treeUrl)}" class="mono">${esc(s.commit.slice(0, 7))}</a>` : ''}</div>${s.description ? `<p class="desc">${esc(s.description.length > 200 ? `${s.description.slice(0, 197).trimEnd()}...` : s.description)}</p>` : ''}</div><div class="sum">${sum}</div></div>${rows}</section>`;
  }).join('\n');
  const when = new Date(report.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Release Report</title><meta name="description" content="${esc(report.headline)}"><style>${CSS}</style></head><body><main class="wrap">
<p class="eyebrow">config-drift-checker · <b>Claude Code release report</b></p>
<h1>${esc(report.headline)}</h1>
<p class="lede">Every public <code>claude plugin eval</code> suite we know of, loaded by the official runner on Claude Code ${esc(cc.version)} and on ${esc(cc.previous ?? 'no earlier version')}. A case that loaded on ${esc(cc.previous)} and not on ${esc(cc.version)} broke on this release; one that fails on both never loaded. Updated ${esc(when)}.</p>
<div class="tiles">${tile('suites', t.suites)}${tile('cases', t.cases)}${tile('load', t.loads, 'pass')}${tile('broke on this release', t.broke, t.broke ? 'fail' : '')}${t.fixed ? tile('fixed on this release', t.fixed, 'pass') : ''}${tile('never loaded', t.neverLoaded, t.neverLoaded ? 'warn' : '')}</div>
${hist ? `<h2>Per release</h2><div class="hist">${hist}</div>` : ''}
<div class="note">Suite authors: run <code>node tools/suite-doctor.mjs &lt;plugin&gt; --fix</code> from a checkout of <a href="${REPO_URL}">config-drift-checker</a> to see and repair what the runner rejects, or <a href="${REPO_URL}/issues/new?title=${encodeURIComponent('Release report: opt out')}">open an issue to opt out</a> of this report.</div>
<h2>Suites</h2>
${cards || '<p class="muted">No suites checked.</p>'}
<p class="foot">How this is checked: each repo is cloned at depth 1 (no submodules, no LFS) and the suite is loaded by <code>claude plugin eval --max-cost-usd 0 --trust-plugin --no-publish</code> in a bare environment with an empty HOME and no credentials. The cost ceiling stops the run before any agent starts, so no model runs and nothing is spent; nothing from the repo is installed or executed. The error shown is the runner's own first message for the case; the fix line comes from suite-doctor's static rules. Suites are found through GitHub code search and an explicit list${notSuites ? `; ${notSuites} other repo${notSuites === 1 ? '' : 's'} matched the search but hold${notSuites === 1 ? 's' : ''} evals for a different harness and ${notSuites === 1 ? 'is' : 'are'} not listed` : ''}. Data: <a href="report.json">report.json</a>, history in <a href="${REPO_URL}/tree/main/docs/release-report/archive">archive/</a>. Generated by <a href="${REPO_URL}">config-drift-checker</a>.</p>
</main></body></html>
`;
}

// ---------- orchestration ----------
function readJsonSafe(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
export function loadHistory(archiveDir) {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((f) => /^\d+\.\d+\.\d+\.json$/.test(f)).map((f) => readJsonSafe(path.join(archiveDir, f))).filter((j) => j?.totals)
    .map((j) => ({ version: j.claudeCode.version, previous: j.claudeCode.previous, generatedAt: j.generatedAt, totals: j.totals })).sort((a, b) => cmpV(a.version, b.version));
}

export async function buildReport(opt, log = (m) => process.stderr.write(m + '\n')) {
  const outDir = path.resolve(opt.outDir);
  const prior = readJsonSafe(path.join(outDir, 'report.json'));
  const optOut = opt.optOut && existsSync(opt.optOut) ? parseOptOut(readFileSync(opt.optOut, 'utf8')) : new Set();
  const listed = opt.suites ? parseSuitesFile(readFileSync(opt.suites, 'utf8')).map((s) => normaliseSuite(s, 'list')) : [];
  for (const s of listed) if (s.error) log(`skipping a suites-file entry: ${s.error}`);
  let discovered = [], discoveryError = null;
  if (opt.discover) {
    try { discovered = await discover(opt.api); log(`discovered ${discovered.length} suite location(s)`); } catch (e) { discoveryError = e.message; log(`discovery failed (${e.message}); using the explicit list and the last report's suites`); }
  }
  const carried = (prior?.suites ?? []).filter((s) => s.status !== 'not-a-suite').map((s) => normaliseSuite({ repo: s.repo, path: s.path, ref: s.ref }, 'previous'));
  const suites = mergeSuites([listed, discovered, carried], optOut).slice(0, opt.maxSuites);
  const priorMeta = new Map((prior?.suites ?? []).map((s) => [`${s.repo.toLowerCase()}:${s.path}`, s]));

  const work = opt.workDir ? path.resolve(opt.workDir) : mkdtempSync(path.join(os.tmpdir(), 'cdc-release-report-'));
  mkdirSync(work, { recursive: true });
  const runners = {};
  for (const [label, v] of [['next', opt.version], ['previous', opt.previous]]) {
    if (!v) { runners[label] = null; continue; }
    const bin = opt.runners[v] ? resolveRunner(opt.runners[v]) : installVersion(v, work);
    const got = binaryVersion(bin);
    if (got !== v) throw new Error(`the runner for ${v} reports version ${got ?? '(none)'}`);
    runners[label] = bin;
  }

  const results = [];
  const metaCache = new Map();
  for (const [i, s] of suites.entries()) {
    const key = `${s.repo.toLowerCase()}:${s.path}`;
    const base = { repo: s.repo, path: s.path, ref: s.ref, source: s.source, stars: priorMeta.get(key)?.stars ?? null, description: priorMeta.get(key)?.description ?? null, commit: null };
    log(`[${i + 1}/${suites.length}] ${s.repo} ${s.path}`);
    if (opt.metadata !== false) {
      try {
        if (!metaCache.has(s.repo)) metaCache.set(s.repo, await (opt.api ?? githubApi)(`repos/${s.repo}`));
        const m = metaCache.get(s.repo);
        Object.assign(base, { stars: m.stargazers_count ?? base.stars, description: m.description ?? null });
        if (m.size && m.size * 1024 > opt.maxRepoBytes) { results.push({ ...base, status: 'skipped', reason: `the repo is ${Math.round(m.size / 1024)} MB, over the ${Math.round(opt.maxRepoBytes / 2 ** 20)} MB cap`, cases: [] }); continue; }
        if (m.archived) { results.push({ ...base, status: 'skipped', reason: 'the repo is archived', cases: [] }); continue; }
      } catch (e) { log(`  metadata: ${e.message}`); }
    }
    const dest = path.join(work, 'clones', `${String(i).padStart(3, '0')}-${s.repo.replace('/', '__')}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    const cl = shallowClone(s, dest, { cloneBase: opt.cloneBase, maxBytes: opt.maxRepoBytes });
    if (!cl.ok) { results.push({ ...base, status: 'skipped', reason: cl.reason, cases: [] }); continue; }
    base.commit = cl.commit;
    try {
      const pluginDir = path.join(dest, s.path);
      const real = realpathSync(pluginDir);
      if (real !== realpathSync(dest) && !real.startsWith(realpathSync(dest) + path.sep)) throw new Error('the plugin path leaves the repo');
      if (!lstatSync(pluginDir).isDirectory()) throw new Error(`${s.path} is not a directory`);
      const evalDir = resolveEvalDir(real);
      if (!evalDir.startsWith(realpathSync(dest) + path.sep)) throw new Error('the manifest points the eval dir outside the repo');
      const suite = existsSync(evalDir) ? loadSuite(real) : { cases: [] };
      if (!isEvalSuite(suite)) { results.push({ ...base, status: 'not-a-suite', reason: 'no case directory with graders/ or case.yaml, so this is not a claude plugin eval suite', cases: [] }); continue; }
      const findings = diagnose(suite);
      const loads = { next: runners.next ? loadCheck(suite, runners.next) : null, previous: runners.previous ? loadCheck(suite, runners.previous) : null };
      if (loads.next?.status !== 'ok') { results.push({ ...base, status: 'skipped', reason: loads.next ? tidy(loads.next.reason, real) : 'no runner', cases: [] }); continue; }
      if (loads.next.runsStarted > 0 || loads.next.costUsd > 0) throw new Error('the load check started agent runs; stopping (the cost ceiling no longer holds)');
      const cases = classifySuite(suite, loads, findings);
      const loadSummary = (lc) => (lc ? { status: lc.status, failed: lc.status === 'ok' ? lc.failedCount : null, ...(lc.reason ? { reason: tidy(lc.reason, real) } : {}) } : null);
      results.push({ ...base, status: 'checked', load: { [opt.version]: loadSummary(loads.next), ...(opt.previous ? { [opt.previous]: loadSummary(loads.previous) } : {}) },
        doctor: { errors: findings.filter((f) => f.level === 'ERROR').length, fixable: findings.filter((f) => f.fixable).length }, cases });
    } catch (e) {
      if (/cost ceiling/.test(e.message)) throw e;
      results.push({ ...base, status: 'skipped', reason: tidy(e.message, dest), cases: [] });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  if (!opt.workDir) rmSync(work, { recursive: true, force: true });

  const totals = totalsOf(results);
  const report = {
    schemaVersion: 1, generatedAt: new Date(opt.now ?? Date.now()).toISOString(),
    claudeCode: { version: opt.version, previous: opt.previous ?? null },
    headline: headline(opt.version, totals), totals,
    method: 'claude plugin eval --max-cost-usd 0 --trust-plugin --no-publish, bare env (PATH, empty HOME), depth-1 clone; no model runs, no credentials, no repo code executed',
    discovery: { queries: opt.discover ? DISCOVERY_QUERIES : [], error: discoveryError, optedOut: [...optOut].sort() },
    suites: results,
  };
  const archiveDir = path.join(outDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(path.join(archiveDir, `${opt.version}.json`), JSON.stringify(report, null, 2) + '\n');
  report.history = loadHistory(archiveDir);
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'index.html'), renderHtml(report));
  return report;
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const usage = 'usage: release-report.mjs [--version <v>] [--previous <v>] [--suites suites.yml] [--discover] [--opt-out file] [--out-dir dir] [--runner <version>=<path>] [--work-dir dir] [--max-suites 40] [--max-repo-mb 200]';
  const opt = { version: null, previous: null, suites: null, discover: false, optOut: null, outDir: 'docs/release-report', runners: {}, workDir: null, maxSuites: 40, maxRepoBytes: 200 * 2 ** 20, cloneBase: process.env.CDC_CLONE_BASE || 'https://github.com/' };
  const need = (i) => { if (argv[i + 1] === undefined) { console.error(usage); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') opt.version = need(i), i++;
    else if (a === '--previous') opt.previous = need(i), i++;
    else if (a === '--suites') opt.suites = need(i), i++;
    else if (a === '--discover') opt.discover = true;
    else if (a === '--opt-out') opt.optOut = need(i), i++;
    else if (a === '--out-dir') opt.outDir = need(i), i++;
    else if (a === '--work-dir') opt.workDir = need(i), i++;
    else if (a === '--max-suites') opt.maxSuites = Number(need(i)), i++;
    else if (a === '--max-repo-mb') opt.maxRepoBytes = Number(need(i)) * 2 ** 20, i++;
    else if (a === '--no-metadata') opt.metadata = false;
    else if (a === '--runner') { const [v, ...p] = need(i).split('='); opt.runners[v] = p.join('='); i++; }
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    else { console.error(`unknown option ${a}\n${usage}`); process.exit(2); }
  }
  for (const v of [opt.version, opt.previous]) if (v && !/^\d+\.\d+\.\d+$/.test(v)) { console.error(`'${v}' is not a version`); process.exit(2); }
  if (!opt.suites && !opt.discover && !existsSync(path.join(opt.outDir, 'report.json'))) { console.error(`nothing to check: give --suites and/or --discover\n${usage}`); process.exit(2); }
  try {
    if (!opt.version || !opt.previous) {
      opt.version ??= execFileSync('npm', ['view', PACKAGE, 'version'], { encoding: 'utf8', timeout: 60_000 }).trim();
      opt.previous ??= previousVersion(JSON.parse(execFileSync('npm', ['view', PACKAGE, 'versions', '--json'], { encoding: 'utf8', timeout: 60_000 })), opt.version);
    }
    const r = await buildReport(opt);
    console.log(r.headline);
    console.log(path.join(opt.outDir, 'index.html'));
  } catch (e) { console.error(`release-report: ${e.message}`); process.exit(1); }
}
