#!/usr/bin/env node
// cdc-bootstrap — one command from a plain terminal to a protected repo. No Claude REPL session.
//
//   node <plugin-root>/tools/cdc-bootstrap.mjs [repo-dir] [--no-agent] [--budget <usd>] [--force]
//
// Default mode runs the plugin's `setup` skill headlessly (the same flow the demo repo was built
// with, unattended): it detects your CLAUDE.md/skills/hooks, writes eval cases from the real
// content, smoke-runs them, and writes .cdc.yml plus the workflow. That spends agent runs
// (subscription or API); --budget states the cap the agent is told to respect (default 3).
//
// --no-agent scaffolds without spending anything: a minimal plugin manifest if none exists, a
// blank starter case via the official `claude plugin eval init --bare`, .cdc.yml via cdc-config
// init (harness pinned to your installed Claude Code; model left on the alias until the pin PR),
// and the CI workflow. You then fill in the starter case, or run the agent mode later.
//
// Idempotent: existing files are never overwritten without --force; done parts are skipped.
// Ends with the same hand-off checklist either way (secrets, two repo settings, first run).
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PLUGIN_ROOT = path.dirname(HERE);

const argv = process.argv.slice(2);
let dir = null, agent = true, budget = 3, force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-agent') agent = false;
  else if (a === '--budget') budget = Number(argv[++i]);
  else if (a === '--force') force = true;
  else if (!a.startsWith('--')) dir = path.resolve(a);
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
dir = dir ?? process.cwd();

const say = (m) => console.log(m);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', ...opts });

// ---- preflight ----
const cv = run('claude', ['--version']);
if (cv.status !== 0) { console.error('claude CLI not found on PATH — install Claude Code first: https://code.claude.com'); process.exit(1); }
const harness = (cv.stdout ?? '').trim().split(/\s+/)[0];
if (run('git', ['rev-parse', '--git-dir']).status !== 0) { console.error(`${dir} is not a git repository`); process.exit(1); }

const manifestPath = path.join(dir, '.claude-plugin/plugin.json');
const has = {
  manifest: existsSync(manifestPath),
  cdc: existsSync(path.join(dir, '.cdc.yml')),
  workflow: existsSync(path.join(dir, '.github/workflows/config-drift-checker.yml')),
};
const evalDir = () => {
  try { return path.join(dir, JSON.parse(readFileSync(manifestPath, 'utf8')).experimental?.evals ?? 'evals'); } catch { return path.join(dir, 'evals'); }
};
say(`bootstrap: ${dir}`);
say(`  claude ${harness} · manifest ${has.manifest ? 'found' : 'missing'} · .cdc.yml ${has.cdc ? 'found' : 'missing'} · workflow ${has.workflow ? 'found' : 'missing'} · mode ${agent ? `agent (budget $${budget})` : 'no-agent scaffold'}`);

if (agent) {
  // ---- agent mode: the setup skill, headless ----
  const prompt = `/config-drift-checker:setup — run non-interactively: never ask questions, choose sensible defaults, and stay under $${budget} of eval spend (pass --budget to every shim call). Set budget.per_month_usd to 10 in .cdc.yml. Skip anything that already exists rather than overwriting it. Finish by printing the hand-off checklist.`;
  say('  running the setup skill headlessly (this takes minutes and spends agent runs) …');
  const r = spawnSync('claude', ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('setup skill run failed — run it interactively to see why: claude "/config-drift-checker:setup"'); process.exit(1); }
} else {
  // ---- no-agent mode: deterministic scaffold, zero spend ----
  if (!has.manifest) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent-setup';
    await fs.writeFile(manifestPath, JSON.stringify({ name, version: '0.1.0', description: `agent setup for ${name}` }, null, 2) + '\n');
    say(`  wrote ${path.relative(dir, manifestPath)}`);
  }
  const ed = evalDir();
  if (!existsSync(ed) || !(await fs.readdir(ed)).some((e) => !['results', 'mocks'].includes(e))) {
    const init = run('claude', ['plugin', 'eval', 'init', '--bare', 'starter-case']);
    if (init.status === 0) say('  wrote a blank starter case (official `plugin eval init --bare`) — fill in the prompt and graders');
    else say('  could not write the starter case (`claude plugin eval init --bare` failed) — write one by hand or run agent mode');
  }
  if (!has.cdc || force) {
    const cc = run('node', [path.join(PLUGIN_ROOT, 'tools/cdc-config.mjs'), dir, 'init', '--harness', harness]);
    if (cc.status === 0) say('  wrote .cdc.yml (harness pinned to your installed Claude Code; model pins after the first run\'s pin PR)');
    else { console.error(cc.stderr || cc.stdout); process.exit(1); }
  }
}

// ---- workflow (both modes; the setup skill usually wrote it already) ----
const wfDst = path.join(dir, '.github/workflows/config-drift-checker.yml');
if (!existsSync(wfDst) || force) {
  await fs.mkdir(path.dirname(wfDst), { recursive: true });
  await fs.copyFile(path.join(PLUGIN_ROOT, 'ci/config-drift-checker.yml'), wfDst);
  say(`  wrote ${path.relative(dir, wfDst)} (adjust its paths: filters to where your setup lives)`);
}

// ---- coverage + checklist ----
const cov = run('node', [path.join(PLUGIN_ROOT, 'tools/config-coverage.mjs'), dir]);
if (cov.status === 0 && cov.stdout) say('\n' + cov.stdout.trim().split('\n')[0]);
say(`
Done. What only you can do now:
  1. gh secret set CLAUDE_CODE_OAUTH_TOKEN   (from \`claude setup-token\`; or ANTHROPIC_API_KEY with prepaid credit)
  2. Repo Settings → Actions → General: workflow permissions "Read and write", and allow Actions to create PRs
  3. git add -A && git commit && git push, then Actions → config-drift-checker → Run workflow (records the baseline; merge the pin PR it opens)
After that: every PR touching the setup is checked, every Claude Code release is canaried, spend never passes .cdc.yml's cap.`);
