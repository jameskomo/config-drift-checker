# User guide

Everything from install to reading a red report. What the tool is and how it relates to
`claude plugin eval` is in the [README](../README.md); this page assumes you want it running.

Live example: [our drift index](https://jameskomo.github.io/config-drift-checker/drift/) (this
plugin's own suite on every Claude Code release) · [demo repo](https://github.com/jameskomo/config-drift-checker-demo) · [demo report](https://jameskomo.github.io/config-drift-checker-demo/dashboard/)

## 1. Install (once per machine)

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
```

You now have four skills in Claude Code (`/config-drift-checker:setup`, `:run`, `:write-case`,
`:repair`) and the runner tools inside the plugin. Nothing has touched any repo yet.

## 2. Set up a repo (10 minutes, mostly watching)

In the repo whose setup you want protected:

```
claude "/config-drift-checker:setup"
```

Claude will:

1. **Find your setup**: `CLAUDE.md`, `.claude/skills`, hooks, or a plugin manifest. If `.claude/`
   is gitignored it uses `agent-config/` instead; if you have no agent config yet, it proposes one
   from your code and asks first.
2. **Write starter cases from your real content**: a skill case (real-code where possible), a
   negative-trigger case, a hook case (stubbed so nothing real can be harmed). Each case lists the
   rules it covers in a `covers.yaml`, which is where the coverage number comes from.
3. **Smoke-run them** and show every grader's verdict, fixing graders that fail for the wrong reason.
4. **Write `.cdc.yml`** (pins and budget, see the [reference](#cdcyml)) and the GitHub workflow,
   and offer to set your secrets.

Review the diff like any PR. Commit.

## 3. Wire CI (the parts only you can do)

**One auth secret**, either kind:

- `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` (Pro/Max/Team/Enterprise) and paste the
  result. Runs then use your subscription, $0 API credit. This is
  [Anthropic's documented CI path](https://code.claude.com/docs/en/github-actions#manual-setup).
  The token is tied to the person who generated it.
- `ANTHROPIC_API_KEY` (console.anthropic.com): better for an org-wide secret. Runs bill prepaid
  credit, so add a few dollars first; with none, runs fail with "Credit balance is too low" and
  nothing is stored. If both secrets are set, the API key wins.

**Two repo settings** (Settings → Actions → General): workflow permissions *Read and write* (results
are stored on an `eval-results` branch, PRs get comments), and *Allow GitHub Actions to create and
approve pull requests* (for bump/pin/repair PRs; without it the branch is pushed and the job warns).

**Optional**: a `SLACK_WEBHOOK_URL` secret for regression alerts.

Then: Actions → **config-drift-checker** → *Run workflow*. The first run records your **baseline**
and, if `.cdc.yml` has no pin yet, opens a **pin PR** with the exact model id and Claude Code
version the baseline was measured on.

## 4. Adding the check to an existing pipeline (no Claude Code needed)

Already have a suite, or a teammate ran `setup`? The CI half is one step:

```yaml
# .github/workflows/config-drift-checker.yml: pinned track on push/PR, on demand otherwise
on:
  push: { branches: [main], paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  pull_request: { paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  workflow_dispatch:
    inputs:
      track: { description: 'pinned | canary', default: 'pinned' }
      force: { description: 'skip the budget and interval gates', type: boolean, default: false }
permissions: { contents: write, pull-requests: write }
jobs:
  eval:
    runs-on: ubuntu-latest
    env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }   # your key; runs bill to you
    steps:
      - uses: actions/checkout@v7
      - uses: jameskomo/config-drift-checker/action@v0             # ← the whole check
        with:
          plugin-dir: .                        # where .claude-plugin/plugin.json lives
          track: ${{ inputs.track || 'pinned' }}
          force: ${{ inputs.force || 'false' }}
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}   # optional
```

That step reads `.cdc.yml`, checks the budget gate, installs the pinned Claude Code, runs the
suite, diffs against your baseline (score and turns/cost/time), stores results, comments on the
PR, uploads the `eval-report` artifact, opens a pin/bump PR when due, posts to Slack on
regression, and sets the check.

**Add the canary** (latest model and Claude Code, on a schedule, only when something shipped) with
the `watch` job from the full template at `ci/config-drift-checker.yml` in the plugin; that is what
`setup` writes. The canary never fails your PR check.

**Gate merges on it**: branch protection → *Require status checks to pass* → add `eval`.

**Useful inputs:**

| Input | What it does |
|---|---|
| `runs: 1`, `model: haiku` | cheap PR smoke |
| `ablation: with-without` | measure what each skill is worth (run once, not in every CI run) |
| `promote-baseline: true` | after an intentional setup change |
| `repair: true` | on red, the agent proposes a fix PR (spends credit, budget-capped) |
| `open-prs: false` | no bump/pin PRs |
| `claude-code-version: 2.1.258` | override the pin for this run |
| `coverage-min: 80` | fail when under 80% of your rules have a case (empty = report only) |
| `report-base-url: https://<you>.github.io/<repo>/history` | case names in the PR comment deep-link into that run's HTML report (needs Pages serving the results branch) |

**Which path is for me?**

| You are | Do |
|---|---|
| a developer with Claude Code who wants the cases written for you | §2 `setup`, then push |
| a platform team adding a stage to an existing pipeline | this section: the step, the secret, the two repo settings |
| on GitLab / Buildkite / other CI | run the tools directly: `node <plugin-root>/tools/eval-shim.mjs <plugin> --track pinned --scaffold` then `eval-diff.mjs --config <plugin>`; the Action is a thin wrapper around them |

<a id="cdcyml"></a>
## 5. `.cdc.yml` reference

One file at the plugin root says what is pinned, what floats, and how much may be spent.
`node <plugin-root>/tools/cdc-config.mjs <plugin> init` writes it with comments; `setup` does it for you.

```yaml
track: pinned            # default track for a run; the Action passes --track explicitly
model:
  pinned: claude-sonnet-5   # exact model id the baseline is measured on (null = alias until the pin PR)
  canary: sonnet            # the alias your developers actually get; resolved at run time
harness:
  pinned: 2.1.258           # @anthropic-ai/claude-code version for the baseline (null = latest)
  canary: latest
judge_model: haiku
canary:
  runs: 1                   # one run per case, then…
  expand_on_deviation: 2    # …two more only if a grader failed (sequential testing)
  promote_after: 2          # consecutive green canaries before a bump PR is opened
  min_interval_hours: 72    # never canary more often than this on a schedule
thresholds:                 # relative change that counts as drift
  score: 0.15
  turns: 0.5
  cost: 0.5
  duration: 0.5
fail_on: [score]            # which drifts turn the check red; the rest are warnings
budget:
  per_run_usd: 2            # the runner stops starting agent runs past this
  per_month_usd: 10         # the Action refuses to start a run past this (ledger on eval-results)
noise:
  history_runs: 10          # past runs that set each case's noise band in the diff
baseline:
  min_runs: 3               # a run with fewer scored runs per case is refused as a baseline
```

**Two tracks.** *Pinned*: same model id, same Claude Code version, only your setup changes; that is
the PR check and the baseline. *Canary*: the alias model on the latest Claude Code, what your
developers get today. A canary regression is an alert, never a red PR check, and never touches the
baseline. Every report stamps the resolved model and version, so a red row is always attributable
to your change, the model, or the harness.

**Bump and pin PRs.** After `promote_after` consecutive green canaries on the same model and
version, a PR proposes moving your pins there, runs attached as evidence. A pinned run with no pin
declared gets a PR pinning what the baseline actually measured. Neither is ever auto-merged; close
one and it proposes again after the next streak.

**Budget.** `per_run_usd` stops the runner mid-suite (what ran is kept; skipped cases show ❔, not
red). `per_month_usd` is checked before a run starts, against the ledger on your results branch; a
run past the cap is skipped with a notice, not failed. A manual run with `force: true` overrides
both, because the person clicking is the budget.

**Noise.** One model refusal can swing a 3-run case by 0.33, well past a flat 0.15 threshold, so
the diff learns each case's noise band instead of guessing:

- The band is the spread (max minus min) of the case's run scores across the baseline plus the
  newest `noise.history_runs` runs on the same track.
- A drop past the threshold but inside the band is **noisy**: an amber warning, never red.
- Two escalations keep the band honest: if no current run reaches the baseline score (a uniform
  shift, not a flake), or the case was already down in the last two runs, it is red anyway. One
  old flake can never widen the band into a blind spot.
- Runs that took one turn with no tool calls and a short reply, on a case whose baseline acts,
  get a *likely refusals* note: that is a model guardrail change, not setup drift.
- More runs per case shrink the band. Never loosen the threshold.
- A baseline with fewer scored runs than `baseline.min_runs` is warned about in diffs and refused
  as a new baseline.

## 6. What happens from now on (automatic)

- **Every push/PR touching the setup**: the pinned track runs, diffs against the baseline, sets
  the check.
- **On the schedule**: `release-watch` checks npm and Anthropic's model list. Nothing new means
  nothing runs and nothing costs. Something new means the canary runs, at most once per
  `min_interval_hours`, inside the monthly budget.
- **Canary green twice** on a new model or version: a bump PR. **Canary red**: Slack, job summary,
  and the drift index says *baseline holding · canary red*.
- After an intentional setup change: *Run workflow* with **promote-baseline** ticked.

Results, spend ledger, canary streak and release-watch state all live on the `eval-results`
branch: history without a database.

## 7. Reading a report

Every run produces the same report (job summary plus the `eval-report` artifact, or `report.html`
locally). It opens with the verdict; the stamp says which model and Claude Code version ran,
whether either moved since the baseline, and how many of the suite's cases this run evaluated
(cases not run, from a filter or a budget stop, are listed under the table so nothing is silently
absent). A panel under the verdict counts every grader verdict and agent run and marks which
checks come from this tool's layer versus a plain `claude plugin eval` run; a second panel lists
every skill discovered at run start and whether any case invoked it.

| The report says | Do this |
|---|---|
| **No drift** / **baseline recorded** | Nothing. Glance at the stamp. |
| **N case(s) regressed** | Open the red case(s) and classify each failing run: |
| ↳ *refused or asked before acting* (1 turn, no tool calls) | the case never reached your skill/hook. Rewrite the scenario so the model will attempt it |
| ↳ *skill or hook did not fire* | a real regression. The stamp says whether the model or Claude Code moved. Keep the pins, fix or adapt the setup (or `/config-drift-checker:repair`), tell the maintainers |
| ↳ a note says *discovered but never invoked* | the skill file is fine; its trigger description no longer matches. Fix the wording, not the packaging |
| ↳ a note says *not discovered: packaging* | the skill file itself is missing, renamed or malformed. Fix the packaging, not the wording |
| ↳ *grader wrong* (matched prose, a negation) | fix the grader, then `--regrade` the saved run; don't re-spend the suite |
| ↳ *flaky* (mixed verdicts across runs) | raise `runs` for that case. Never loosen the threshold |
| **efficiency drift** (*slower*, *pricier*, *longer*) | every case passes but median turns/cost/time moved. A warning by default; add to `fail_on` to make it red |
| **⚠ noisy** | dropped past the threshold but inside the historical band, with at least one run still at baseline. A warning; more runs shrink the band |
| *likely refusals* note | the model declined the task (guardrail change), your setup did not break. Read the transcript; consider rewording the prompt. A full answer without tools is the opposite: real drift |
| **⚠ baseline quality** (*thin* / *unstable*) | the baseline has too few runs or varies; re-baseline with more runs. Never red |
| **⚠ agent runs errored** | read the first error. Usually no prepaid credit, or a Claude Code startup failure. Nothing was stored |
| a run shows **max_turns** (amber) | cut short and scored as-is; raise that case's `max_turns` (real-code cases need about 20) |
| **skipped: budget / interval** | not a failure. Raise the cap, wait, or re-run with `force` |

In one sentence: a green report asks nothing of you; a red one tells you which of four things
happened (the model refused, the setup regressed, the grader was wrong, or the run was flaky) and
what to do.

## 8. The drift index

Every CI run also writes a dashboard to the `eval-results` branch under `docs/`: the verdict,
pinned baseline vs latest canary, budget spent, coverage, a ribbon of every case over every run,
score per case over Claude Code versions, and a linked run list. Publish it: Settings → Pages →
Source: branch `eval-results`, folder `/docs`. Turn it off with `pages: 'false'` on the Action.

- Ours: https://jameskomo.github.io/config-drift-checker/drift/
- Coverage badge: `![agent-config coverage](https://raw.githubusercontent.com/<you>/<repo>/eval-results/docs/coverage.svg)`
- Locally: `node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html`

## 9. Local commands

```bash
/config-drift-checker:run                      # inside Claude Code: run, diff, explain red
/config-drift-checker:repair                   # after red: smallest setup fix, verified, PR-ready summary
node <plugin-root>/tools/eval-shim.mjs <plugin> --scaffold                  # everything, with/without ablation
node <plugin-root>/tools/eval-shim.mjs <plugin> --track canary --scaffold   # what developers get today
node <plugin-root>/tools/eval-shim.mjs <plugin> --case 'guard*' --runs 1 --ablation none --scaffold --budget 0.5
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json --config <plugin>   # exit 1 on red
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json --history evals/results --config <plugin>   # + noise bands
node <plugin-root>/tools/baseline-check.mjs aggregate-result.json --config <plugin>   # exit 1 if not baseline material
node <plugin-root>/tools/eval-report.mjs current.json --baseline baseline.json --config <plugin>
node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html
node <plugin-root>/tools/config-coverage.mjs <plugin> --list       # rule ids to put in a case's covers.yaml
node <plugin-root>/tools/config-coverage.mjs <plugin> --fail-under 80   # exit 1 under 80% coverage
node <plugin-root>/tools/cdc-config.mjs <plugin> init              # write .cdc.yml; set-pins --model … --harness …
node <plugin-root>/tools/release-watch.mjs --state .release-watch.json --models --pin claude-sonnet-5
node <plugin-root>/tools/trace-keeper.mjs out.json --clean         # after claude plugin eval --keep-temp: keep transcripts
```

`<plugin-root>` is where Claude Code installed the plugin (`claude plugin list` shows it). Every
run writes `aggregate-result.json` and `report.html` into `<your-plugin>/evals/results/<timestamp>/`.

## 10. Cost (measured)

$0.05 to $0.08 per short Sonnet run; $0.20 to $0.25 per real-code run. A 3-case suite at 3 runs is
about $0.43 per pinned run; a canary at 1 run per case is $0.15 to $0.20. With
`min_interval_hours: 72`, 25 Claude Code releases a month collapse into at most about 10 canaries,
and `budget.per_month_usd` is the hard ceiling whatever npm publishes. On a subscription token,
API cost is $0. Use `ablation: none` in CI and Haiku for PR smoke.

## 11. Safety

Workspaces are throwaway directories, not sandboxes for Docker, the network or your host. Every
run carries a safety-net hook that blocks `docker compose down -v`, prunes, force-pushes, `rm -rf`
outside the workspace, `DROP TABLE` and similar, in both arms. Write hook cases so the command is
harmless when it succeeds: a scratch git repo, or a stub binary in `.eval-bin/` (the `setup` skill
does this for you). Read third-party suites before running them with `--scaffold`. The `repair`
skill may edit `CLAUDE.md`, skills and hooks only, never a case or grader, and every PR it opens
carries its re-run evidence and is never auto-merged.

## 12. See it work: the demo repo

[config-drift-checker-demo](https://github.com/jameskomo/config-drift-checker-demo) is a small
Spring Boot notes API with a typical setup: CLAUDE.md, one conventions skill, one guard hook.
`/config-drift-checker:setup` ran against it unattended (78 turns, 13 minutes, $1.68) and wrote
three cases from the real content: a real-code case that asks for a feature the API doesn't have
and grades the diff, a negative-trigger case, and a guard-hook case in a scratch git repo. It
smoke-ran them, fixed two of its own graders, and reached 1.00. Everything it produced is in the
repo as generated, run log included. Read those three cases first; they are the best starting
point for writing your own.

## 13. FAQ

**Isn't this what `/doctor` or `/skill-doctor` does?** No. Those are static health checks: they
never run the agent. A setup can be perfectly well-formed and silently useless after a release.
This runs real tasks and compares behaviour with your baseline. Linter versus test suite.

**Will this drain my API key?** Not past `budget.per_month_usd`. The gate reads the ledger before
every run and skips with a notice at the cap; the runner stops mid-run at `per_run_usd`; scheduled
canaries are throttled by `min_interval_hours`.

**Do the bump / pin / repair PRs merge themselves?** Never. They carry the evidence; you decide.

**What if my pinned model is retired?** `release-watch --pin` warns when the id disappears from
Anthropic's model list; the next green canary streak opens a bump PR to a current id.

**Does installing the plugin change my repos?** No. Only `setup` writes files, only in the repo
you run it in, as a reviewable diff.

**Does pushing a repo trigger Actions/Slack by itself?** Only if that repo has the workflow file
and the secrets. No workflow file, nothing runs. No key, the run fails loudly.

**Do I need Anthropic's `claude plugin eval`?** It ships with current Claude Code and the Action
prefers it automatically; the bundled runner covers older versions. Both read the same case
format, and a `claude plugin eval ... --json out.json` result diffs directly against any baseline.
One caveat: the official runner keeps transcripts in a temp trace, so refusal labelling needs
`--keep-temp` plus `tools/trace-keeper.mjs` (see the runbook).

**Where does my code go?** Into a temporary directory on your runner for one run, then deleted.
Results stay in your repo's `eval-results` branch and the workflow artifact. We operate no server.

**Can I test CLAUDE.md rules?** Yes. Cases copy your `CLAUDE.md` into the workspace via
`scaffold_script`, so the rule is in force during the run and the grader checks the outcome.

**Codex / Gemini / Cursor?** Planned. The runner is "spawn a headless agent, grade the trace"; the
case format and `.cdc.yml` are agent-agnostic (`agent:` is reserved).

**Licence?** FSL-1.1-Apache-2.0: free to use, modify and self-host in your own CI; not to be
offered as a competing commercial service; each release becomes Apache-2.0 two years after
publication.

**Uninstall:** delete the workflow file, `.cdc.yml` and the `evals/` folder;
`claude plugin uninstall config-drift-checker@jameskomo`.
