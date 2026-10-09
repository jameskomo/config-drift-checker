// cc-release: shared plumbing for the tools that test one setup across Claude Code releases
// (drift-bisect, drift-matrix): list the published versions, install one into a throwaway npm prefix
// (never touching your global install), and run a suite on it, with the official `claude plugin eval`
// runner when that release has one and the bundled shim otherwise, the same fallback the Action uses.
//
//   publishedVersions()                       every @anthropic-ai/claude-code version on npm (network, free)
//   versionsBetween(all, good, bad) / lastVersions(all, n)   stable releases, ascending
//   installRelease(version)                   → { binDir, cleanup } or null when npm install fails
//   runSuite({ plugin, binDir, runner, model, runs, budget, ... })   → { raw, json, runner, note }
//   usableReason(json, expectCases)           '' when a result is a usable measurement, else why not
import { promises as fs, existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizeResult } from './eval-classify.mjs';

export const SEMVER = /^\d+\.\d+\.\d+$/;
export const SHIM = path.join(path.dirname(new URL(import.meta.url).pathname), 'eval-shim.mjs');

export const cmpV = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
};

// stable versions strictly after good, up to and including bad, ascending
export function versionsBetween(all, good, bad) {
  return all.filter((v) => SEMVER.test(v) && cmpV(v, good) > 0 && cmpV(v, bad) <= 0).sort(cmpV);
}

// the newest n stable versions, ascending
export const lastVersions = (all, n) => [...new Set(all.filter((v) => SEMVER.test(v)))].sort(cmpV).slice(-Math.max(0, n));

export function publishedVersions() {
  const nv = spawnSync('npm', ['view', '@anthropic-ai/claude-code', 'versions', '--json'], { encoding: 'utf8' });
  if (nv.status !== 0) throw new Error('npm view failed (network?)');
  const all = JSON.parse(nv.stdout);
  return Array.isArray(all) ? all : [all];
}

export async function installRelease(version) {
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), `cdc-cc-${version}-`));
  const cleanup = () => fs.rm(prefix, { recursive: true, force: true }).catch(() => {});
  const inst = spawnSync('npm', ['install', `@anthropic-ai/claude-code@${version}`, '--prefix', prefix, '--no-fund', '--no-audit'], { encoding: 'utf8' });
  if (inst.status !== 0) { await cleanup(); return null; }
  return { binDir: path.join(prefix, 'node_modules', '.bin'), cleanup };
}

const withBin = (binDir, env = process.env) => ({ ...env, PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}` });

// the Action's probe: `claude plugin eval` in an empty dir says "early access" when this account or
// release has no official runner
export function hasOfficialRunner(binDir, env = process.env) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cdc-probe-'));
  const r = spawnSync('claude', ['plugin', 'eval'], { cwd: d, env: withBin(binDir, env), encoding: 'utf8', timeout: 60_000 });
  rmSync(d, { recursive: true, force: true });
  return !/early access/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`) && !r.error;
}

// a result the matrix or the Action can trust: something ran, not everything errored, every case loaded
export function usableReason(j, expectCases = null) {
  if (!j) return 'no result file';
  const total = j.aggregates?.totalRuns ?? 0, errored = j.aggregates?.erroredRuns ?? 0, cases = (j.cases ?? []).length;
  if (total === 0) return 'no agent runs in the result';
  if (errored === total) return `every run errored: ${j.aggregates?.partialReason ?? 'unknown'}`;
  if (expectCases !== null && cases < expectCases) return `only ${cases} of ${expectCases} cases loaded (the runner rejected the rest)`;
  return '';
}

const readRaw = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };

// One suite run on the release installed in binDir. runner: 'shim' | 'official' | 'auto' (official when
// the release has it, shim otherwise). An official run that is not a usable measurement falls back to
// the shim, so a runner CLI change never takes a cell down. The with arm only (ablation none).
export async function runSuite({ plugin, binDir, env = process.env, runner = 'shim', model = null, judgeModel = null, runs = 1, budget = null, caseGlob = null, scaffold = true, expectCases = null, outDir = null, version = null }) {
  const out = outDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-suite-out-'));
  await fs.mkdir(out, { recursive: true });
  const file = path.join(out, 'aggregate-result.json');
  const runEnv = withBin(binDir, env);
  let used = runner === 'auto' ? (hasOfficialRunner(binDir, env) ? 'official' : 'shim') : runner, note = null;
  if (used === 'official') {
    let args = ['plugin', 'eval', plugin, '--ablation', 'none', ...(model ? ['--model', model] : []), ...(judgeModel ? ['--judge-model', judgeModel] : []),
      '--runs', String(runs), ...(scaffold ? ['--scaffold'] : []), '--allow-tools', 'Bash', 'Write', 'Edit', '--no-publish', '--trust-plugin',
      ...(budget !== null ? ['--max-cost-usd', String(budget)] : []), '--json', file];
    // older releases reject flags they predate; drop only those two and retry
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = spawnSync('claude', args, { cwd: plugin, env: runEnv, encoding: 'utf8' });
      const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/unknown option '(--trust-plugin|--max-cost-usd)'/);
      if (!m) break;
      const i = args.indexOf(m[1]); args = [...args.slice(0, i), ...args.slice(i + (m[1] === '--max-cost-usd' ? 2 : 1))];
    }
    const raw = await readRaw(file);
    const reason = usableReason(raw ? normalizeResult(raw) : null, expectCases);
    if (reason) { note = `official runner gave no usable result (${reason}); fell back to the shim`; used = 'shim'; await fs.rm(file, { force: true }); }
  }
  let tail = '';
  if (used === 'shim') {
    const r = spawnSync('node', [SHIM, plugin, ...(caseGlob ? ['--case', caseGlob] : []), '--runs', String(runs), '--ablation', 'none', ...(scaffold ? ['--scaffold'] : []),
      ...(budget !== null ? ['--budget', String(budget)] : []), ...(model ? ['--model', model] : []), ...(judgeModel ? ['--judge-model', judgeModel] : []), '--output-dir', out], { encoding: 'utf8', env: runEnv });
    tail = String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(-300);
  }
  const raw = await readRaw(file);
  if (!raw && tail) note = [note, `the shim wrote no result: ${tail}`].filter(Boolean).join('; ');
  if (raw && version) raw.harness ??= { name: 'claude-code', version }; // the official runner does not stamp it
  return { raw, json: raw ? normalizeResult(raw) : null, runner: used, note, file: existsSync(file) ? file : null };
}

// supports a,b and {a,b}; * stays inside one path segment, ** crosses them
export function globToRe(g) { const alts = g.replace(/^\{(.*)\}$/, '$1').split(',').map((x) => x.trim()).filter(Boolean); return new RegExp('^(?:' + alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')).join('|') + ')$'); }

// `tags:` from a prompt.md frontmatter, inline [a, b] or a block list
export function caseTags(src) {
  const fm = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const unq = (t) => t.trim().replace(/^(['"])(.*)\1$/, '$2');
  const inline = fm.match(/^tags:[ \t]*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(',').map(unq).filter(Boolean);
  const block = fm.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[^\n]*(?:\r?\n|$))+)/m);
  return block ? [...block[1].matchAll(/-[ \t]*([^\r\n]+)/g)].map((m) => unq(m[1])) : [];
}

// The suite's cases, optionally narrowed by --case glob and --tag. Neither runner filters by tag (and
// the official one not by name either), so a narrowed suite is served as a view: a temp copy of the
// plugin (without .git, node_modules and past results) whose eval dir holds only the selected cases.
// A copy, not symlinks: runners walk directories with isDirectory(), which a symlink fails.
// Unfiltered, the view is the plugin itself.
export async function suiteView(plugin, { caseGlob = null, tag = null } = {}) {
  const manifest = await readRaw(path.join(plugin, '.claude-plugin', 'plugin.json')) ?? {};
  const evalRel = manifest.experimental?.evals ?? 'evals', evalDir = path.join(plugin, evalRel);
  const all = existsSync(evalDir) ? (await fs.readdir(evalDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !['results', 'mocks'].includes(e.name) && existsSync(path.join(evalDir, e.name, 'prompt.md'))).map((e) => e.name).sort() : [];
  const cases = [];
  for (const c of all) {
    if (caseGlob && !globToRe(caseGlob).test(c)) continue;
    if (tag && !caseTags(await fs.readFile(path.join(evalDir, c, 'prompt.md'), 'utf8')).includes(tag)) continue;
    cases.push(c);
  }
  if (!caseGlob && !tag) return { dir: plugin, cases, evalDir, cleanup: async () => {} };
  const view = await fs.mkdtemp(path.join(os.tmpdir(), 'cdc-view-'));
  const drop = new Set([...['.git', 'node_modules'].map((n) => path.join(plugin, n)), path.join(evalDir, 'results'), ...all.filter((c) => !cases.includes(c)).map((c) => path.join(evalDir, c))]);
  await fs.cp(plugin, view, { recursive: true, verbatimSymlinks: true, filter: (src) => !drop.has(src) });
  return { dir: view, cases, evalDir: path.join(view, evalRel), cleanup: () => fs.rm(view, { recursive: true, force: true }).catch(() => {}) };
}
