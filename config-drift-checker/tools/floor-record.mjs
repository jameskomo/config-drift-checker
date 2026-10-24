#!/usr/bin/env node
// floor-record: the free floor. When the budget or interval gate skips the paid agent runs, the Action still
// installs the new Claude Code and runs the $0 checks on it: the skill linter, the suite doctor's live load
// check (`--max-cost-usd 0`, zero agent runs) and context-cost. This tool turns those outputs into one
// record per version for the results branch (history/floor/<stamp>-cc<version>.json), so a release the
// budget skipped is a visible gap on the dashboard, never a silent green.
//
//   node tools/floor-record.mjs --version <cc> --reason budget|interval [--track pinned|canary]
//        [--spent <usd>] [--cap <usd>] [--next-allowed <iso>]
//        [--skills <skill-lint --json>] [--suite <suite-doctor --json>] [--context-cost <dir|file>]
//        [--out <record.json>] [--md <summary.md>] [--now <iso>]
//
// Prints key=value lines for $GITHUB_OUTPUT: name (the history/floor file name) and summary (one sentence).
// Missing or unreadable inputs are left out of the record, never guessed. Exit 2 on a usage error.
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
const REASONS = {
  budget: 'monthly budget reached',
  interval: 'too soon after the last scheduled canary',
};
export const reasonText = (r) => REASONS[r] ?? (r ? `skipped: ${r}` : 'not run');

const jsonIf = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The context-cost measurement for this version: a --store file, or the newest one for the version in a --store dir.
export function pickContextCost(p, version) {
  if (!p || !existsSync(p)) return null;
  const files = statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f)) : [p];
  const ms = files.map(jsonIf).filter((j) => j?.tool === 'context-cost' && j.totals);
  const m = ms.filter((j) => !version || j.claudeVersion === version).at(-1) ?? null;
  return m ? { alwaysOn: num(m.totals.alwaysOn), onInvoke: num(m.totals.onInvoke), source: m.source ?? null, claudeVersion: m.claudeVersion ?? null } : null;
}

// What the free checks found, in the few numbers a summary needs.
export function checksOf(skills, suite) {
  const out = {};
  if (skills && typeof skills === 'object') out.skills = { checked: num(skills.skills), errors: num(skills.errors) ?? 0, warnings: num(skills.warnings) ?? 0 };
  if (suite && typeof suite === 'object') {
    const live = suite.live ?? {};
    out.suite = { cases: num(suite.cases), loaded: live.status === 'ok' ? num(live.loaded) : null, confirmed: live.status === 'ok',
      liveStatus: live.status ?? null, liveReason: live.reason ?? null, errors: num(suite.summary?.errors) ?? 0, warnings: num(suite.summary?.warnings) ?? 0 };
  }
  return out;
}

// One plain sentence: what was not tested and why, then what the free checks found.
export const summarize = (rec) => `Behaviour not tested on ${rec.claudeCode} (${reasonText(rec.skip?.reason)}). ${freeChecksText(rec)}`;

// What the free checks found, as one sentence (the second half of the summary; the dashboard reuses it).
export function freeChecksText(rec) {
  const parts = [];
  const s = rec.checks?.suite, sk = rec.checks?.skills, cc = rec.contextCost;
  if (s) {
    if (s.confirmed && s.loaded !== null && s.cases !== null) parts.push(`suite loads ${s.loaded} of ${s.cases}`);
    else parts.push(`suite format checked without the runner (${plural(s.cases ?? 0, 'case')}, loading not confirmed)`);
    if (s.errors) parts.push(`suite has ${plural(s.errors, 'error')}`);
  }
  if (sk && (sk.errors || sk.warnings)) parts.push(`skills have ${sk.errors ? plural(sk.errors, 'error') : plural(sk.warnings, 'warning')}`);
  if (cc?.alwaysOn !== null && cc?.alwaysOn !== undefined) parts.push(`context cost ${cc.alwaysOn} tokens`);
  return parts.length ? `Free checks ran: ${parts.join(', ')}.` : 'The free checks produced no result.';
}

export function buildFloor({ version, reason, track = null, spent = null, cap = null, nextAllowed = null, skills = null, suite = null, contextCost = null, now = new Date().toISOString() }) {
  const rec = {
    schemaVersion: SCHEMA_VERSION, tool: 'floor', generatedAt: now, claudeCode: version, track: track || null,
    skip: { reason: reason || null, spentMonth: num(spent), capMonth: num(cap), nextAllowed: nextAllowed && nextAllowed !== 'none' ? nextAllowed : null },
    preflight: skills || suite ? { skills: skills ?? null, suite: suite ?? null } : null,
    contextCost: contextCost ?? null,
    checks: checksOf(skills, suite),
  };
  rec.summary = summarize(rec);
  return rec;
}

export const floorName = (rec) => `${rec.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-cc${rec.claudeCode}.json`;

// The job-summary block: the sentence, then what to do about it.
export function floorMarkdown(rec) {
  const next = rec.skip?.reason === 'budget'
    ? 'To test behaviour on this release, raise `budget.per_month_usd` in .cdc.yml, wait for next month, or re-run manually with force=true.'
    : rec.skip?.reason === 'interval'
      ? `The next scheduled canary${rec.skip.nextAllowed ? ` after ${rec.skip.nextAllowed}` : ''} tests it, or re-run manually with force=true.`
      : 'Re-run manually with force=true to test behaviour on this release.';
  return `## Agent-config eval: behaviour not tested on Claude Code ${rec.claudeCode}\n\n${rec.summary}\n\n${next} The dashboard and verdicts.json list this release as untested until a behaviour run covers it.\n`;
}

// Every floor record in a directory, oldest first. An unreadable file is not a record.
export function loadFloors(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => jsonIf(path.join(dir, f)))
    .filter((j) => j?.tool === 'floor' && j.claudeCode)
    .sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const usage = 'usage: floor-record.mjs --version <cc> --reason budget|interval [--track t] [--spent usd] [--cap usd] [--next-allowed iso] [--skills f] [--suite f] [--context-cost dir|file] [--out f] [--md f] [--now iso]';
  const VALUE = { '--version': 'version', '--reason': 'reason', '--track': 'track', '--spent': 'spent', '--cap': 'cap', '--next-allowed': 'nextAllowed', '--skills': 'skills', '--suite': 'suite', '--context-cost': 'contextCost', '--out': 'out', '--md': 'md', '--now': 'now' };
  const argv = process.argv.slice(2), opt = {};
  for (let i = 0; i < argv.length; i++) {
    const k = VALUE[argv[i]];
    if (!k || argv[i + 1] === undefined) { console.error(`${k ? `${argv[i]} needs a value` : `unknown option ${argv[i]}`}\n${usage}`); process.exit(2); }
    opt[k] = argv[++i];
  }
  if (!opt.version) { console.error(usage); process.exit(2); }
  const rec = buildFloor({ ...opt, skills: jsonIf(opt.skills), suite: jsonIf(opt.suite), contextCost: pickContextCost(opt.contextCost, opt.version), now: opt.now });
  if (opt.out) await fs.writeFile(opt.out, JSON.stringify(rec, null, 2) + '\n');
  if (opt.md) await fs.writeFile(opt.md, floorMarkdown(rec));
  process.stdout.write(`name=${floorName(rec)}\nsummary=${rec.summary}\n`);
}
