# Eval format, runner, graders, diff and storage

## 1. Eval format (Anthropic's; we implement a subset and extend nothing)

```
<plugin>/
  .claude-plugin/plugin.json            # name, version, skills[], hooks
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
`model`, `append_system_prompt`, `env` (`EVAL_*` only).

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
       --max-turns N --model M
       [--plugin-dir <plugin>]            # "with" arm only
       [--allowedTools <case.allowed_tools>]
env: CLAUDE_CONFIG_DIR=cfg, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, ANTHROPIC_MODEL unset
```

Trace parsing (stream-json): `assistant` events → text blocks (last = `last_message` unless the
`result` event carries `result`) and `tool_use` blocks (`name`, `input`); `result` event →
`total_cost_usd`, `usage`, `num_turns`, `is_error`, `modelUsage`. Files created = walk(ws) minus
`.git`. Temp dirs removed after grading.

Arms: `with` (plugin loaded) and, under `--ablation with-without`, `without` (identical run, no
plugin). Case score = mean over scored graders; arm score = mean over runs; delta = with − without.
Any grader may carry `arm: with|without` to be scored in that arm only (e.g. "attempted" belongs
to the without arm); `tool_used: Skill` graders are with-only indicators under ablation.

Safety net (both arms): the isolated config's `settings.json` carries a PreToolUse(Bash) hook
(`tools/safety-net.mjs`) and the run uses `--setting-sources user` so it applies. It blocks
host-global destructive commands; a matched command is allowed only if `scaffold_script` created
`<ws>/.eval-bin/<binary>` (the shim prepends that dir to PATH). `last_message` = all assistant
text for the run; `final_message` = the closing message only. `files` = files the agent created
or modified (snapshot after scaffold vs after run).

Judge: `claude -p` with the judge model, tools disallowed, single turn, strict JSON reply
`{"pass": bool, "reason": str}`; parse defensively.

Exit codes: 0 always for the shim (the Action gates on the diff), matching "report, don't judge".

**Regrade.** `--regrade <aggregate-result.json>` re-scores the saved runs of that file with the
*current* grader definitions and no agent calls (responses, tool calls and changed-file contents
are stored per run for this purpose); `llm` graders keep their saved verdict unless `--regrade-llm`.
Output is a new results dir with `regradeOf` set. This is how a grader bug is fixed without re-spending the suite.

## 3. Output — `aggregate-result.json` (schemaVersion "1", additive)

```jsonc
{
  "schemaVersion": "1", "shim": true, "generatedAt": "...",
  "suite": { "name": "komo-stack", "caseCount": 3, "baselineOnly": false },
  "cases": [{
    "name": "...", "dir": "guard-blocks-destructive-git", "tags": ["hook"],
    "arms": { "with": [ { "runIndex": 0, "score": 1, "graders": [{ "name": "attempted", "type": "tool_used", "score": 1, "verdict": "pass", "scored": true, "withOnly": false }],
                          "costUsd": 0.05, "inputTokens": 0, "outputTokens": 382, "numTurns": 2, "durationMs": 0, "model": "claude-sonnet-5",
                          "toolUses": [{ "tool": "Bash", "input": "{...}" }], "prompt": "...", "response": "...", "filesChanged": [] } ],
              "without": [ /* same shape */ ] },
    "summary": { "score": 1, "baselineScore": 0.33, "delta": 0.67, "costUsd": 0.30 }
  }],
  "aggregates": { "overallScore": 1, "passed": 3, "failed": 0, "costUsd": 1.0, "partialReason": null }
}
```

The official runner's JSON has the same top-level keys and per-run/per-grader shape (v1); the
shim adds `shim`, `generatedAt`, `dir`, `durationMs`, `filesChanged` (files the agent created or modified; the scaffolded source is excluded). `eval-diff` reads only the
shared fields.

## 4. Diff (`tools/eval-diff.mjs`)

Key = `dir ?? name`. For each baseline case: `after − before`; status `regressed` if
`< −threshold` (default 0.15), `improved` if `> +threshold`, else `stable`; `missing` if absent
in current; `new` if absent in baseline. Exit 1 if any `regressed` or `missing`. Emits a markdown
table with per-case failing graders (with-arm, counts across runs) and a JSON summary.

Threshold reasoning: with 3 runs a single flaky run moves a case by 0.33 → below-threshold noise
must be handled by *more runs*, not a looser threshold. v0.2 adds sequential testing (1 run; expand
to 5 on deviation) and a per-case `min_runs`.

## 5. Release watch (`tools/release-watch.mjs`)

`npm view @anthropic-ai/claude-code version` vs `.claude-code-version` (stored on the results
branch). Prints `changed=`, `version=`, `previous=` in GitHub-output form. The workflow's `watch`
job skips the eval job on schedule when unchanged, always runs on push/PR/dispatch.

## 5b. HTML report (`tools/eval-report.mjs`)

`renderReport(current, baseline?)` → one self-contained HTML file: summary strip (overall,
regressions vs baseline, passed, cost, model, runner, timestamp), the score table (baseline / score /
Δ / without-plugin / Δ-plugin / runs / cost per case, regressed rows tinted), and per-case run
cards: grader chips (hover = type + judge reason; indicators marked), judge reasons, tool calls,
changed files, full response — all as `<details>`, plus a "failing runs only" toggle. No script
dependencies, theme-aware. The shim writes `report.html` beside every `aggregate-result.json`
(including regrades) - the JSON is the source of truth, the HTML is derived and reproducible; the
Action uploads it as the `eval-report` workflow artifact and links it from the job summary. CLI: `node tools/eval-report.mjs current.json [--baseline b.json] [--out r.html]`.

## 6. Results branch layout

```
eval-results (orphan)
  baseline.json                         # promoted result
  history/<UTC stamp>-cc<version>-<official|shim>.json
  .claude-code-version
```

Written by the Action with a bot identity; one commit per run. The branch is plain JSON, so any tool can read it.

## 7. Known limitations (v0.1)

`tool_order`, `baseline`, `history_file`, `add_dirs`, MCP mocks not implemented in the shim; LLM
grader single vote; no parallelism (sequential runs — ~30 s each for short cases); the Action is
untested on GitHub until first push.
