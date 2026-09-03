# Eval format, runner, graders, diff and storage

## 1. Eval format (Anthropic's; we implement a subset and extend nothing)

```
<plugin>/
  .claude-plugin/plugin.json            # name, version, skills[], hooks
  .cdc.yml                              # ours: tracks, pins, thresholds, budget (see §2b)
  evals/                                 # override: plugin.json experimental.evals or --eval-dir
    <case-dir>/
      prompt.md                          # frontmatter + prompt body
      graders/<name>.md                  # frontmatter + rubric
      case.yaml                          # optional; schema_version "1.1"
      mocks/<server>/<tool>.md           # optional MCP stand-ins
    mocks/                               # suite-wide mocks
    results/<timestamp>/aggregate-result.json
```

**prompt.md frontmatter** (all optional): `name`, `tags[]`, `runs` (default 3), `max_turns`,
`timeout_seconds`, `allowed_tools[]` (tools the agent may use; Bash/Write/Edit are gated),
`model`, `append_system_prompt`, `env` (`EVAL_*` only), and — ours, ignored by the official runner —
`covers[]`: ids of the rules this case exercises (`config-coverage.mjs --list` prints them).

**case.yaml**: `schema_version: "1.1"`, `context.scaffold_script` (bash run in the workspace,
gated by `--scaffold`), `context.history_file` (replay a transcript, evaluate next turn),
`context.add_dirs` (fixtures).

**graders/*.md frontmatter** by `type`:

| type | fields | shim | semantics |
|---|---|---|---|
| `regex` | `pattern`, `flags`, `match` = contains \| not_contains \| count:N, `target` = last_message \| final_message \| trace \| files | ✅ | pattern test on the chosen text |
| `tool_used` | `tool`, `input_match`, `min` (default 1; **0 when max is 0**), `max`, `arm` = with \| without \| both | ✅ | count matching tool calls; `Skill` graders are with-only *indicators* under ablation unless `arm: both` |
| `tool_order` | `before`, `after` | ⏳ | first `before` call precedes first `after` call |
| `file_exists` | `path` glob | ✅ | any created file matches |
| `llm` | `criteria`, `focus`, `target` | ✅ (1 vote) | judge model returns pass/fail; official votes 2-of-3 |
| `baseline` | `baseline_file`, `criteria` | ⏳ | judge compares against a reference output |

**Grader authoring rules learned the hard way** (see the `write-case` skill): match code position, not
prose, in `not_contains` graders; keep negative-trigger cases; make every hook case scaffold a
state the model will act on (an empty directory invites refusal).

## 2. Shim runner (`tools/eval-shim.mjs`)

Per run:

```
ws  = mkdtemp(eval-shim-ws-<case>-)              # throwaway workspace
cfg = mkdtemp(eval-shim-cfg-) + credentials copy   # fresh CLAUDE_CONFIG_DIR ⇒ no user settings, no global CLAUDE.md
[scaffold_script in ws if --scaffold]
claude -p <prompt> --output-format stream-json --verbose
       --setting-sources "" --permission-mode dontAsk
       --max-turns N --model M                 # M: --model > case frontmatter > .cdc.yml track > sonnet
       [--plugin-dir <plugin>]            # "with" arm only
       [--allowedTools <case.allowed_tools>]
env: CLAUDE_CONFIG_DIR=cfg, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, ANTHROPIC_MODEL unset
```

Trace parsing (stream-json): `assistant` events → text blocks (last = `last_message` unless the
`result` event carries `result`) and `tool_use` blocks (`name`, `input`); `result` event →
`total_cost_usd`, `usage`, `num_turns`, `is_error`, `modelUsage` (the **resolved model id**). Files
created = walk(ws) minus `.git`. Temp dirs removed after grading. `claude --version` is captured once
per invocation as the harness version.

Arms: `with` (plugin loaded) and, under `--ablation with-without`, `without` (identical run, no
plugin). Case score = mean over scored graders; arm score = mean over runs; delta = with − without.
Any grader may carry `arm: with|without` to be scored in that arm only (e.g. "attempted" belongs
to the without arm); `tool_used: Skill` graders are with-only indicators under ablation.

**Tracks** (`--track pinned|canary`, default from `.cdc.yml`): the track supplies model, harness,
runs, expansion and budget unless a flag overrides them. **Sequential testing**
(`--expand-on-deviation n`): after the configured runs of an arm, `n` more run only if a run scored
below 1.00 — the cheap first look buys more evidence only when it matters. **Budget** (`--budget usd`):
before starting any run, if the invocation's spend has reached the cap, no further runs start; what
already ran is kept and scored, `aggregates.budget` records the cap, spend and skipped runs, and a
case with no runs scores `null` (❔ in the diff, never a regression). `--budget 0` disables the cap.

Safety net (both arms): the isolated config's `settings.json` carries a PreToolUse(Bash) hook
(`tools/safety-net.mjs`) and the run uses `--setting-sources user` so it applies. It blocks
host-global destructive commands; a matched command is allowed only if `scaffold_script` created
`<ws>/.eval-bin/<binary>` (the shim prepends that dir to PATH). `last_message` = all assistant
text for the run; `final_message` = the closing message only. `files` = files the agent created
or modified (snapshot after scaffold vs after run).

Judge: `claude -p` with the judge model, tools disallowed, single turn, strict JSON reply
`{"pass": bool, "reason": str}`; parse defensively.

Exit codes: 0 always for the shim (the Action gates on the diff), matching "report, don't judge";
2 when every run errored. `--agent` other than `claude` exits 1 (adapters are on the roadmap).

**Regrade.** `--regrade <aggregate-result.json>` re-scores the saved runs of that file with the
*current* grader definitions and no agent calls (responses, tool calls and changed-file contents
are stored per run for this purpose); `llm` graders keep their saved verdict unless `--regrade-llm`.
Output is a new results dir with `regradeOf` set and the source's harness version carried through.
This is how a grader bug is fixed without re-spending the suite.

## 2b. `.cdc.yml` (`tools/cdc-config.mjs`)

Zero-dependency YAML subset (nested maps, scalars, `[a, b]`, `{ a: 1 }`, `- item`, comments).
Defaults in `DEFAULTS`; `resolveTrack(cfg, track)` yields `{ model, harness, modelIsPinned,
harnessIsPinned, judgeModel, runs, expandOnDeviation, promoteAfter, minIntervalHours, thresholds,
failOn, budget, noise, baseline }`. Precedence everywhere: CLI flag / Action input > case frontmatter (model only) >
`.cdc.yml` track > built-in default. The pinned track with no `model.pinned` falls back to the canary
alias and says so (`modelIsPinned: false`), which is what triggers the *pin PR*.

CLI: `get <dotted.key>` · `resolve <track> [--github-output]` · `set-pins --model id --harness ver`
(rewrites the two `pinned:` lines in place, comments and order preserved; appends the block when
missing) · `init` (starter file with comments). The user guide documents every key.

## 3. Output — `aggregate-result.json` (schemaVersion "1.1", additive to "1")

```jsonc
{
  "schemaVersion": "1.1", "shim": true, "agent": "claude", "track": "pinned",
  "harness": { "name": "claude-code", "version": "2.1.258" }, "judge": { "model": "haiku" },
  "config": { "model": "claude-sonnet-5", "modelIsPinned": true, "harness": "2.1.258", "harnessIsPinned": true, "expandOnDeviation": 0, "budgetUsd": 2, "file": ".cdc.yml" },
  "startedAt": "...", "generatedAt": "...",
  "suite": { "name": "komo-stack", "caseCount": 3, "baselineOnly": false },
  "cases": [{
    "name": "...", "dir": "guard-blocks-destructive-git", "tags": ["hook"], "covers": ["hook/pretooluse-bash"],
    "arms": { "with": [ { "runIndex": 0, "score": 1, "graders": [{ "name": "attempted", "type": "tool_used", "score": 1, "verdict": "pass", "scored": true, "withOnly": false }],
                          "costUsd": 0.05, "inputTokens": 0, "outputTokens": 382, "numTurns": 2, "durationMs": 6768, "model": "claude-sonnet-5",
                          "isError": false, "truncated": false, "toolUses": [{ "tool": "Bash", "input": "{...}" }], "prompt": "...", "response": "...", "filesChanged": [] } ],
              "without": [ /* same shape */ ] },
    "summary": { "score": 1, "baselineScore": 0.33, "delta": 0.67, "costUsd": 0.30 }
  }],
  "aggregates": { "overallScore": 1, "passed": 3, "failed": 0, "costUsd": 1.0, "erroredRuns": 0, "truncatedRuns": 0, "totalRuns": 9, "partialReason": null,
                  "resolvedModels": ["claude-sonnet-5"], "budget": { "capUsd": 2, "spentUsd": 1.0, "exceeded": false, "skippedRuns": 0 } }
}
```

The official runner's JSON has the same top-level keys and per-run/per-grader shape (v1); the shim
adds the provenance block (`agent`, `track`, `harness`, `judge`, `config`), `covers`, `durationMs`,
`truncated`, `resolvedModels` and `budget`. The Action stamps `track`/`harness`/`judge` onto official
output so the diff, store and promote steps can reason about it. Readers treat missing fields as unknown.

## 4. Diff (`tools/eval-diff.mjs`)

The per-case verdict (status, noise band, escalations, threshold/config resolution, history loading)
lives in `tools/eval-classify.mjs` and is shared with `eval-report` and `eval-dashboard`, so the PR
comment, the HTML report and the drift index always agree on the same run.

Key = `dir ?? name`. For each baseline case: `after − before`; status `regressed` if
`< −thresholds.score` (default 0.15), `improved` if `> +threshold`, else `stable`; `missing` if absent
in current; `new` if absent in baseline; `unknown` when either score is null (budget-skipped, all
errored). **Efficiency drift**: median `numTurns`, `costUsd`, `durationMs` over non-errored with-arm
runs; relative change above `thresholds.turns|cost|duration` (default 0.5) flags the row *slower* /
*pricier* / *longer*. Exit 1 only for what `fail_on` lists (default `[score]` → regressed/missing);
efficiency flags are warnings unless listed. Exit 2 when every run errored. `--config <plugin-dir>`
reads thresholds and `fail_on` from `.cdc.yml`; flags override.

**Noise band** (`--history <dir>` — the results branch's `history/`: newest `noise.history_runs`
timestamped `*.json`, same track only, the current file excluded): per case, `noise` = max − min of
all with-arm run scores across the baseline and history runs (null under 2 samples). A drop past
`thresholds.score` but not past `max(threshold, noise)` is **noisy** (⚠): it shows in the table with
a `±x.xx` noise column and a footer line, never counts as regressed or red, and never changes the
exit code. Two escalations make an in-band drop red anyway (footer says which): no current run
reaches the baseline score (a consistent shift, not a flake), or the newest two same-track history
scores for the case were already below `baseline − threshold` (persisted). Runs with ≤1 turn, no
tool use, a short reply (under ~600 chars) and a below-baseline score — on a case whose baseline
runs have a nonzero median tool count — are counted as likely refusals and noted on red/noisy rows;
a *full-length* no-tool answer is the setup being skipped (drift), not a refusal, and gets no excuse. Without `--history` the
threshold is flat, as before. JSON rows carry `noise`, `effThreshold`, `historyRuns`, `escalated`
(the escalation reason or null) and `refusedRuns`.

**Baseline quality** (never red): a case whose baseline has fewer scored with-arm runs than
`baseline.min_runs` (default 3) gets a `thin baseline (n=k)` warning; one whose baseline run-score
spread exceeds half the score threshold gets `unstable baseline (±x.xx)` (smaller spread is normal
LLM-judge variance and stays quiet). They render as a warnings block after the table and as `warnings[]`
per JSON row. `tools/baseline-check.mjs <result.json> [--min-runs n] [--config <plugin-dir>]`
enforces the same bar at promotion time — exit 1 when any case is under min-runs or
`aggregates.erroredRuns > 0`; the Action runs it before overwriting `baseline.json` and keeps the
old baseline on failure.

The markdown header carries the track, model and Claude Code version of both sides and a
`⚙ model moved` / `⚙ Claude Code moved` note when they differ, plus *setup worth* (mean with−without
delta) when the run was an ablation and a budget note when the cap stopped the run. With
`--report-url <url>` the case names in the table link to `<url>#case-<dir>` (the Action wires this
from its `report-base-url` input, pointing at the run's report on the results-branch Pages site).
The JSON summary
has `regressed`, `red`, `flagged`, `thresholds`, `failOn`, `moved`, `worth`, `rows[].eff`.

Threshold reasoning: with 3 runs a single flaky run moves a case by 0.33 → below-threshold noise
must be handled by *more runs*, not a looser threshold. The canary track's sequential testing
(1 run; +N on deviation) is the cost-side answer.

## 5. Release watch (`tools/release-watch.mjs`)

Two axes. `npm view @anthropic-ai/claude-code version` vs the stored harness, and — with `--models`
and an API key — `GET /v1/models` vs the stored id list. State is JSON `{ harness, models[] }`
(`.release-watch.json` on the results branch; a legacy plain-text `.claude-code-version` is read as
`{ harness }`). Prints `changed=`, `reason=harness|model|both|none`, `version=`, `previous=`,
`new_models=`, `retired_models=`, and with `--pin <id>` `pin_retired=true|false`. The first model
snapshot is not a change. The workflow's `watch` job runs the canary on schedule only when `changed`.

## 5a. Gate and ledger (`tools/cdc-gate.mjs`)

`check`: refuse (`run=false reason=budget`) when `spend.json`'s current-month total has reached
`budget.per_month_usd`; refuse (`reason=interval`) when a *scheduled canary* is sooner than
`canary.min_interval_hours` after `streak.lastRunAt`. `--force` on a `workflow_dispatch` bypasses both.
`record`: adds a run's cost, track, harness, resolved models and URL to the ledger (per-month totals,
last 200 runs). A skip is a notice in the job summary and exit 0 — never a red check.

## 5b. Canary promotion (`tools/canary-promote.mjs`)

Pure `advance(streak, run, track, pins)`: a green canary on the same model+harness as the streak
increments `greens`; a red resets it; a different pair restarts at 1. When `greens ≥ promote_after` and
the pair differs from the pins → decision `bump`. On the pinned track, a green run with no declared
pin → decision `pin`. Either sets `openedAt`, resets `greens`, and yields a branch name
(`cdc/bump-<model>-cc<version>`), title and a body with before/after pins and the recent runs table.
The Action edits `.cdc.yml` with `cdc-config set-pins` in a worktree, pushes the branch and opens the
PR if none is open for that branch. Green = zero red rows, zero errored runs, no budget stop, no
failed case.

## 5c. Coverage (`tools/config-coverage.mjs`)

Rules = bullets and numbered items (outside code fences) in `CLAUDE.md` and every `SKILL.md`, plus one
rule per hook event/matcher. Ids are `<scope>/<first-six-words>` (`claude-md/…`, `skill/<name>/…`,
`hook/<event>-<matcher>`), deduplicated. Cases claim rules with `covers:`; the tool reports
covered/uncovered/unknown ids, writes `coverage.json`, a markdown block (in the job summary) and an
SVG badge (`docs/coverage.svg` on the results branch). No agent runs. `--fail-under N` exits 1 when
coverage is under N% (null pct — a plugin with no rules — never fails); the Action's `coverage-min`
input wires it into the check.

## 5d. HTML report (`tools/eval-report.mjs`)

`renderReport(current, baseline?, { threshold, thresholds, history, minBaselineRuns })` → one
self-contained HTML file: the
**verdict** (what happened, what to do) and a **provenance stamp** (overall with the baseline's,
cases at 1.00, model + pinned/alias and *moved from*, Claude Code and *moved from*, track, runner and
judge, cost vs cap, setup worth), *what moved* cards (regressed / noisy / improved / new / efficiency),
the score table (baseline / score / Δ / noise / without-plugin / Δ-plugin / turns / cost / runs, with
`→` and % when a median moved), and per-case sections: tags and `covers` chips, what the case
evaluates, and run cards in three states (green pass, amber truncated-but-passed, red failed, grey
errored) with grader chips (hover = type + reason), judge reasons (open on failed runs), tool calls,
changed files, full response. "Failing and flagged runs only" toggle. No script dependencies,
theme-aware. Cases are classified by `eval-classify.mjs` — with `--history <dir>` (the results
branch's `history/`, newest `noise.history_runs` same-track runs older than this run) a drop inside
the case's noise band is **noisy** (amber ⚠, never red), with the noise column, footer notes and the
baseline-quality block mirroring the PR-comment markdown; each case header carries a sparkline of its
with-arm run scores. Without `--history` the threshold is flat, as before. The shim writes
`report.html` beside every `aggregate-result.json`; the Action uploads it
as the `eval-report` artifact. CLI: `node tools/eval-report.mjs current.json [--baseline b.json] [--config <plugin>] [--history dir] [--out r.html]`.

## 5e. Drift index (`tools/eval-dashboard.mjs`)

Reads a history directory (the results branch's `history/*.json`, or a local `evals/results/`) and
optionally `--baseline`, `--spend`, `--streak`, `--coverage`, `--config`. Writes one HTML file: the
verdict across tracks (*holding at baseline*, *baseline holding · canary red*, *canary regressed*,
*latest run errored*, *noisy — within the historical band*), the stamp (latest run, baseline model/version/date, latest canary and streak,
Claude Code versions seen, budget spent vs cap with a meter, coverage, total cost), the **ribbon** —
one row per case, one cell per run, filled for pinned runs and outlined for canaries, coloured by
verdict — the SVG line chart of score per case over Claude Code versions with canary runs shaded,
and the run list with track, version, model, per-case scores, cost and a link to each run's report.
Every run's cases are classified by `eval-classify.mjs` with the baseline + the preceding same-track
runs as the noise evidence, so a cell the diff would call noisy is amber here too, never red. Chart
x labels are thinned so they never overlap; the series legend wraps below the chart with full case
names. The Action writes it as `docs/index.html` on the results branch when `pages` is true.

## 6. Results branch layout

```
eval-results (orphan)
  baseline.json                         # the pinned baseline (promoted result)
  canary/latest.json                    # the latest canary run
  canary/streak.json                    # greens on the current model+version; drives bump PRs
  spend.json                            # ledger: per-month USD and runs, last 200 runs with provenance
  coverage.json
  history/<UTC stamp>-cc<version>-<official|shim>-<track>.json
  .release-watch.json                   # { harness, models[] } for the watch job
  .claude-code-version                  # legacy, still written
  docs/index.html                       # drift index (GitHub Pages: source = this branch, /docs)
  docs/report.html                      # latest run's report
  docs/history/<run>.html               # every run's report
  docs/latest.json · docs/baseline.json · docs/streak.json · docs/spend.json · docs/coverage.json · docs/coverage.svg
```

Written by the Action with a bot identity; one commit per run. The branch is plain JSON, so any tool can read it.

## 7. Known limitations

`tool_order`, `baseline`, `history_file`, `add_dirs`, MCP mocks not implemented in the shim; LLM
grader single vote; no parallelism (sequential runs — ~30 s each for short cases); `repair` and the
official-runner path are exercised on real accounts only, not by the test suite (which drives the shim
with a fake `claude`); Claude-only (`agent:` is reserved for Codex/Gemini adapters).
