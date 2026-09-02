#!/usr/bin/env node
// release-watch — did the harness (npm package) or the model list move since we last looked?
//
//   node tools/release-watch.mjs [--package @anthropic-ai/claude-code] [--state <file>] [--update]
//        [--models]            also diff Anthropic's /v1/models (needs ANTHROPIC_API_KEY; silently skipped without)
//        [--pin <model-id>]    report whether a pinned model id is still listed
//
// Prints GitHub-output style lines: changed=true|false  reason=harness|model|both|none  version=<latest>
// previous=<stored|none>  new_models=a,b  retired_models=a,b  pin_retired=true|false  models_error=<text>
// --update writes the latest state. Exit code is always 0 (the caller decides).
//
// State file: JSON { harness, models[] }. A legacy plain-text file holding just a version is read as { harness }.
import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';

export function readState(text) {
  const t = (text ?? '').trim();
  if (!t) return { harness: null, models: null };
  try { const j = JSON.parse(t); return { harness: j.harness ?? null, models: Array.isArray(j.models) ? j.models : null }; } catch { return { harness: t, models: null }; }
}

// Pure: what changed between the stored state and what we see now.
export function compare(prev, latest, pin = null) {
  const harnessChanged = !!latest.harness && latest.harness !== prev.harness;
  const prevModels = prev.models, curModels = latest.models;
  const newModels = prevModels && curModels ? curModels.filter((m) => !prevModels.includes(m)) : [];
  const retired = prevModels && curModels ? prevModels.filter((m) => !curModels.includes(m)) : [];
  const modelChanged = newModels.length > 0 || retired.length > 0;
  const reason = harnessChanged && modelChanged ? 'both' : harnessChanged ? 'harness' : modelChanged ? 'model' : 'none';
  return {
    changed: reason !== 'none', reason,
    version: latest.harness ?? prev.harness ?? null, previous: prev.harness ?? null,
    newModels, retiredModels: retired,
    pinRetired: pin && curModels ? !curModels.includes(pin) : null,
    firstModelSnapshot: !prevModels && !!curModels,
  };
}

// The key may also arrive as CDC_MODELS_API_KEY: a name the claude CLI ignores, so a job can list models
// with an API key while its agent runs authenticate with a subscription token.
export async function fetchModels(url = process.env.CDC_MODELS_URL ?? 'https://api.anthropic.com/v1/models?limit=1000', key = process.env.ANTHROPIC_API_KEY || process.env.CDC_MODELS_API_KEY) {
  if (!key) return { models: null, error: 'ANTHROPIC_API_KEY / CDC_MODELS_API_KEY not set' };
  try {
    const res = await fetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { models: null, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { models: (j.data ?? []).map((m) => m.id).filter(Boolean).sort(), error: null };
  } catch (e) { return { models: null, error: e.message }; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = { package: '@anthropic-ai/claude-code', state: '.release-watch.json', update: false, models: false, pin: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') opt.package = argv[++i];
    else if (argv[i] === '--state') opt.state = argv[++i];
    else if (argv[i] === '--update') opt.update = true;
    else if (argv[i] === '--models') opt.models = true;
    else if (argv[i] === '--pin') opt.pin = argv[++i];
  }
  const prev = readState(existsSync(opt.state) ? await fs.readFile(opt.state, 'utf8') : '');
  let harness = null;
  try { harness = execFileSync('npm', ['view', opt.package, 'version'], { encoding: 'utf8', timeout: 30_000 }).trim() || null; } catch {}
  const m = opt.models ? await fetchModels() : { models: null, error: null };
  const latest = { harness, models: m.models ?? prev.models };
  const r = compare(prev, latest, opt.pin);
  if (opt.update && (r.changed || r.firstModelSnapshot || !existsSync(opt.state))) await fs.writeFile(opt.state, JSON.stringify(latest, null, 2) + '\n');
  const lines = [`changed=${r.changed}`, `reason=${r.reason}`, `version=${r.version ?? 'none'}`, `previous=${r.previous ?? 'none'}`, `new_models=${r.newModels.join(',')}`, `retired_models=${r.retiredModels.join(',')}`];
  if (opt.pin) lines.push(`pin_retired=${r.pinRetired ?? 'unknown'}`);
  if (m.error) lines.push(`models_error=${m.error}`);
  process.stdout.write(lines.join('\n') + '\n');
}
