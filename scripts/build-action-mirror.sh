#!/usr/bin/env bash
# Builds the GitHub-Marketplace mirror of the Action (action.yml at repo root + tools/) from this repo.
# Usage: scripts/build-action-mirror.sh <target-dir>
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DST="${1:?target dir}"
# The mirror keeps the main repo's layout under the action: action.yml at the root and the plugin
# (tools, skills, manifest) in config-drift-checker/, so every "$ACTION_PATH/../config-drift-checker"
# in action.yml becomes "$ACTION_PATH/config-drift-checker" and resolves. The old tools/ copy is removed.
rm -rf "$DST/tools" "$DST/config-drift-checker"
mkdir -p "$DST/config-drift-checker"
sed 's#\$ACTION_PATH/\.\./config-drift-checker#$ACTION_PATH/config-drift-checker#g' "$SRC/action/action.yml" > "$DST/action.yml"
for d in tools skills .claude-plugin; do [ -e "$SRC/config-drift-checker/$d" ] && cp -R "$SRC/config-drift-checker/$d" "$DST/config-drift-checker/"; done
cp "$SRC/config-drift-checker/package.json" "$DST/config-drift-checker/"
if grep -q '\.\./config-drift-checker' "$DST/action.yml"; then echo "build-action-mirror: action.yml still points outside the mirror" >&2; exit 1; fi
cp "$SRC/LICENSE" "$DST/LICENSE"
cat > "$DST/README.md" <<'MD'
# config-drift-checker

**CI for your coding agent's instructions.** Your `CLAUDE.md`, skills and hooks decide how your
code gets written, and nothing tests them. Claude Code ships about 25 releases a month, the model
behind an alias changes without a changelog, and a one-line edit can switch a skill off. This
Action runs your eval cases on every pull request and every Claude Code release, against a pinned
baseline, and turns the check red with the reason when something stops working.

**What it caught on our own setup** (all public, unedited):
a careless PR that silently switched off a skill, [diagnosed by its own report](https://jameskomo.github.io/config-drift-checker/example-break/report.html)
and [repaired for $0.28](https://github.com/jameskomo/config-drift-checker/blob/main/docs/example-break/repair-summary.md) ·
Claude Code 2.1.310 refusing shell-based evals on GitHub's Ubuntu runners, caught the day it shipped ·
a suite that caught only [6 of 15 deliberate sabotages](https://jameskomo.github.io/config-drift-checker/mutation/report.html) ·
[our suite on every Claude Code release](https://jameskomo.github.io/config-drift-checker/drift/)

## Quick start

```yaml
name: config-drift-checker
on:
  pull_request: { paths: ['CLAUDE.md', 'AGENTS.md', '.claude/**', 'agent-config/**'] }
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  eval:
    runs-on: ubuntu-latest
    env:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}   # or ANTHROPIC_API_KEY
    steps:
      - uses: actions/checkout@v7
      - uses: jameskomo/config-drift-checker-action@v1
        with: { plugin-dir: . }
```

No eval cases yet? The companion Claude Code plugin writes them from your real setup in about ten
minutes: `claude plugin install config-drift-checker@jameskomo`, then `/config-drift-checker:setup`.
It also writes the full two-track workflow (pinned baseline on PRs, canary on every release).

**Cost:** a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` runs on a Pro/Max subscription with no
extra charge, counted against that plan's usage limits; an `ANTHROPIC_API_KEY` bills the key. Either
way `.cdc.yml` caps spend per run and per month, and the Action refuses to start past the cap.

## What it does

- **Catches breaks:** a pinned baseline on every PR, a canary on every Claude Code release, noise
  bands from history so flakes stay amber and real breaks go red. A release the budget skipped
  shows as untested, never green.
- **Explains them:** whether a skill was never invoked (fix the wording) or never found (fix the
  packaging), whether the model refused, and whether Claude Code or the model moved.
- **Fixes them:** with `repair: true`, the smallest setup fix as a PR, proven by a re-run.
- **Tells you what a PR changes:** tokens it adds to every session, the rules it touches, and the
  cases that test them, as one PR comment.
- **Reports:** check, PR comment, Slack, an HTML report, and a drift index with a status badge.
- **Goes further, with the plugin:** mutation testing of your suite, skill trigger rates, a model
  and version matrix, and the same cases on Codex and Gemini
  ([side by side](https://jameskomo.github.io/config-drift-checker/agents/)).

## Inputs

| input | default | what it does |
|---|---|---|
| `plugin-dir` | required | directory containing `.claude-plugin/plugin.json`, `evals/` and optionally `.cdc.yml` |
| `track` | from `.cdc.yml` | `pinned` (baseline, exact pins) or `canary` (alias model, latest Claude Code) |
| `runs` | case default (3) | runs per case |
| `model` / `judge-model` | from `.cdc.yml` | agent model, and the model behind the LLM graders |
| `ablation` | `none` | `with-without` also runs without your setup and reports what it is worth |
| `scaffold` | `true` | run each case's `scaffold_script` (only for suites you authored) |
| `threshold` | from `.cdc.yml` (0.15) | score drop that counts as a regression |
| `coverage-min` | none | fail when fewer than this percent of your rules have a case |
| `report-base-url` | none | Pages URL of the results history; PR comments deep-link into each run's report |
| `claude-code-version` | from `.cdc.yml` | Claude Code version to test, or `latest` |
| `results-branch` | `eval-results` | where the baseline, history, spend ledger and dashboards live |
| `promote-baseline` | `false` | make this run the new baseline (after an intentional change) |
| `force` | `false` | skip the budget and interval gates on a manual run |
| `open-prs` | `true` | open bump and pin PRs when due |
| `repair` | `false` | on red, propose a verified setup fix as a PR (budget-capped) |
| `slack-webhook-url` | none | Slack alerts on regression |
| `github-token` | `github.token` | token for results, PRs and comments |
| `pages` | `true` | write the drift index and reports for GitHub Pages |
| `preflight` | `warn` | free checks before any model run (skill linter, suite format doctor, context cost per session); `fail` stops early, `off` skips |
| `concurrency` | `1` | agent runs at once, 1 to 8; saves wall-clock time, not cost |
| `pr-impact` | `true` | on pull requests, one comment with tokens added per session, rules changed and the cases that test them |
| `pr-select` | `false` | on pull requests, run only the cases that cover the changed rules (never becomes the baseline) |
| `disallow-tools` | | tools Claude may not use in any case (Claude Code 2.1.299+) |

## More

Full documentation, the plugin, community suites with published worth numbers, fleet mode across
many repos, and an org-wide reusable workflow: **https://github.com/jameskomo/config-drift-checker**.
Zero npm dependencies, nothing sent to any server of ours. Licence: FSL-1.1-Apache-2.0.
MD
printf 'node_modules/\n*.log\n' > "$DST/.gitignore"
echo "mirror built at $DST"
