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
//   FAKE_CLAUDE_MCP      JSON list of { tool, input }: MCP calls to make, for real, against the servers in
//                        --mcp-config (spawned and spoken to over stdio); a tool with no server is "unavailable"
// Every agent call appends a start record and a done record to calls.jsonl; call indices are claimed
// atomically, so concurrent calls never share one.
import { promises as fs, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const mcpConfig = args.includes('--mcp-config') ? readJson(args[args.indexOf('--mcp-config') + 1]) : null;
const pluginManifest = args.includes('--plugin-dir') ? readJson(path.join(args[args.indexOf('--plugin-dir') + 1], '.claude-plugin/plugin.json')) : null;
await fs.appendFile(log, JSON.stringify({ n, args, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, at: Date.now(), mcpConfig, pluginManifest }) + '\n');
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
// MCP calls: initialize, tools/list (the tool must be listed), tools/call, exactly as a client would
for (const [k, call] of JSON.parse(process.env.FAKE_CLAUDE_MCP ?? '[]').entries()) {
  const id = `toolu_mcp_${k}`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: call.tool, input: call.input }] } });
  const cut = call.tool.lastIndexOf('__');
  const server = mcpConfig?.mcpServers?.[call.tool.slice(5, cut)];
  const res = server ? await mcpCall(server, call.tool.slice(cut + 2), call.input) : null;
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: res ? res.content : `No such tool available: ${call.tool}`, is_error: res ? !!res.isError : true }] } });
}
async function mcpCall(server, tool, input) {
  const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = (await rpc(2, 'tools/list', {})).result.tools;
  const r = listed.some((t) => t.name === tool) ? (await rpc(3, 'tools/call', { name: tool, arguments: input })).result : null;
  child.kill();
  return r;
}
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'hello', is_error: false }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20 }, num_turns: turns, modelUsage: { [model]: { inputTokens: 100 } } });
