import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/cdc-bootstrap.mjs', import.meta.url).pathname;

// a fake claude: --version prints a version; `plugin eval init --bare <name>` writes the template;
// `-p <setup prompt>` simulates the agent writing evals + .cdc.yml
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a[0] === 'plugin' && a[2] === 'init') {
  const name = a[a.indexOf('--bare') + 1];
  fs.mkdirSync(path.join('evals', name, 'graders'), { recursive: true });
  fs.writeFileSync(path.join('evals', name, 'prompt.md'), '---\\nruns: 3\\n---\\nprompt here\\n');
  process.exit(0);
}
if (a[0] === '-p') {
  fs.mkdirSync('evals/agent-case/graders', { recursive: true });
  fs.writeFileSync('evals/agent-case/prompt.md', '---\\nruns: 3\\n---\\nagent wrote this\\n');
  fs.writeFileSync('.cdc.yml', 'track: pinned\\n');
  console.log('checklist printed');
  process.exit(0);
}
process.exit(1);
`;

async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-bin-'));
  await fs.writeFile(path.join(bin, 'claude'), FAKE, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { dir, env };
}
const boot = (dir, env, args = []) => spawnSync('node', [TOOL, dir, ...args], { encoding: 'utf8', env });

test('no-agent mode scaffolds manifest, starter case, .cdc.yml, workflow, checklist; zero agent runs', async () => {
  const { dir, env } = await repo();
  const r = boot(dir, env, ['--no-agent']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, '.claude-plugin/plugin.json')), 'manifest synthesized');
  assert.ok(existsSync(path.join(dir, 'evals/starter-case/prompt.md')), 'bare starter case');
  assert.ok(existsSync(path.join(dir, '.cdc.yml')), '.cdc.yml written');
  const cdc = await fs.readFile(path.join(dir, '.cdc.yml'), 'utf8');
  assert.match(cdc, /9\.9\.9/, 'harness pinned to installed claude');
  assert.ok(existsSync(path.join(dir, '.github/workflows/config-drift-checker.yml')), 'workflow copied');
  assert.match(r.stdout, /What only you can do now/);
  assert.match(r.stdout, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('idempotent: a second run overwrites nothing', async () => {
  const { dir, env } = await repo();
  boot(dir, env, ['--no-agent']);
  await fs.writeFile(path.join(dir, '.cdc.yml'), 'track: pinned # MINE\n');
  const r2 = boot(dir, env, ['--no-agent']);
  assert.equal(r2.status, 0);
  assert.match(await fs.readFile(path.join(dir, '.cdc.yml'), 'utf8'), /MINE/, 'existing .cdc.yml kept');
});

test('agent mode runs the setup skill headlessly and still ensures the workflow', async () => {
  const { dir, env } = await repo();
  const r = boot(dir, env, ['--budget', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, 'evals/agent-case/prompt.md')), 'agent-written case present');
  assert.ok(existsSync(path.join(dir, '.github/workflows/config-drift-checker.yml')), 'workflow ensured');
  assert.match(r.stdout, /agent \(budget \$1\)/);
});

test('fails plainly outside a git repo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-nogit-'));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-bin2-'));
  await fs.writeFile(path.join(bin, 'claude'), FAKE, { mode: 0o755 });
  const r = spawnSync('node', [TOOL, dir], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git repository/);
});
