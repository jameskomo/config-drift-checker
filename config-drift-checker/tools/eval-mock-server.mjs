#!/usr/bin/env node
// eval-mock-server: a stdio MCP server that answers type: fixed mocks (tools/eval-mocks.mjs) for one
// eval run. The shim writes a spec file and registers this under the server's own name, so the agent
// sees the same tool names as with the real server.
//
//   node eval-mock-server.mjs <spec.json>
//   spec: { dir, tools: [{ name, description, inputSchema, body, error, expect, dir }] }
//
// A call that breaks the tool's expect: guard gets a tool error starting with ABORT_PREFIX; the shim
// finds it in the trace and scores the run 0 as aborted, which is the official verdict for it.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { ABORT_PREFIX, checkExpect, renderMock } from './eval-mocks.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const text = (t, isError) => ({ content: [{ type: 'text', text: t }], isError });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications need no answer
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `eval-mock-${spec.dir}`, version: '1.0.0' } });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: spec.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === 'tools/call') {
    const t = spec.tools.find((x) => x.name === params?.name);
    if (!t) return reply(text(`no mock answers ${params?.name}`, true));
    const input = params.arguments ?? {};
    const broken = t.expect ? checkExpect(input, t.expect) : null;
    if (broken) return reply(text(`${ABORT_PREFIX} ${spec.dir}/${t.name}: ${broken}`, true));
    return reply(text(renderMock(t.body, input, t.dir), !!t.error));
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
