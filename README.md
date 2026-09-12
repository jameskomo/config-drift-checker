# config-drift-checker

**CI for your Claude Code setup.** Your `CLAUDE.md`, skills and hooks are how your code gets
written now, and everything underneath them moves without asking: Claude Code ships ~25 releases a
month, and the model behind `sonnet` can change server-side with no changelog
([it already has, silently, for weeks](https://www.anthropic.com/engineering/april-23-postmortem)).
This runs your eval suite on every PR and every release, diffs it against a pinned baseline, and
tells you the moment something stops working: when, why, and what moved.

[![tests](https://github.com/jameskomo/config-drift-checker/actions/workflows/test.yml/badge.svg)](https://github.com/jameskomo/config-drift-checker/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/jameskomo/config-drift-checker)](https://github.com/jameskomo/config-drift-checker/releases)

**Proof it works: [we sabotaged our own setup](https://jameskomo.github.io/config-drift-checker/example-break/report.html).**
A skill's trigger description rewritten the way a careless PR would: the suite fell 1.00 → 0.36 and
the tripwire case reads 0.00, "the skill stopped firing". The report is unedited.

[site](https://jameskomo.github.io/config-drift-checker/) · [drift index: our suite on every Claude Code release](https://jameskomo.github.io/config-drift-checker/drift/) · [demo repo](https://github.com/jameskomo/config-drift-checker-demo) · [demo report](https://jameskomo.github.io/config-drift-checker-demo/dashboard/)

## Quick start

One command in the repo whose setup you want protected:

```bash
claude plugin marketplace add jameskomo/config-drift-checker && claude plugin install config-drift-checker@jameskomo && claude "/config-drift-checker:setup"
```

Five minutes: it finds your CLAUDE.md, skills and hooks, writes starter eval cases from them,
smoke-runs them, and writes `.cdc.yml` plus the GitHub workflow. Add one secret
(`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` to run free on a Pro/Max subscription, or
`ANTHROPIC_API_KEY`), push, done.

Already have a suite in the `claude plugin eval` format? One step:

```yaml
- uses: jameskomo/config-drift-checker/action@v0
  with: { plugin-dir: . }
```

## What you get

- **A pinned baseline and a canary.** Pinned model + Claude Code version is what every PR is
  diffed against. The canary runs the alias your developers actually get, on the latest Claude
  Code, only when a release actually shipped. It catches what changes underneath you before it
  reaches everyone.
- **A diff that doesn't cry wolf.** Each case has a noise band learned from its own history: a dip
  inside the band warns instead of failing the build, and guards make sure a real break can never
  hide in the band. Model refusals are labelled as refusals, not setup drift.
- **Red check, PR comment, Slack alert, HTML report, drift index.** Every grader's verdict with
  its reason, tool calls, cost and turns per case, and a Pages-served index of every case across
  every version.
- **Bump PRs.** Two green canaries on a new model or version open a PR that moves your pins, with
  the runs attached as evidence. Renovate did this for packages; nobody did it for models.
- **Hard budget caps.** `.cdc.yml` caps spend per run and per month; the Action refuses to start
  past the cap. A busy release week cannot drain your key. On a Pro/Max subscription token, runs
  cost $0 API credit.
- **Ablation, coverage, repair.** With/without-plugin deltas show what each skill is worth;
  coverage shows which of your rules have no test (`coverage-min` gates it); on a red run a skill
  proposes the smallest setup fix and proves it by re-running the failing cases.

## How this relates to `claude plugin eval`

Claude Code ships an eval runner, and it's good: it runs your cases, grades them, generates
starter cases with `init`, and writes a report. We build on it, not beside it: cases are in that
exact format, the Action prefers the official runner (bundled fallback for older versions), and a
`claude plugin eval . --json out.json` result feeds our diff, report and drift index directly.

| | `claude plugin eval` (built in) | config-drift-checker |
|---|---|---|
| Run cases, grade, report on one run | yes, it's the runner we build on | uses it |
| Generate starter cases | `init` | `/config-drift-checker:setup`, same format |
| A stored baseline to diff against | no, you compare runs by eye | pinned baseline, promoted deliberately |
| History across releases | no, the docs advise pinning your model | every run kept; a drift index over every version |
| Flake vs break | no, a noisy case just fails sometimes | per-case noise bands with anti-masking guards |
| Watching Claude Code and model releases | no | release watch + canary, throttled by your budget |
| Pin bump PRs | no | two green canaries open a PR with evidence |
| Red check, PR comment, Slack | exit code | all three |
| Spend control | a per-run ceiling flag | per-run and per-month caps, enforced from a ledger |
| Coverage of your rules | no | percent, badge, `coverage-min` gate |
| Repair proposal on red | no | a PR with the smallest fix, re-run as proof |

One sentence: their command answers "does my plugin work right now on my machine"; this answers
"did anything stop working since the baseline, across every release, without me watching".

## Trust

Zero npm dependencies (Node builtins only), 74 tests that run against a fake `claude` with no API
key, every third-party action pinned to a verified commit SHA, CodeQL on every push. Runs on your
runner with your key; nothing is sent to us, because there is no us to send it to. Details in
[docs/security.md](docs/security.md).

## What's here

```
config-drift-checker/   the plugin: skills (setup · run · write-case · repair) + the tools
  tools/                shim runner · diff · classify · report · dashboard · coverage · watch · gate · promote · trace-keeper
  test/                 node --test suite, fake claude, npm test
action/                 composite GitHub Action: gate → run → diff → store → PR → repair → alert
examples/komo-stack/    a full example suite with .cdc.yml and baseline results
docs/                   user guide · architecture · eval format & runner · runbook · security
```

## Documentation

Start with the [user guide](docs/user-guide.md) (`.cdc.yml` reference [here](docs/user-guide.md#cdcyml)); full index in [docs/](docs/README.md).

## Licence

[FSL-1.1-Apache-2.0](LICENSE): free to use, modify and self-host; not to be offered as a competing
commercial service; each release becomes Apache-2.0 two years after publication.
