# Architecture

## Overview: GitHub Action, no backend

```mermaid
flowchart LR
  subgraph repo["Your repo"]
    P[plugin/<br/>.claude-plugin, skills, hooks]
    C[.cdc.yml<br/>pins · canary · thresholds · budget]
    E[evals/<br/>prompt.md · graders/*.md · case.yaml]
    W[.github/workflows/config-drift-checker.yml]
  end
  subgraph gh["GitHub Actions (your minutes)"]
    RW[watch job<br/>release-watch.mjs → npm + /v1/models]
    G[gate<br/>cdc-gate.mjs: budget · interval]
    A[action/action.yml]
    R{runner}
    OFF[claude plugin eval<br/>official, preferred]
    SHIM[tools/eval-shim.mjs<br/>claude -p per run · track · budget]
    D[eval-diff.mjs<br/>score + efficiency drift]
    PM[canary-promote.mjs<br/>streak → bump / pin]
    CV[config-coverage.mjs]
  end
  subgraph out["Outputs"]
    RB[(eval-results branch<br/>baseline.json · canary/ · spend.json · history/ · docs/)]
    SUM[Job summary / PR comment]
    REP[eval-report artifact<br/>verdict · stamp · runs]
    DI[Drift index<br/>GitHub Pages]
    PR[bump / pin / repair PR]
    SL[Slack webhook]
    CHK[Red/green check]
  end
  NPM[(npm · Anthropic model list)] --> RW
  RW -->|something shipped → canary| G
  W -->|push/PR → pinned| G
  C --> G --> A
  P & E --> A --> R
  R --> OFF & SHIM
  OFF & SHIM -->|aggregate-result.json 1.1| D
  RB -->|baseline.json · spend · streak| G & D
  D --> SUM & SL & CHK & RB & REP
  RB --> PM --> PR
  E & P --> CV --> RB & SUM
  RB --> DI
  API[(Anthropic API<br/>your key, BYOK)] -.-> OFF & SHIM
```

**Components**

| Component | Responsibility | State |
|---|---|---|
| `cdc-config.mjs` | read `.cdc.yml`: resolve a track (model, harness, runs, expansion, thresholds, fail_on, budget); rewrite pins in place | `.cdc.yml` in the repo |
| `release-watch.mjs` | did Claude Code (npm) or the model list (`/v1/models`) move since last time; is the pin still listed | `.release-watch.json` on results branch |
| `cdc-gate.mjs` | refuse a run past the monthly budget or sooner than the canary interval; record spend after a run | `spend.json`, `canary/streak.json` on results branch |
| `action.yml` | config → coverage → results → gate → install pinned Claude Code → detect runner → run → diff → report → store → PR → repair → notify → exit | none (stateless per run) |
| `eval-shim.mjs` | execute a suite: isolated `CLAUDE_CONFIG_DIR`, throwaway workspace, `--plugin-dir`, per-case tools, N runs × arms with sequential expansion and a per-run budget; grade; emit JSON 1.1 with provenance. `--agent codex` (AGENTS.md bridge, exec events parsed) and `--agent gemini` (GEMINI.md bridge, headless text) run the same cases on other CLIs, experimental | temp dirs only |
| `eval-diff.mjs` | baseline vs current → score drift and efficiency drift → markdown + JSON + exit code by `fail_on` | none |
| `eval-classify.mjs` | the shared per-case verdict (noise band, escalations) used by diff, report and dashboard; `normalizeResult()` maps official-runner JSON (v1) to the 1.1 shape at load, so all three read either | none |
| `canary-promote.mjs` | green streak on the same model+version → bump decision; unpinned green pinned run → pin decision; PR title/body | `canary/streak.json` |
| `config-coverage.mjs` | rules in CLAUDE.md / skills / hooks vs the cases' `covers.yaml` → coverage JSON, markdown, badge | `coverage.json` |
| `eval-report.mjs` | aggregate-result.json (+ baseline) → self-contained HTML report | none |
| `trace-keeper.mjs` | after `claude plugin eval --keep-temp`: copy the ephemeral traces next to the JSON and write toolUses/response/model inline | traces/ next to the result |
| `eval-dashboard.mjs` | history (+ baseline, spend, streak, coverage) → the drift index | none |
| `fleet.mjs` | many repos' published results → one dashboard + pin-policy skew; errored/missing repos exit red | none (reads each repo's results branch) |
| `cdc-bootstrap.mjs` | one command to a protected repo: headless setup-skill run, or a $0 `--no-agent` scaffold | none |
| `drift-bisect.mjs` | binary-search Claude Code releases for the one that broke a case (throwaway installs, log2 runs) | none |
| `skill-lint.mjs` | static checks on every SKILL.md and the manifest before any model run | none |
| `suite-doctor.mjs` | eval cases vs the current official format plus a free load check on the installed runner; `--fix` migrates known changes | edits case files only with `--fix` |
| `drift-matrix.mjs` | one suite across models x Claude Code versions (throwaway installs via `cc-release.mjs`, official runner with shim fallback) → one page and a verdict per model; `--budget` caps the grid | results under `evals/results/matrix-<stamp>/` |
| `context-cost.mjs` | always-on and on-invoke tokens per component from `claude plugin details` in a throwaway config (no credentials, no model calls), estimate fallback; `--history` trend per release | `history/context-cost/` on the results branch |
| `usage-check.mjs` | local session transcripts (counts only) vs eval results → tested but unused, used but untested, dead weight | none (reads `~/.claude/projects`) |
| `evals-convert.mjs` | skill-creator `evals.json` ⇄ plugin-eval case folders | writes case folders only on `import` |
| `eval-mocks.mjs`, `eval-mock-server.mjs` | the shim's MCP mocks: loads `evals/mocks/` in the official format and serves it over stdio under the plugin's server names | temp dirs only |
| `release-report.mjs` | every public eval suite we can find, loaded on the newest and the previous Claude Code with `--max-cost-usd 0`, `env -i` and an empty HOME | `docs/release-report/` |
| `drift-digest.mjs` | published verdicts → weekly digest + the pre-written release post | docs/drift/digest.md, post.txt |
| `ci/` templates | the per-repo two-track workflow, the fleet workflow, and the org pair (reusable workflow + three-line caller) | none |
| results branch | history, baseline, ledger, streak, dashboards, all without a database | git |

**Trust boundaries**

- Your API key never leaves your CI (env → `claude`). We see nothing. The only outbound calls the
  tools make themselves are `npm view` and `GET /v1/models` with your key (the watch job).
- Prompts, transcripts, and files created by the agent stay in your runner and results
  branch (you choose whether that branch is in a private repo).
- `usage-check` reads your local transcripts on your machine and reports skill names, counts and
  dates only; it never copies prompt or reply text and never runs in CI.
- The release report clones public repos and only loads their cases: no credentials (`env -i`, an
  empty HOME), no scaffold, no `npm install`, and a $0 cost ceiling that stops before any agent starts.
- The action runs `case.yaml` `scaffold_script` only when `scaffold: true` (the same gate as the
  official runner); never run suites you didn't author with scaffold on.
- PRs the Action opens (bump, pin, repair) are never auto-merged and need the repo to allow Actions
  to create PRs; otherwise the branch is pushed and a warning tells you to open it.

## Two tracks

| | pinned | canary |
|---|---|---|
| model | `model.pinned`: an exact id | `model.canary`: an alias, resolved at run time |
| Claude Code | `harness.pinned` | `latest` |
| when | push/PR to the setup, manual | schedule, only when npm or the model list moved, at most every `min_interval_hours` |
| runs | case default (3) | 1, +2 on deviation |
| compared to | `baseline.json` | `baseline.json` |
| on red | check red, PR comment, Slack | Slack, summary, dashboard *canary red*; check of its own run red; **baseline untouched** |
| writes | `baseline.json` (first run / promote) | `canary/latest.json`, `canary/streak.json` |
| opens | *pin PR* when no pin is declared | *bump PR* after `promote_after` greens on a new pair |

## Data flow of one run

1. Trigger: push / PR → pinned; schedule + release-watch change → canary; manual → chosen.
2. `config`: resolve the track from `.cdc.yml`. `coverage`: rules vs cases (no agent runs).
3. `results`: fetch `baseline.json`, `spend.json`, `canary/streak.json` from the results branch.
4. `gate`: budget and interval → run, or skip with a notice (exit 0).
5. `install`: the track's Claude Code version. `runner`: official if enabled, else shim.
6. `run`: for each case × run (× arm): scaffold workspace → spawn agent → capture trace; grade
   (regex / tool_used / file_exists / llm); expand on deviation; stop at the per-run budget.
7. `diff`: score and efficiency drift vs baseline; `fail_on` decides red. `report`: HTML.
8. `store`: history, baseline or canary/latest, ledger, release-watch state, streak + bump/pin decision,
   coverage, docs; one commit on the results branch.
9. `pr`: open the bump/pin PR from a worktree if one is due and none is open. `repair` (opt-in, red only):
   the repair skill proposes a setup fix, verifies it under the remaining budget, PR.
10. `comment` / `slack` / `gate-exit`: PR comment, alert, check status.

## Non-goals

Testing the model's general quality; hosting your repos; replacing `claude plugin eval` (we wrap it);
a DSL of our own (Anthropic's format is the interface); auto-merging anything.
