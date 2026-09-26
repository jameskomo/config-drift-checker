#!/usr/bin/env node
// drift-digest — the week in one block, and the social post already written.
//
//   node tools/drift-digest.mjs <drift-docs-dir> [--md digest.md] [--post post.txt] [--days 7]
//
// Reads what the dashboard already published (verdicts.json, spend.json) and writes:
//   digest.md  — a paste-ready weekly summary (Slack, a standup, an email): verdicts in the
//                window, the streak, month spend
//   post.txt   — the social post for the NEWEST verdict, in the product's plain voice:
//                a calm one when behaviour held, an urgent one naming the moved cases when not
// The publish workflow regenerates both on its schedule, so "write the weekly update" and
// "announce the release verdict" stop being manual work: copy from the published files.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let dir = null, mdOut = null, postOut = null, days = 7;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--md') mdOut = argv[++i];
  else if (a === '--post') postOut = argv[++i];
  else if (a === '--days') days = Number(argv[++i]);
  else if (!a.startsWith('--')) dir = path.resolve(a);
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (!dir) { console.error('usage: drift-digest.mjs <drift-docs-dir> [--md digest.md] [--post post.txt] [--days 7]'); process.exit(2); }

const readJson = async (f) => { try { return JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { return null; } };
const v = await readJson('verdicts.json');
if (!v) { console.error(`no verdicts.json in ${dir} — run eval-dashboard first`); process.exit(1); }
const spend = await readJson('spend.json');

const now = Date.now();
const windowV = v.verdicts.filter((x) => x.at && now - new Date(x.at).getTime() <= days * 86400000);
const month = new Date().toISOString().slice(0, 7);
const spent = spend?.months?.[month]?.usd ?? null;
const page = v.pageUrl ? v.pageUrl.replace(/\/$/, '') + '/' : null;
const icon = (x) => (x.verdict === 'held' ? '●' : x.verdict === 'drift' ? '▼' : '■');

const digest = [
  `## Agent-config drift digest · ${v.suite} · last ${days} days`,
  '',
  windowV.length
    ? windowV.map((x) => `- ${icon(x)} Claude Code **${x.claudeCode}**: ${x.verdict === 'held' ? 'behaviour held' : x.verdict === 'drift' ? `drift on ${x.casesMoved.join(', ')}` : 'runs errored'} (overall ${x.overall === null ? 'n/a' : Number(x.overall).toFixed(2)}, ${x.track} track)`).join('\n')
    : `- No Claude Code releases reached the suite in this window. The streak stands.`,
  '',
  `Streak: **${v.streak.versions} release${v.streak.versions === 1 ? '' : 's'} clean** across ${v.streak.runs} runs, about ${v.streak.days} days.` +
    (spent !== null ? ` Spend this month: $${spent.toFixed(2)}.` : ''),
  page ? `\nObservatory: ${page} · feed: ${page}feed.xml` : '',
].join('\n');

const newest = v.verdicts[0] ?? null;
let post = '';
if (newest) {
  if (newest.verdict === 'held') {
    post = `Claude Code ${newest.claudeCode} tested against our reference agent setup: behaviour held. That makes ${v.streak.versions} release${v.streak.versions === 1 ? '' : 's'} clean in a row (~${v.streak.days} days).

Every release gets this treatment, automatically.${page ? ` Verdicts feed: ${page}feed.xml` : ''}`;
  } else if (newest.verdict === 'drift') {
    post = `Claude Code ${newest.claudeCode} changed agent behaviour. Our reference suite caught it: ${newest.casesMoved.join(', ')} regressed (overall ${newest.overall === null ? 'n/a' : Number(newest.overall).toFixed(2)}).

This is the silent breakage we built for. Full report, unedited:${newest.report && page ? ` ${page}${newest.report}` : page ? ` ${page}` : ''}

If your team runs a Claude Code setup, check yours before your developers do.`;
  } else {
    post = `Our canary for Claude Code ${newest.claudeCode} errored before scoring; nothing was stored and the baseline stands. Post held until a clean run.`;
  }
}

console.log(digest);
if (mdOut) await fs.writeFile(mdOut, digest + '\n');
if (postOut && post) await fs.writeFile(postOut, post + '\n');
if (postOut) console.error(`→ ${postOut}`);
