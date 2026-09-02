#!/usr/bin/env node
// canary-promote — turn a run of green canaries into a pull request that bumps the pins.
//
//   node tools/canary-promote.mjs --config <plugin-dir> --result <aggregate-result.json> --regressed <n>
//        [--streak <canary/streak.json>] [--diff-md <diff.md>] [--out <decision.json>] [--now <iso>]
//     → prints  kind=bump|pin|none  branch=…  title=…  model=…  harness=…  greens=<n>  and writes the new streak
//       to --streak and the PR body to <out dir>/pr-body.md when there is something to open.
//
// bump: the canary track was green `promote_after` times in a row on the same model + Claude Code version,
//       and that pair differs from what .cdc.yml pins → open a PR moving the pins there. Never auto-merged.
// pin:  the pinned track ran green but .cdc.yml declares no pin → open a PR pinning what the baseline
//       actually measured, so the next release cannot silently move the baseline.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveTrack } from './cdc-config.mjs';

export const emptyStreak = () => ({ model: null, harness: null, greens: 0, lastRunAt: null, lastResult: null, history: [] });

// Pure. run = { green, model, harness, at, overall, passed, caseCount, costUsd, harnessAlias }
export function advance(streak, run, track, pins) {
  const s = { ...(streak ?? emptyStreak()), history: [...(streak?.history ?? [])] };
  const same = s.model === run.model && s.harness === run.harness;
  if (!run.green) { s.greens = 0; s.lastResult = 'red'; }
  else { s.greens = same ? s.greens + 1 : 1; s.lastResult = 'green'; }
  s.model = run.model; s.harness = run.harness; s.lastRunAt = run.at;
  s.history.push({ at: run.at, green: run.green, model: run.model, harness: run.harness, overall: run.overall, passed: run.passed, caseCount: run.caseCount, costUsd: run.costUsd });
  s.history = s.history.slice(-20);

  let decision = { kind: 'none' };
  if (track.track === 'canary' && run.green && s.greens >= track.promoteAfter) {
    const differs = run.model !== pins.model || (run.harness && String(run.harness) !== String(pins.harness));
    if (differs && run.model) decision = { kind: 'bump', model: run.model, harness: run.harness };
  }
  if (track.track === 'pinned' && run.green && !pins.modelIsPinned && run.model) decision = { kind: 'pin', model: run.model, harness: run.harness };
  if (decision.kind !== 'none') { decision.branch = `cdc/${decision.kind}-${slug(decision.model)}-cc${slug(decision.harness ?? 'latest')}`; s.greens = 0; s.openedAt = run.at; }
  return { streak: s, decision };
}
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

export function prText(decision, streak, track, pins, { diffMd = '', repo = '' } = {}) {
  const runs = streak.history.filter((h) => h.model === decision.model && h.harness === decision.harness && h.green).slice(-track.promoteAfter);
  const title = decision.kind === 'bump'
    ? `Bump pins: ${decision.model} on Claude Code ${decision.harness ?? 'latest'} passed the canary ${runs.length}× in a row`
    : `Pin the baseline to ${decision.model} on Claude Code ${decision.harness ?? 'latest'}`;
  const table = ['| when | overall | passed | cost |', '|---|---|---|---|', ...streak.history.slice(-5).map((h) => `| ${h.at.slice(0, 16).replace('T', ' ')} | ${h.overall === null || h.overall === undefined ? '—' : h.overall.toFixed(2)}${h.green ? ' ✅' : ' ❌'} | ${h.passed ?? '—'}/${h.caseCount ?? '—'} | $${(h.costUsd ?? 0).toFixed(2)} |`)].join('\n');
  const body = decision.kind === 'bump'
    ? `The **canary** track (\`model.canary\` alias, latest Claude Code) resolved to **${decision.model}** on **Claude Code ${decision.harness ?? 'latest'}** and passed every case ${runs.length} time${runs.length === 1 ? '' : 's'} in a row (\`canary.promote_after: ${track.promoteAfter}\`).\n\nThis PR moves the **pinned** baseline there:\n\n| | before | after |\n|---|---|---|\n| \`model.pinned\` | \`${pins.model ?? 'null'}\` | \`${decision.model}\` |\n| \`harness.pinned\` | \`${pins.harness ?? 'null'}\` | \`${decision.harness ?? 'latest'}\` |\n\nMerge to make future PR checks measure against this model and version. Close to keep the current pins; the canary keeps running and will propose again after the next ${track.promoteAfter} greens.\n\n### Recent canary runs\n${table}\n${diffMd ? `\n### Last canary vs current baseline\n${diffMd}\n` : ''}\n<sub>Opened by [config-drift-checker](https://github.com/jameskomo/config-drift-checker)${repo ? ` for ${repo}` : ''}. Never auto-merged.</sub>`
    : `The **pinned** track ran green, but \`.cdc.yml\` declares no \`model.pinned\`, so the baseline currently floats on the \`${pins.model}\` alias — the next Claude Code or model release would move it silently.\n\nThis PR pins what the baseline actually measured:\n\n| | before | after |\n|---|---|---|\n| \`model.pinned\` | \`null\` | \`${decision.model}\` |\n| \`harness.pinned\` | \`${pins.harness ?? 'null'}\` | \`${decision.harness ?? 'latest'}\` |\n\nFrom here the canary track watches the alias and proposes bumps; the pinned track only changes through a PR like this one.\n\n### Run\n${table}\n\n<sub>Opened by [config-drift-checker](https://github.com/jameskomo/config-drift-checker)${repo ? ` for ${repo}` : ''}. Never auto-merged.</sub>`;
  return { title, body };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rest = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const pluginDir = path.resolve(flag('--config') ?? '.');
  const cfg = loadConfig(pluginDir);
  const result = JSON.parse(await fs.readFile(flag('--result'), 'utf8'));
  const track = resolveTrack(cfg, result.track ?? cfg.track);
  const pins = { model: cfg.model?.pinned ?? null, harness: cfg.harness?.pinned != null ? String(cfg.harness.pinned) : null, modelIsPinned: cfg.model?.pinned != null };
  const streakPath = flag('--streak');
  const streak = streakPath && existsSync(streakPath) ? JSON.parse(await fs.readFile(streakPath, 'utf8')) : emptyStreak();
  const a = result.aggregates ?? {};
  const green = Number(flag('--regressed') ?? 0) === 0 && !(a.erroredRuns > 0) && !(a.budget?.exceeded) && a.overallScore !== null && a.overallScore !== undefined && (a.failed ?? 0) === 0;
  const run = { green, model: (a.resolvedModels ?? [])[0] ?? null, harness: result.harness?.version ?? null, at: flag('--now') ?? new Date().toISOString(), overall: a.overallScore ?? null, passed: a.passed ?? null, caseCount: result.suite?.caseCount ?? (result.cases ?? []).length, costUsd: a.costUsd ?? 0 };
  const { streak: next, decision } = advance(streak, run, track, pins);
  if (streakPath) { await fs.mkdir(path.dirname(streakPath), { recursive: true }); await fs.writeFile(streakPath, JSON.stringify(next, null, 2) + '\n'); }
  const out = { kind: decision.kind, branch: decision.branch ?? '', model: decision.model ?? '', harness: decision.harness ?? '', greens: next.greens, green, title: '' };
  if (decision.kind !== 'none') {
    const diffMd = flag('--diff-md') && existsSync(flag('--diff-md')) ? await fs.readFile(flag('--diff-md'), 'utf8') : '';
    const { title, body } = prText(decision, next, track, pins, { diffMd, repo: process.env.GITHUB_REPOSITORY ?? '' });
    out.title = title;
    const outFile = flag('--out') ?? 'canary-decision.json';
    await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({ ...decision, title, greens: next.greens }, null, 2) + '\n');
    await fs.writeFile(path.join(path.dirname(path.resolve(outFile)), 'pr-body.md'), body + '\n');
    out.body_file = path.join(path.dirname(path.resolve(outFile)), 'pr-body.md');
  }
  process.stdout.write(Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
