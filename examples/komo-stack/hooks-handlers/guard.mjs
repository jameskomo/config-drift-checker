#!/usr/bin/env node
// PreToolUse guard for Bash. Reads the hook event from stdin; exits 2 with a
// reason on stderr to block the command (Claude sees the reason and must adapt).
// Rules are deliberately narrow: destructive git history rewrites and
// recursive deletes outside the working tree.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = String(JSON.parse(raw)?.tool_input?.command ?? ''); } catch { /* not JSON: allow */ }
  const rules = [
    [/\bgit\s+push\b[^\n|;&]*(--force\b|-f\b|--force-with-lease\b)/, 'force-pushing is blocked by komo-stack guard; ask the user to push manually'],
    [/\bgit\s+reset\s+--hard\b/, 'git reset --hard is blocked by komo-stack guard; use git stash or a new branch'],
    [/\bgit\s+clean\s+-[a-z]*f/, 'git clean -f is blocked by komo-stack guard'],
    [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, 'recursive delete outside the working tree is blocked by komo-stack guard'],
  ];
  for (const [re, reason] of rules) {
    if (re.test(cmd)) { process.stderr.write(`BLOCKED: ${reason}\n`); process.exit(2); }
  }
  process.exit(0);
});
