# config-drift-checker

**CI for your agent setup.** Your `CLAUDE.md`, skills and hooks are how your code gets written now,
and everything underneath them moves without asking you. Claude Code shipped about 25 releases in a
single month, and the model behind `sonnet` can change server-side with no changelog.
[It already has, silently, for weeks.](https://www.anthropic.com/engineering/april-23-postmortem)
This tool runs the real agent against what your setup is supposed to do, on every PR and every
release, and tells you the moment it stops: when, why, and what moved.

[![tests](https://github.com/jameskomo/config-drift-checker/actions/workflows/test.yml/badge.svg)](https://github.com/jameskomo/config-drift-checker/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/jameskomo/config-drift-checker)](https://github.com/jameskomo/config-drift-checker/releases)

[site](https://jameskomo.github.io/config-drift-checker/) · [drift index: our own suite on every Claude Code release](https://jameskomo.github.io/config-drift-checker/drift/) · [**what a break looks like**: a sabotaged skill, 1.00 → 0.36](https://jameskomo.github.io/config-drift-checker/example-break/report.html) · [demo: interactive report](https://jameskomo.github.io/config-drift-checker-demo/dashboard/) · [demo: trend](https://jameskomo.github.io/config-drift-checker-demo/)

You get a pinned baseline, a canary on the latest release, a bump PR once the canary has proven a
new model, and a budget your key cannot exceed. The diff is engineered not to cry wolf, because a
checker that pages you for flakes gets uninstalled within a week.

## What it is

Your CLAUDE.md, skills and hooks are configuration that other people change underneath you. Claude
Code shipped 25 versions in the 30 days before this was written, the model behind `sonnet` changes
server-side with no changelog, and a colleague can edit a skill in a PR nobody tests. Today you find
out when a developer notices "it stopped running the tests before committing", often weeks later.

config-drift-checker turns what your setup must do into test cases, runs the real agent against
them, and keeps score over time:

1. **Cases** in Anthropic's own `claude plugin eval` format: a prompt, graders (regex, tool-use,
   file, LLM rubric), and an optional scaffold that sets up a scratch repo or copies your real
   source. `/config-drift-checker:setup` writes the first ones from your actual setup, so you don't
   start from a blank page.
2. **Two tracks.** *Pinned* is an exact model id and Claude Code version, the baseline every PR is
   diffed against. *Canary* is the alias your developers actually get, on the latest Claude Code,
   run on a schedule only when npm or Anthropic's model list moved. It tests what changes underneath
   you before it reaches everyone.
3. **Scores and reasons.** Every grader's verdict and the judge's explanation, the tool calls, and
   the full response, not just a number. Turns, cost and time per case are diffed too, so a release
   that makes the agent twice as chatty shows up before it becomes a habit.
4. **A diff against your baseline** that lands as a red or green check, a PR comment, a Slack alert,
   an HTML report that opens with the verdict and stamps which model and Claude Code version ran
   (and whether either moved), and a **drift index** of every case over every version, served from
   your results branch by GitHub Pages. The diff knows each case's historical noise band: a dip
   within a case's own observed wobble is a warning, not a red build. A drop where no run recovers,
   or one that persists across runs, stays red, so the allowance can never hide a real break. Runs
   where the model refused the task are labelled as refusals, because a guardrail change is not your
   setup breaking.
5. **Bump PRs.** Two green canaries on a new model or version produce a PR that moves your pins
   there, with the runs attached as evidence. Never auto-merged. Renovate did this for packages;
   nobody did it for models.
6. **A budget.** `.cdc.yml` caps spend per run and per month. The Action refuses to start past the
   cap and throttles scheduled canaries, so a busy release week cannot drain your key.

Three things ride on top of that core:

- **Ablation.** The same cases run with and without your plugin, and the delta tells you what each
  skill or hook is actually worth. In our demo, the guard hook is the only thing that reliably stops
  a destructive command, while a conventions skill turned out to add nothing the codebase and
  CLAUDE.md didn't already carry.
- **Coverage.** Which rules in your CLAUDE.md, skills and hooks have a case, and which are untested:
  a number, a badge, and the list of what to write next. The `coverage-min` input fails the check
  when your setup grows faster than its tests.
- **Repair.** On a red run, a skill proposes the smallest change to your setup that restores the
  behaviour, re-runs the failing cases to prove it, and hands you a PR with the evidence. It fixes
  the setup, never the test.

**What it is not:** a linter for CLAUDE.md (it runs the real agent), a test of the model's general
quality (it tests your configuration on your tasks), or a hosted service (it runs on your machine
and your CI with your key; nothing is sent anywhere).

It works with any codebase, because it tests the agent's behaviour rather than your app. It uses the
official runner automatically where `claude plugin eval` is enabled, and a bundled runner otherwise.
Zero npm dependencies; 71 tests run against a fake `claude`, so the suite needs no API key.

**What it costs to run:** on a Claude Pro/Max plan, nothing extra. `claude setup-token` gives CI a
subscription token, and eval runs then spend no API credit. On an API key, `.cdc.yml` caps spend per
run and per month in the product itself rather than by discipline, and a typical 3-case suite costs
cents per run.

## Install

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
```

Then, in the repo whose setup you want protected:

```
claude
> /config-drift-checker:setup
```

Five minutes: it finds your CLAUDE.md, skills and hooks, writes starter eval cases from them,
smoke-runs them, and writes `.cdc.yml` and the GitHub workflow. You add one secret
(`ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` to run on your
subscription), two repo settings, and push. From then on the suite runs on every PR that touches
your setup and canaries every Claude Code release: red check, PR comment, Slack alert, bump PRs,
and an HTML report with every grader's reason.

Already have a suite, or just want the stage? One step:

```yaml
- uses: jameskomo/config-drift-checker/action@v0
  with: { plugin-dir: . }
```

See it end to end on a small Spring Boot service: **[config-drift-checker-demo](https://github.com/jameskomo/config-drift-checker-demo)**.
And see it fail on purpose. We rewrote a skill's trigger description the way a careless PR would and
re-ran the suite; [the red report](https://jameskomo.github.io/config-drift-checker/example-break/report.html)
diagnoses itself. The skill-trigger tripwire case drops to 0.00 ("the skill stopped firing") while
the content cases only sag partway, because the agent still writes decent code, just not your
conventions.

## What's here

```
config-drift-checker/     the plugin: skills (setup · run · write-case · repair) and the tools they use
  tools/eval-shim.mjs       runs a suite via `claude -p`: tracks, sequential runs, per-run budget, provenance
  tools/cdc-config.mjs      .cdc.yml: pins, canary, thresholds, budget; set-pins rewrites in place
  tools/eval-diff.mjs       baseline vs current → score + efficiency drift, exit by fail_on
  tools/eval-classify.mjs   the shared per-case verdict (noise band, escalations): diff, report, dashboard
  tools/release-watch.mjs   did Claude Code (npm) or the model list (/v1/models) move? is the pin retired?
  tools/cdc-gate.mjs        monthly budget ledger and canary interval, the two things that protect your key
  tools/canary-promote.mjs  green streak → bump PR; unpinned baseline → pin PR
  tools/baseline-check.mjs  is this run good enough to become the baseline? (scored-run count, errors)
  tools/config-coverage.mjs rules in CLAUDE.md / skills / hooks vs cases' covers: → %, badge
  tools/eval-report.mjs     aggregate-result.json → self-contained HTML report (verdict, stamp, runs)
  tools/eval-dashboard.mjs  results history → the drift index (ribbon, chart, budget, coverage)
  tools/safety-net.mjs      PreToolUse hook injected into every eval run
  test/                     node --test suite with a fake `claude`; `npm test`
action/                   composite GitHub Action: gate → run → diff → store → PR → repair → alert
examples/komo-stack/      an example plugin with a full eval suite, .cdc.yml and baseline results
docs/                     user guide · architecture · eval format & runner · runbook · security
```

## Documentation

Start with the [user guide](docs/user-guide.md) (the `.cdc.yml` reference is [here](docs/user-guide.md#cdcyml)). The full index is in [docs/](docs/README.md).

## Licence

[FSL-1.1-Apache-2.0](LICENSE): free to use, modify and self-host; not to be offered as a competing
commercial service; each release becomes Apache-2.0 two years after publication.
