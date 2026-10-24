// The Marketplace mirror is built by scripts/build-action-mirror.sh. Every path its action.yml uses must
// exist inside the mirror: a broken path there fails only for Marketplace users, never in our own CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');

test('mirror: every tool, skill and plugin path action.yml uses resolves inside the mirror', () => {
  const dst = mkdtempSync(path.join(os.tmpdir(), 'cdc-mirror-'));
  try {
    execFileSync('bash', [path.join(repo, 'scripts/build-action-mirror.sh'), dst], { stdio: 'pipe' });
    const yml = readFileSync(path.join(dst, 'action.yml'), 'utf8');
    assert.doesNotMatch(yml, /\.\.\/config-drift-checker/, 'no path may leave the mirror');
    const tools = yml.match(/tools="\$ACTION_PATH\/([^"]+)"/)[1];
    assert.ok(existsSync(path.join(dst, tools)), `tools dir ${tools}`);
    for (const t of new Set([...yml.matchAll(/\$TOOLS\/([\w-]+\.mjs)/g)].map((m) => m[1]))) assert.ok(existsSync(path.join(dst, tools, t)), `tool ${t}`);
    for (const m of yml.matchAll(/plugin="\$ACTION_PATH\/([^"]+)"/g)) {
      assert.ok(existsSync(path.join(dst, m[1], '.claude-plugin/plugin.json')), `plugin manifest under ${m[1]}`);
      assert.ok(existsSync(path.join(dst, m[1], 'skills/repair/SKILL.md')), `repair skill under ${m[1]}`);
    }
  } finally { rmSync(dst, { recursive: true, force: true }); }
});
