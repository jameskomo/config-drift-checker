#!/usr/bin/env node
// cdc-config — reads `.cdc.yml` at the plugin root: tracks (pinned vs canary), budgets, thresholds.
//
//   node tools/cdc-config.mjs <plugin-dir> get <dotted.key>              print one value
//   node tools/cdc-config.mjs <plugin-dir> resolve <pinned|canary> [--github-output]
//   node tools/cdc-config.mjs <plugin-dir> set-pins [--model <id>] [--harness <ver>]   rewrite pins in place
//   node tools/cdc-config.mjs <plugin-dir> init [--model <id>] [--harness <ver>]       write a starter file
//
// Zero dependencies: the YAML subset here is nested maps (2-space indent), scalars, `[a, b]` lists,
// `{ a: 1 }` inline maps, `- item` block lists and `#` comments. Everything the file needs, nothing more.
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.cdc.yml';

export const DEFAULTS = Object.freeze({
  track: 'pinned',
  agent: 'claude',
  model: { pinned: null, canary: 'sonnet' },
  harness: { pinned: null, canary: 'latest' },
  judge_model: 'haiku',
  pinned: { runs: null, expand_on_deviation: 0 },
  canary: { runs: 1, expand_on_deviation: 2, promote_after: 2, min_interval_hours: 72 },
  thresholds: { score: 0.15, turns: 0.5, cost: 0.5, duration: 0.5 },
  fail_on: ['score'],
  budget: { per_run_usd: 2, per_month_usd: 10 },
  noise: { history_runs: 10 },
  baseline: { min_runs: 3 },
});

// ---------- YAML subset ----------
export function parseYaml(src) {
  const lines = src.split(/\r?\n/).map((raw, i) => ({ raw, n: i + 1 }))
    .map((l) => ({ ...l, text: stripComment(l.raw) }))
    .filter((l) => l.text.trim() !== '');
  const root = {};
  const stack = [{ indent: -1, node: root, key: null }];
  for (const l of lines) {
    const indent = l.text.match(/^ */)[0].length;
    const body = l.text.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).node;
    if (body.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`.cdc.yml line ${l.n}: list item outside a list`);
      parent.push(parseScalar(body.slice(2)));
      continue;
    }
    const kv = body.match(/^([\w.-]+):(?:\s+(.*))?$/);
    if (!kv) throw new Error(`.cdc.yml line ${l.n}: expected "key: value", got "${body}"`);
    const [, key, rawVal] = kv;
    if (Array.isArray(parent)) throw new Error(`.cdc.yml line ${l.n}: key inside a list`);
    if (rawVal === undefined || rawVal === '') {
      // nested map or block list: decided by the next line
      const next = lines[lines.indexOf(l) + 1];
      const child = next && next.text.trim().startsWith('- ') && next.text.match(/^ */)[0].length > indent ? [] : {};
      parent[key] = child;
      stack.push({ indent, node: child, key });
    } else parent[key] = parseScalar(rawVal);
  }
  return root;
}
function stripComment(s) {
  let out = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}
export function parseScalar(v) {
  v = v.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (/^\[.*\]$/.test(v)) return splitTop(v.slice(1, -1)).map(parseScalar).filter((x) => x !== null);
  if (/^\{.*\}$/.test(v)) {
    const o = {};
    for (const part of splitTop(v.slice(1, -1))) { const m = part.match(/^([\w.-]+):\s*(.*)$/); if (m) o[m[1]] = parseScalar(m[2]); }
    return o;
  }
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true; if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function splitTop(s) { // split on commas not inside brackets/quotes
  const out = []; let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++; if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// ---------- load / merge ----------
export function mergeConfig(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? mergeConfig(base[k], v) : v;
  }
  return out;
}
export function loadConfig(pluginDir) {
  const file = path.join(pluginDir, CONFIG_FILE);
  const exists = existsSync(file);
  const parsed = exists ? parseYaml(readFileSync(file, 'utf8')) : {};
  const cfg = mergeConfig(DEFAULTS, parsed);
  return { ...cfg, _path: file, _exists: exists };
}
export function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

// A track is what one run actually uses. pinned with no pin declared falls back to the canary alias
// (today's behaviour) and says so, so the first run can be pinned from what it resolved.
export function resolveTrack(cfg, track = cfg.track) {
  if (track !== 'pinned' && track !== 'canary') throw new Error(`track must be pinned or canary, got "${track}"`);
  const t = cfg[track] ?? {};
  const model = cfg.model?.[track] ?? cfg.model?.canary ?? DEFAULTS.model.canary;
  const harness = cfg.harness?.[track] ?? cfg.harness?.canary ?? DEFAULTS.harness.canary;
  return {
    track, agent: cfg.agent ?? 'claude', model, harness,
    modelIsPinned: track === 'pinned' ? cfg.model?.pinned != null : true,
    harnessIsPinned: track === 'pinned' ? cfg.harness?.pinned != null : true,
    judgeModel: cfg.judge_model ?? DEFAULTS.judge_model,
    runs: t.runs ?? null, expandOnDeviation: Number(t.expand_on_deviation ?? 0),
    promoteAfter: Number(cfg.canary?.promote_after ?? DEFAULTS.canary.promote_after),
    minIntervalHours: Number(cfg.canary?.min_interval_hours ?? DEFAULTS.canary.min_interval_hours),
    thresholds: { ...DEFAULTS.thresholds, ...(cfg.thresholds ?? {}) },
    failOn: cfg.fail_on ?? DEFAULTS.fail_on,
    budget: { ...DEFAULTS.budget, ...(cfg.budget ?? {}) },
    noise: { ...DEFAULTS.noise, ...(cfg.noise ?? {}) },
    baseline: { ...DEFAULTS.baseline, ...(cfg.baseline ?? {}) },
  };
}

// ---------- rewrite pins without touching anything else ----------
// Replaces `pinned:` under `model:` / `harness:` in place (comments and order preserved); appends the
// block when missing. Returns the new text.
export function setPins(src, { model, harness } = {}) {
  let text = src.endsWith('\n') || src === '' ? src : src + '\n';
  for (const [block, value] of [['model', model], ['harness', harness]]) {
    if (value == null) continue;
    const re = new RegExp(`^(${block}:\\s*(?:#.*)?\\n)((?:[ \\t]+.*\\n?)*)`, 'm');
    const m = text.match(re);
    if (m) {
      const body = m[2];
      const pinRe = /^([ \t]+pinned:)[ \t]*[^\n#]*?([ \t]*#.*)?$/m;
      const newBody = pinRe.test(body) ? body.replace(pinRe, (_, k, comment = '') => `${k} ${value}${comment}`) : body + `  pinned: ${value}\n`;
      text = text.slice(0, m.index) + m[1] + newBody + text.slice(m.index + m[0].length);
    } else text += `${block}:\n  pinned: ${value}\n`;
  }
  return text;
}

export function starterConfig({ model, harness } = {}) {
  return `# config-drift-checker — tracks, budgets, thresholds. Docs: https://github.com/jameskomo/config-drift-checker/blob/main/docs/user-guide.md#cdcyml
track: pinned            # default track for a run; the Action passes --track explicitly
model:
  pinned: ${model ?? 'null'}   # exact model id the baseline is measured on (null = use the canary alias until the first bump PR pins it)
  canary: sonnet         # alias resolved at run time — what your developers actually get
harness:
  pinned: ${harness ?? 'null'}   # @anthropic-ai/claude-code version for the baseline (null = latest)
  canary: latest
judge_model: haiku
canary:
  runs: 1                # one run per case, then…
  expand_on_deviation: 2 # …two more only if a grader failed (sequential testing)
  promote_after: 2       # consecutive green canaries before a bump PR is opened
  min_interval_hours: 72 # never canary more often than this on a schedule
thresholds:              # relative change that counts as drift
  score: 0.15
  turns: 0.5
  cost: 0.5
  duration: 0.5
fail_on: [score]         # which drifts turn the check red; the rest are warnings
budget:
  per_run_usd: 2         # the shim stops starting new runs past this
  per_month_usd: 10      # the Action refuses to start a run past this (ledger on the results branch)
noise:
  history_runs: 10       # past runs that set each case's noise band in the diff (widen the threshold, never red)
baseline:
  min_runs: 3            # a run with fewer scored runs per case is refused as a baseline
`;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, cmd, ...rest] = process.argv.slice(2);
  if (!dir || !cmd) { console.error('usage: cdc-config.mjs <plugin-dir> get|resolve|set-pins|init …'); process.exit(2); }
  const pluginDir = path.resolve(dir);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'get') { const v = getPath(loadConfig(pluginDir), rest[0]); process.stdout.write((v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')) + '\n'); }
  else if (cmd === 'resolve') {
    const r = resolveTrack(loadConfig(pluginDir), rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined);
    if (rest.includes('--github-output')) {
      const flat = { track: r.track, agent: r.agent, model: r.model, harness: r.harness, model_is_pinned: r.modelIsPinned, harness_is_pinned: r.harnessIsPinned, judge_model: r.judgeModel, runs: r.runs ?? '', expand_on_deviation: r.expandOnDeviation, promote_after: r.promoteAfter, min_interval_hours: r.minIntervalHours, threshold: r.thresholds.score, fail_on: r.failOn.join(','), budget_per_run_usd: r.budget.per_run_usd, budget_per_month_usd: r.budget.per_month_usd, noise_history_runs: r.noise.history_runs, baseline_min_runs: r.baseline.min_runs, config_exists: existsSync(path.join(pluginDir, CONFIG_FILE)) };
      process.stdout.write(Object.entries(flat).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    } else process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  }
  else if (cmd === 'set-pins' || cmd === 'init') {
    const file = path.join(pluginDir, CONFIG_FILE);
    const model = flag('--model'), harness = flag('--harness');
    const text = cmd === 'init' || !existsSync(file) ? starterConfig({ model, harness }) : setPins(await fs.readFile(file, 'utf8'), { model, harness });
    await fs.writeFile(file, text);
    console.error(`${cmd === 'init' || !existsSync(file) ? 'wrote' : 'updated'} ${file}${model ? ` model.pinned=${model}` : ''}${harness ? ` harness.pinned=${harness}` : ''}`);
  }
  else { console.error(`unknown command ${cmd}`); process.exit(2); }
}
