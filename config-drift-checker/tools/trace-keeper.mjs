#!/usr/bin/env node
// trace-keeper — harvest the official runner's ephemeral traces into its result JSON.
//
// `claude plugin eval` writes each run's transcript (tool calls, the response) to a temp
// trace.jsonl and deletes it when the command exits, so the JSON you keep can't say what the
// agent actually did. Run the eval with --keep-temp, then this, and the transcript evidence is
// written inline (the fields normalizeResult otherwise leaves null): refusal labelling and
// tool-use analysis then work on official-runner results too.
//
//   claude plugin eval . --keep-temp --json out.json
//   node trace-keeper.mjs out.json [--traces-dir <dir>] [--clean]
//
// For each run whose tracePath still exists: parse the stream-json trace, add toolUses,
// response, numTurns and model to the run, copy the trace next to the JSON (default
// <json dir>/traces/), and rewrite tracePath to the kept copy. --clean removes the runner's
// temp dirs after harvesting. Idempotent: enriched runs and missing traces are left alone.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function parseTrace(text) {
  const texts = [], toolUses = [];
  let result = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') for (const b of e.message?.content ?? []) {
      if (b.type === 'text' && b.text) texts.push(b.text);
      if (b.type === 'tool_use') toolUses.push({ tool: b.name, input: typeof b.input === 'string' ? b.input : JSON.stringify(b.input).slice(0, 500) });
    }
    if (e.type === 'result') result = e;
  }
  return {
    toolUses, response: texts.join('\n\n'),
    numTurns: result?.num_turns ?? null,
    model: result?.modelUsage ? Object.keys(result.modelUsage)[0] : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let file = null, tracesDir = null, clean = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--traces-dir') tracesDir = path.resolve(argv[++i]);
    else if (a === '--clean') clean = true;
    else if (!a.startsWith('--')) file = path.resolve(a);
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  if (!file) { console.error('usage: trace-keeper.mjs <out.json> [--traces-dir dir] [--clean]'); process.exit(2); }
  const j = JSON.parse(await fs.readFile(file, 'utf8'));
  const dest = tracesDir ?? path.join(path.dirname(file), 'traces');
  let harvested = 0, gone = 0, already = 0;
  const tempRoots = new Set();
  for (const c of j.cases ?? []) {
    const caseName = String(c.dir ?? c.name ?? 'case').split('/').pop();
    for (const [arm, runs] of Object.entries(c.arms ?? {})) {
      for (let i = 0; i < (runs ?? []).length; i++) {
        const r = runs[i];
        if (r.toolUses !== undefined) { already++; continue; }
        if (!r.tracePath || !existsSync(r.tracePath)) { gone++; continue; }
        const parsed = parseTrace(await fs.readFile(r.tracePath, 'utf8'));
        const kept = path.join(dest, `${caseName}-${arm}-${i}.jsonl`);
        await fs.mkdir(dest, { recursive: true });
        await fs.copyFile(r.tracePath, kept);
        // /tmp/claude-eval-XXXX/out/trace.jsonl → the claude-eval-XXXX root
        const root = path.dirname(path.dirname(r.tracePath));
        if (path.basename(root).startsWith('claude-eval-')) tempRoots.add(root);
        Object.assign(r, parsed, { tracePath: kept });
        harvested++;
      }
    }
  }
  await fs.writeFile(file, JSON.stringify(j, null, 2) + '\n');
  let cleaned = 0, uncleanable = 0;
  // best-effort: a sandboxed or permission-locked subdir must not fail the harvest (the JSON is
  // already written by now); a leftover temp dir is /tmp litter, not data loss
  if (clean) for (const root of tempRoots) { try { await fs.rm(root, { recursive: true, force: true }); cleaned++; } catch { uncleanable++; } }
  console.log(`trace-keeper: ${harvested} run(s) enriched${already ? `, ${already} already had evidence` : ''}${gone ? `, ${gone} trace(s) already deleted (run the eval with --keep-temp)` : ''}${clean ? `, ${cleaned} temp dir(s) removed${uncleanable ? `, ${uncleanable} left behind (permissions)` : ''}` : ''}`);
  if (harvested === 0 && gone > 0) process.exit(1);
}
