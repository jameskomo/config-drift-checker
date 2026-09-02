#!/usr/bin/env node
// A stand-in for the `claude` CLI so the shim can be exercised end to end without an API key or a cent of spend.
// Behaviour is driven by env:
//   FAKE_CLAUDE_STATE    dir for the call counter and calls.jsonl (required for agent calls)
//   FAKE_CLAUDE_VERSION  what `claude --version` prints (default 9.9.9)
//   FAKE_CLAUDE_MODEL    resolved model id reported in modelUsage (default claude-sonnet-5)
//   FAKE_CLAUDE_COST     total_cost_usd per agent call (default 0.1)
//   FAKE_CLAUDE_TURNS    num_turns per agent call (default 2)
//   FAKE_CLAUDE_FAIL     comma-separated agent-call indices (0-based) that answer without "DONE"
//   FAKE_CLAUDE_ERROR    comma-separated agent-call indices that return an is_error result (e.g. credit exhausted)
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args.includes('--version')) { process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '9.9.9'} (Claude Code)\n`); process.exit(0); }

const fmt = args[args.indexOf('--output-format') + 1];
if (fmt === 'json') { // an LLM-judge call
  out({ type: 'result', result: JSON.stringify({ pass: true, reason: 'fake judge' }) });
  process.exit(0);
}

const state = process.env.FAKE_CLAUDE_STATE;
if (!state) { console.error('fake-claude: FAKE_CLAUDE_STATE not set'); process.exit(3); }
const counter = path.join(state, 'n');
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
await fs.writeFile(counter, String(n + 1));
await fs.appendFile(path.join(state, 'calls.jsonl'), JSON.stringify({ n, args, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\n');

const list = (k) => (process.env[k] ?? '').split(',').filter(Boolean).map(Number);
const model = process.env.FAKE_CLAUDE_MODEL ?? 'claude-sonnet-5';
const cost = Number(process.env.FAKE_CLAUDE_COST ?? 0.1);
const turns = Number(process.env.FAKE_CLAUDE_TURNS ?? 2);

if (list('FAKE_CLAUDE_ERROR').includes(n)) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low', total_cost_usd: 0, num_turns: 0, modelUsage: { [model]: {} } });
  process.exit(1);
}
const text = list('FAKE_CLAUDE_FAIL').includes(n) ? 'I could not finish this.' : 'DONE — the task is complete.';
out({ type: 'system', subtype: 'init', model });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'hello', is_error: false }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20 }, num_turns: turns, modelUsage: { [model]: { inputTokens: 100 } } });
