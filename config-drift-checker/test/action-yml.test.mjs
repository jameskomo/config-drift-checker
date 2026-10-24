import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The composite Action lives next to the plugin in this repo; the npm package does not ship it.
const ACTION = new URL('../../action/action.yml', import.meta.url).pathname;
const text = existsSync(ACTION) ? readFileSync(ACTION, 'utf8') : null;
const skip = text ? false : 'action/action.yml is not in this checkout';

// Each `run: |` block with its step id, by indentation (no YAML dependency).
function runBlocks(src) {
  const lines = src.split('\n'), out = [];
  let id = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*- id: ([\w-]+)/); if (m) id = m[1];
    const r = lines[i].match(/^(\s*)run: \|\s*$/);
    if (!r) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)[0].length > r[1].length); j++) body.push(lines[j]);
    out.push({ id, body: body.join('\n') });
  }
  return out;
}

test('action.yml: no ${{ }} inside any run: block, every block parses as bash', { skip }, () => {
  const blocks = runBlocks(text);
  assert.ok(blocks.length > 10);
  for (const b of blocks) {
    assert.ok(!b.body.includes('${{'), `step ${b.id}: inputs reach run: through env:, never \${{ }}`);
    const r = spawnSync('bash', ['-n'], { input: b.body, encoding: 'utf8' });
    assert.equal(r.status, 0, `step ${b.id}: ${r.stderr}`);
  }
});

test('action.yml: every steps.<id> reference names a step that exists', { skip }, () => {
  const ids = new Set([...text.matchAll(/^\s*- id: ([\w-]+)/gm)].map((m) => m[1]));
  for (const m of text.matchAll(/steps\.([\w-]+)\.(outputs|outcome)/g)) assert.ok(ids.has(m[1]), `unknown step ${m[1]}`);
});

test('action.yml: the free floor runs only on a skip, once per version, and stores a floor record', { skip }, () => {
  const step = (id) => text.split(/\n(?=\s*- (?:id|uses):)/).find((s) => s.includes(`- id: ${id}\n`)) ?? '';
  assert.match(step('floor-plan'), /if: steps\.gate\.outputs\.skipped == 'true' && inputs\.preflight != 'off'/);
  assert.match(step('floor-plan'), /git ls-tree --name-only "origin\/\$BRANCH" history\/ history\/floor\//, 'deduped against the results branch');
  assert.match(step('install'), /steps\.floor-plan\.outputs\.run == 'true'/);
  for (const id of ['preflight', 'context-cost']) assert.match(step(id), /steps\.floor-plan\.outputs\.run == 'true'/, `${id} is part of the floor`);
  for (const id of ['runner', 'run', 'diff', 'report', 'store']) assert.doesNotMatch(step(id), /floor-plan/, `${id} never runs on a skip`);
  assert.match(step('floor'), /floor-record\.mjs/);
  assert.match(step('floor'), /history\/floor\/\$name/);
  assert.match(text, /floor:\s+\{ description: .*value: '\$\{\{ steps\.floor\.outputs\.ran \}\}' \}/);
  assert.match(text, /untested-version:\s*\{ description: .*value: '\$\{\{ steps\.floor\.outputs\.untested_version \}\}' \}/);
});
