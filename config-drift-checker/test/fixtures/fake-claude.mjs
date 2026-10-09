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
//   FAKE_CLAUDE_FAIL_MODEL     comma-separated --model values whose agent calls answer without "DONE"
//   FAKE_CLAUDE_EARLY_ACCESS   when set, `claude plugin eval` answers like a release without the official runner
//   FAKE_CLAUDE_SLOW     "<text>:<ms>": an agent call whose prompt contains <text> waits <ms> before answering
//   FAKE_CLAUDE_ECHO     when set, the reply quotes the prompt's first line, so a test can tell runs apart
// Every agent call appends a start record and a done record to calls.jsonl; call indices are claimed
// atomically, so concurrent calls never share one.
import { promises as fs, existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args.includes('--version')) { process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '9.9.9'} (Claude Code)\n`); process.exit(0); }

if (args[0] === 'plugin' && args[1] === 'eval' && process.env.FAKE_CLAUDE_EARLY_ACCESS) { console.error('claude plugin eval is in early access'); process.exit(1); }

const fmt = args[args.indexOf('--output-format') + 1];
if (fmt === 'json') { // an LLM-judge call
  out({ type: 'result', result: JSON.stringify({ pass: true, reason: 'fake judge' }) });
  process.exit(0);
}

const state = process.env.FAKE_CLAUDE_STATE;
if (!state) { console.error('fake-claude: FAKE_CLAUDE_STATE not set'); process.exit(3); }
let n = 0;
for (;; n++) { try { await fs.writeFile(path.join(state, `call-${n}`), '', { flag: 'wx' }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; } }
const log = path.join(state, 'calls.jsonl');
await fs.appendFile(log, JSON.stringify({ n, args, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, at: Date.now() }) + '\n');
const prompt = args[args.indexOf('-p') + 1] ?? '';
const [slowText, slowMs] = (process.env.FAKE_CLAUDE_SLOW ?? '').split(':');
if (slowText && prompt.includes(slowText)) await new Promise((r) => setTimeout(r, Number(slowMs)));
process.on('exit', () => { try { appendFileSync(log, JSON.stringify({ n, done: true, at: Date.now() }) + '\n'); } catch {} });

const list = (k) => (process.env[k] ?? '').split(',').filter(Boolean).map(Number);
const model = process.env.FAKE_CLAUDE_MODEL ?? 'claude-sonnet-5';
const cost = Number(process.env.FAKE_CLAUDE_COST ?? 0.1);
const turns = Number(process.env.FAKE_CLAUDE_TURNS ?? 2);

if (list('FAKE_CLAUDE_ERROR').includes(n)) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low', total_cost_usd: 0, num_turns: 0, modelUsage: { [model]: {} } });
  process.exit(1);
}
const failModel = (process.env.FAKE_CLAUDE_FAIL_MODEL ?? '').split(',').filter(Boolean).includes(args[args.indexOf('--model') + 1]);
let text = list('FAKE_CLAUDE_FAIL').includes(n) || failModel ? 'I could not finish this.' : 'DONE — the task is complete.';
if (process.env.FAKE_CLAUDE_ECHO) text += ` [${prompt.split('\n')[0]}]`;
out({ type: 'system', subtype: 'init', model });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'hello', is_error: false }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20 }, num_turns: turns, modelUsage: { [model]: { inputTokens: 100 } } });
