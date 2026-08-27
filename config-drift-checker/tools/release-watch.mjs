#!/usr/bin/env node
// release-watch — has @anthropic-ai/claude-code (or any npm package) published a new version since we last ran?
//
//   node tools/release-watch.mjs [--package @anthropic-ai/claude-code] [--state <file>] [--update]
//
// Prints `changed=true|false`, `version=<latest>`, `previous=<stored>` (GitHub-output style) to stdout.
// --update writes the latest version to the state file. Exit code is always 0 (the caller decides).
import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = { package: '@anthropic-ai/claude-code', state: '.claude-code-version', update: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--package') opt.package = argv[++i];
  else if (argv[i] === '--state') opt.state = argv[++i];
  else if (argv[i] === '--update') opt.update = true;
}
const latest = execFileSync('npm', ['view', opt.package, 'version'], { encoding: 'utf8' }).trim();
const previous = existsSync(opt.state) ? (await fs.readFile(opt.state, 'utf8')).trim() : '';
const changed = latest !== previous;
if (opt.update && changed) await fs.writeFile(opt.state, latest + '\n');
process.stdout.write(`changed=${changed}\nversion=${latest}\nprevious=${previous || 'none'}\n`);
