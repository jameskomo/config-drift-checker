# Runbook

## First-time setup (a repo that has a plugin)

1. Copy `action/`, `tools/`, `.github/workflows/config-drift-checker.yml` into the repo (or, once
   published, `uses: jameskomo/config-drift-checker@v0`).
2. Secrets: `ANTHROPIC_API_KEY` (an API key from console.anthropic.com — **not** a consumer
   subscription), optional `SLACK_WEBHOOK_URL`.
3. Write cases under `<plugin>/evals/` — start with three: one positive skill case, one
   negative-trigger case, one hook case with a `case.yaml` scaffold. If the repo ignores `.claude/`
   (`git check-ignore -v .claude/evals/x`), keep the plugin files under `agent-config/` instead and
   set `experimental.evals` in the manifest. Real-code cases: scaffold copies the real source and
   `CLAUDE.md` into the workspace (`$EVAL_PLUGIN_ROOT` is set during scaffold); ask for a feature
   that does not exist yet.
4. Validate locally: `claude plugin validate <plugin>` then
   `node tools/eval-shim.mjs <plugin> --case '<one>' --runs 1 --ablation none --scaffold`.
5. Run the workflow manually (`workflow_dispatch`) once → records the baseline on `eval-results`.

## What every run produces

```
<plugin>/evals/results/<timestamp>/
  aggregate-result.json   # the data - what eval-diff, --regrade and the Action read
  report.html             # the same data as a self-contained page, generated from the JSON
```

The shim prints both paths at the end of every run, including `--regrade` runs. The report is
derived, never authoritative: regenerate it any time, with or without a baseline for the diff columns
(`node tools/eval-report.mjs <results>/aggregate-result.json [--baseline <other>/aggregate-result.json]`).
In CI the Action generates it with the baseline diff and uploads it as the `eval-report` workflow
artifact (90-day retention); the results branch stores only the JSON, so the HTML is always
reproducible. One file, no server, opens from disk (Google Fonts if online, system fonts if not).
The official `claude plugin eval` writes an HTML report too, so the habit carries over when the
account is enabled.

## Daily operation

Nothing. The `watch` job polls npm every 6 h and runs the suite only when Claude Code shipped.
Push/PR to the plugin path runs it too. Read the job summary; regressions also arrive on Slack.

## When a case goes red

1. Open the job summary, then download the **eval-report** artifact and open `eval-report.html`:
   every run, every grader with its reason, tool calls, and the full response. Locally the same file
   is written as `report.html` next to each `aggregate-result.json`.
2. Classify:
   - **Real regression** (behaviour changed after a Claude Code/model change) → pin
     `claude-code-version` to the last good version in the workflow while you adapt the setup;
     write it up (this is content).
   - **Setup change** you intended → fix the case or re-run with `promote-baseline: true`.
   - **Flaky case** (score varies without cause) → increase `runs` for that case; check the
     scaffold creates the state the prompt assumes; check graders match code, not prose.
   - **Model self-refusal** (0 tool calls, 1 turn) → the case doesn't exercise the hook; change
     the command to one the model will run in a scratch repo.
3. Never loosen `threshold` to make red go away; add runs.

## Promoting a baseline

`workflow_dispatch` with `promote-baseline: true` after an intentional change, or after the first
run. Baselines are per results branch; history keeps every run regardless.

## Cost control

| Lever | Effect |
|---|---|
| `ablation: none` on scheduled runs | halves cost; keep `with-without` for one-off proof |
| `runs` per case | 3 default; 5 for flaky/critical hook cases; 1 for smoke on PRs |
| `model: haiku` for PR smoke, `sonnet` for release runs | 5–10× cheaper smoke |
| `--case` / `--tag` filters on PRs | run only what the PR touched |
| watch interval 6 h (not every version) | coalesces bursts (9 versions in a week observed) |

Measured: $0.045–0.075 per short Sonnet run; $1.00 per 18-run suite.

## Local commands

```bash
node tools/eval-shim.mjs komo-stack --scaffold                       # full, with/without, 3 runs
node tools/eval-shim.mjs komo-stack --case 'guard*' --runs 1 --ablation none --scaffold
node tools/eval-diff.mjs baseline.json current.json --threshold 0.15 --md diff.md
node tools/eval-shim.mjs <plugin> --regrade <results>/aggregate-result.json     # fixed a grader? re-score without re-running
node tools/release-watch.mjs --state .claude-code-version --update
claude plugin eval ./komo-stack --allow-tools Bash --scaffold --json out.json   # when enabled
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "`plugin eval` is currently in early access" | account not enabled | Action falls back to the shim automatically; request access from Anthropic (`/bug` in Claude Code, or a GitHub issue on anthropics/claude-code) |
| shim run `isError: true`, `stderrTail` mentions auth | no `ANTHROPIC_API_KEY` in CI / no credentials locally | set the secret; locally the shim copies `~/.claude/.credentials.json` |
| every case 0 tool calls, 1 turn | prompt asks for something the model refuses in an empty dir | add `case.yaml` scaffold; choose a command the model will run |
| `store` step fails on first run | orphan branch creation quirk | create `eval-results` manually once: `git checkout --orphan eval-results && git rm -rf . && git commit --allow-empty -m init && git push -u origin eval-results` |
| scores differ from the official runner | LLM grader votes (1 vs 2-of-3), unsupported grader types | expected; the official runner is authoritative when available |
