import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTrace } from '../tools/trace-keeper.mjs';

const TOOL = new URL('../tools/trace-keeper.mjs', import.meta.url).pathname;

const TRACE = [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { command: 'spring-boot-conventions' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'public class InvoiceController {}' }] } },
  { type: 'result', num_turns: 3, modelUsage: { 'claude-sonnet-5': {} } },
].map((e) => JSON.stringify(e)).join('\n');

test('parseTrace: tool uses, response, turns, model from stream-json', () => {
  const p = parseTrace(TRACE);
  assert.deepEqual(p.toolUses, [{ tool: 'Skill', input: '{"command":"spring-boot-conventions"}' }]);
  assert.match(p.response, /InvoiceController/);
  assert.equal(p.numTurns, 3); assert.equal(p.model, 'claude-sonnet-5');
});

test('harvest: enriches runs in place, copies traces, is idempotent, flags all-gone traces', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keeper-'));
  const temp = path.join(dir, 'claude-eval-XYZ/out'); await fs.mkdir(temp, { recursive: true });
  const tracePath = path.join(temp, 'trace.jsonl'); await fs.writeFile(tracePath, TRACE);
  const out = path.join(dir, 'out.json');
  const native = { schemaVersion: 1, suite: { root: '/x' }, cases: [{ name: 'a', dir: 'evals/a', arms: { with: [{ score: 1, turns: 3, error: null, tracePath }] } }] };
  await fs.writeFile(out, JSON.stringify(native));

  const r = spawnSync('node', [TOOL, out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 run\(s\) enriched/);
  const j = JSON.parse(await fs.readFile(out, 'utf8'));
  const run0 = j.cases[0].arms.with[0];
  assert.equal(run0.toolUses.length, 1); assert.equal(run0.numTurns, 3); assert.equal(run0.model, 'claude-sonnet-5');
  assert.ok(existsSync(run0.tracePath), 'trace copied next to the JSON');
  assert.notEqual(run0.tracePath, tracePath);

  const again = spawnSync('node', [TOOL, out], { encoding: 'utf8' });
  assert.match(again.stdout, /1 already had evidence/);

  // a fresh result whose trace was already deleted: nothing harvested, exit 1
  const out2 = path.join(dir, 'out2.json');
  await fs.writeFile(out2, JSON.stringify({ schemaVersion: 1, suite: { root: '/x' }, cases: [{ name: 'a', dir: 'evals/a', arms: { with: [{ score: 1, tracePath: path.join(dir, 'nope/trace.jsonl') }] } }] }));
  const r2 = spawnSync('node', [TOOL, out2], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /already deleted/);
});
