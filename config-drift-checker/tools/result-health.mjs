#!/usr/bin/env node
// result-health — is an eval result usable as a measurement? Reads either format (shim 1.1 or the
// official runner's v1), so the Action can decide whether to trust the official runner on this
// Claude Code version or fall back to the bundled one.
//
//   node result-health.mjs <aggregate-result.json> [--expect-cases N]
//   prints key=value lines for $GITHUB_OUTPUT: usable, reason, errored, total, cases
// Unusable when: no file, every run errored (e.g. a runner that refuses to start without a
// sandbox), or fewer cases loaded than the suite has (e.g. a stricter case schema).
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { normalizeResult } from './eval-classify.mjs';
import { usableReason } from './cc-release.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const expIdx = argv.indexOf('--expect-cases');
const expect = expIdx >= 0 ? Number(argv[expIdx + 1]) : null;
const out = (k, v) => console.log(`${k}=${String(v).replace(/\n/g, ' ')}`);
if (!file || !existsSync(file)) { out('usable', false); out('reason', 'no result file'); out('errored', 0); out('total', 0); out('cases', 0); process.exit(0); }
const j = normalizeResult(JSON.parse(await fs.readFile(file, 'utf8')));
const total = j.aggregates?.totalRuns ?? 0, errored = j.aggregates?.erroredRuns ?? 0, cases = (j.cases ?? []).length;
const reason = usableReason(j, expect);
out('usable', !reason); out('reason', reason); out('errored', errored); out('total', total); out('cases', cases);
