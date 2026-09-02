# Runbook

## First-time setup (a repo that has a plugin)

1. Add the workflow (`uses: jameskomo/config-drift-checker/action@v0`; the full two-track template is
   `ci/config-drift-checker.yml` in the plugin) and a `.cdc.yml` at the plugin root
   (`node tools/cdc-config.mjs <plugin> init`, then set `budget.per_month_usd` to what you are willing to spend).
2. Secrets: `ANTHROPIC_API_KEY` (an API key from console.anthropic.com with prepaid credit), optional
   `SLACK_WEBHOOK_URL`. Repo settings: workflow permissions *Read and write*, and *Allow GitHub Actions
   to create and approve pull requests* (for bump/pin/repair PRs).
3. Write cases under `<plugin>/evals/` — start with three: one positive skill case, one
   negative-trigger case, one hook case with a `case.yaml` scaffold. If the repo ignores `.claude/`
   (`git check-ignore -v .claude/evals/x`), keep the plugin files under `agent-config/` instead and
   set `experimental.evals` in the manifest. Real-code cases: scaffold copies the real source and
   `CLAUDE.md` into the workspace (`$EVAL_PLUGIN_ROOT` is set during scaffold); ask for a feature
   that does not exist yet. Put the rule ids the case exercises in `covers:`
   (`node tools/config-coverage.mjs <plugin> --list`).
4. Validate locally: `claude plugin validate <plugin>` then
   `node tools/eval-shim.mjs <plugin> --case '<one>' --runs 1 --ablation none --scaffold --budget 0.5`.
5. Run the workflow manually (`workflow_dispatch`, track `pinned`) once → records the baseline on
   `eval-results` and opens the **pin PR** if `.cdc.yml` had no pin. Merge it.

## What every run produces

```
<plugin>/evals/results/<timestamp>/
  aggregate-result.json   # the data (schemaVersion 1.1) — what eval-diff, --regrade and the Action read
  report.html             # the same data as a self-contained page, generated from the JSON
```

The shim prints both paths at the end of every run, including `--regrade` runs. The report is
derived, never authoritative: regenerate it any time, with or without a baseline for the diff columns
(`node tools/eval-report.mjs <results>/aggregate-result.json [--baseline <other>/aggregate-result.json] [--config <plugin>]`).
In CI the Action generates it with the baseline diff and uploads it as the `eval-report` workflow
artifact (90-day retention); the results branch stores the JSON, the drift index, and every run's
report under `docs/`. One file, no server, opens from disk (Google Fonts if online, system fonts if not).

## Daily operation

Nothing. On push/PR to the setup the **pinned** track runs and sets the check. On the schedule the
`watch` job checks npm and the model list; if something shipped, the **canary** runs — at most once per
`canary.min_interval_hours`, never past `budget.per_month_usd`. Read the job summary; regressions also
arrive on Slack; two green canaries on a new model/version arrive as a **bump PR**.

## When a case goes red

1. Open the job summary (verdict, stamp, what moved), then download the **eval-report** artifact and
   open `eval-report.html`: every run, every grader with its reason, tool calls, and the full response.
   Locally the same file is written as `report.html` next to each `aggregate-result.json`.
2. Read the stamp first: did the **model** or **Claude Code** move since the baseline? On the pinned
   track neither should have (if they did, the pins in `.cdc.yml` are not what the baseline was
   measured on — fix the pins). On the canary, a move is the point.
3. Classify:
   - **Real regression** (behaviour changed after a Claude Code/model change) → keep the pins, adapt
     the setup (or `/config-drift-checker:repair`, or `repair: true` on the Action), write it up.
   - **Setup change** you intended → fix the case or re-run with `promote-baseline: true`.
   - **Flaky case** (score varies without cause) → increase `runs` for that case; check the
     scaffold creates the state the prompt assumes; check graders match code, not prose.
   - **Model self-refusal** (0 tool calls, 1 turn) → the case doesn't exercise the hook; change
     the command to one the model will run in a scratch repo.
   - **Efficiency drift only** (*slower / pricier / longer*, every case still passes) → look at the
     turns; if it is the new normal, `promote-baseline`; if it is a real change in behaviour, treat
     it as a regression and consider `fail_on: [score, turns]`.
4. Never loosen `thresholds.score` to make red go away; add runs.

## Promoting a baseline

`workflow_dispatch` on the pinned track with `promote-baseline: true` after an intentional change, or
after the first run. Baselines are per results branch; history keeps every run regardless. The
canary track never writes `baseline.json`; it proposes a **bump PR** instead, which you merge (the
next pinned run on the new pins is then the baseline you promote).

## Cost control

| Lever | Effect |
|---|---|
| `budget.per_month_usd` in `.cdc.yml` | the ceiling. Past it the Action skips with a notice; `force: true` on a manual run overrides |
| `budget.per_run_usd` | the runner stops starting runs mid-suite; what ran is kept |
| `canary.min_interval_hours` | coalesces release bursts (25 versions/month observed) into ≤ ~10 canaries |
| `canary.runs: 1` + `expand_on_deviation: 2` | one run per case; three only when something looks wrong (~3× cheaper canaries) |
| `ablation: none` in CI | halves cost; keep `with-without` for one-off proof |
| `runs` per case | 3 default on pinned; 5 for flaky/critical hook cases; 1 for smoke on PRs |
| `model: haiku` for PR smoke, the pin for baseline runs | 5–10× cheaper smoke |
| `--case` / `--tag` filters on PRs | run only what the PR touched |

Measured: $0.045–0.075 per short Sonnet run; $0.43 per 9-run suite; $1.00–1.13 per 18-run suite.
The ledger (`spend.json` on the results branch, meter on the drift index) shows the month so far.

## Local commands

```bash
node tools/eval-shim.mjs komo-stack --scaffold                       # full, with/without, 3 runs
node tools/eval-shim.mjs komo-stack --track canary --scaffold        # alias model, sequential runs
node tools/eval-shim.mjs komo-stack --case 'guard*' --runs 1 --ablation none --scaffold --budget 0.5
node tools/eval-diff.mjs baseline.json current.json --config komo-stack --md diff.md
node tools/eval-shim.mjs <plugin> --regrade <results>/aggregate-result.json     # fixed a grader? re-score without re-running
node tools/release-watch.mjs --state .release-watch.json --models --pin claude-sonnet-5 --update
node tools/cdc-gate.mjs check --config komo-stack --track canary --spend spend.json --streak canary/streak.json --event schedule
node tools/canary-promote.mjs --config komo-stack --result current.json --streak canary/streak.json --regressed 0
node tools/config-coverage.mjs komo-stack --list
node tools/eval-dashboard.mjs komo-stack/evals/results --config komo-stack --out dashboard.html
claude plugin eval ./komo-stack --allow-tools Bash --scaffold --json out.json   # when enabled
cd config-drift-checker && npm test                                  # 42 tests, no API key needed
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "`plugin eval` is currently in early access" | account not enabled | Action falls back to the shim automatically; request access from Anthropic (`/bug` in Claude Code, or a GitHub issue on anthropics/claude-code) |
| shim run `isError: true`, `stderrTail` mentions auth or credit | no key in CI / no credentials locally / no prepaid credit | set the secret (or `CLAUDE_CODE_OAUTH_TOKEN`); locally the shim copies `~/.claude/.credentials.json`; top up at console.anthropic.com → Billing |
| job summary says **skipped: budget** | month's ledger reached `budget.per_month_usd` | raise the cap, wait for next month, or re-run manually with `force: true` |
| job summary says **skipped: interval** | scheduled canary sooner than `canary.min_interval_hours` | nothing; push/PR/manual runs are never throttled |
| "could not open the PR" warning, branch pushed | the token cannot create PRs | Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*, or pass a PAT as `github-token`; open the PR from the branch meanwhile |
| `pin_retired=true` / "model.pinned is no longer listed" | Anthropic retired the pinned id | merge the next bump PR, or `cdc-config set-pins --model <current id>` and promote |
| canary red, pinned green | the alias moved to a model/version your setup does not survive | that is the alert working; adapt the setup before the alias reaches everyone; do not bump |
| every case 0 tool calls, 1 turn | prompt asks for something the model refuses in an empty dir | add `case.yaml` scaffold; choose a command the model will run |
| `store` step fails on first run | orphan branch creation quirk | create `eval-results` manually once: `git checkout --orphan eval-results && git rm -rf . && git commit --allow-empty -m init && git push -u origin eval-results` |
| scores differ from the official runner | LLM grader votes (1 vs 2-of-3), unsupported grader types | expected; the official runner is authoritative when available |
