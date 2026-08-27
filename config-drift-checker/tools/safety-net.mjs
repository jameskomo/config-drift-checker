#!/usr/bin/env node
// eval-shim safety net — a PreToolUse(Bash) hook injected into every eval run (both arms).
// Blocks commands with host-global side effects that a throwaway workspace cannot contain.
// A case that must exercise such a command creates a stub binary in <workspace>/.eval-bin/<name>
// (the shim prepends that dir to PATH); when a stub exists for the command's binary, the net allows it.
import { existsSync } from 'node:fs';
import path from 'node:path';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let cmd = '', cwd = process.cwd();
  try { const ev = JSON.parse(raw); cmd = String(ev?.tool_input?.command ?? ''); cwd = ev?.cwd ?? cwd; } catch { process.exit(0); }
  const rules = [
    [/docker(-|\s+)compose\b[^\n|;&]*\bdown\b[^\n|;&]*(\s-v\b|--volumes\b)|docker(-|\s+)compose\b[^\n|;&]*(\s-v\b|--volumes\b)[^\n|;&]*\bdown\b/, 'docker compose down -v (project-named stacks are host-global)'],
    [/\bdocker\s+(system|volume|container|image)\s+prune\b|\bdocker\s+volume\s+rm\b|\bdocker\s+rm\s+-[a-z]*f/, 'docker prune/rm'],
    [/\bgit\s+push\b[^\n|;&]*(--force\b|-f\b|--force-with-lease\b|--delete\b)/, 'git push --force/--delete to a real remote'],
    [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, 'recursive delete outside the workspace'],
    [/\b(DROP|TRUNCATE)\s+(DATABASE|TABLE|SCHEMA)\b/i, 'destructive SQL'],
    [/\bkubectl\s+delete\b|\bterraform\s+(destroy|apply)\b|\bgcloud\b[^\n|;&]*\bdelete\b|\baws\b[^\n|;&]*\b(delete|terminate)\b/, 'cloud/cluster mutation'],
    [/\bsystemctl\s+(stop|disable|restart)\b|\bkill(all)?\s+-9\b|\bpkill\b/, 'process/service control on the host'],
  ];
  for (const [re, why] of rules) {
    if (!re.test(cmd)) continue;
    const bin = (cmd.trim().match(/^(?:sudo\s+)?([\w.-]+)/) ?? [])[1];
    if (bin && existsSync(path.join(cwd, '.eval-bin', bin))) process.exit(0); // stubbed by the case's scaffold
    process.stderr.write(`[eval-shim safety net] blocked: ${why}. Sandboxes do not contain host-global effects. Stub the binary in .eval-bin/ if the case must run it.\n`);
    process.exit(2);
  }
  process.exit(0);
});
