#!/usr/bin/env bash
# Builds the GitHub-Marketplace mirror of the Action (action.yml at repo root + tools/) from this repo.
# Usage: scripts/build-action-mirror.sh <target-dir>
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DST="${1:?target dir}"
mkdir -p "$DST/tools"
# action.yml: tools live next to it in the mirror
sed 's#${{ github.action_path }}/../config-drift-checker/tools/#${{ github.action_path }}/tools/#g' "$SRC/action/action.yml" > "$DST/action.yml"
cp "$SRC"/config-drift-checker/tools/*.mjs "$DST/tools/"
cp "$SRC/LICENSE" "$DST/LICENSE"
cat > "$DST/README.md" <<'MD'
# config-drift-checker

**Your agent conventions are code. This is their CI.** The rules your team taught its coding agent
(`CLAUDE.md` or `AGENTS.md`, skills, hooks) decide how your software gets written, and they break
silently: Claude Code ships about 25 releases a month, and the model behind an alias changes with
no changelog. This Action runs your eval cases on every PR and every release, diffs them against a
pinned baseline, and tells you the moment something stops working: when, why, and what moved.

**Proof, not promises** (all public, unedited):
[a deliberately broken setup, diagnosed by its own report](https://jameskomo.github.io/config-drift-checker/example-break/report.html) ·
[the repair skill fixing it for $0.28](https://github.com/jameskomo/config-drift-checker/blob/main/docs/example-break/repair-summary.md) ·
[our suite on every Claude Code release](https://jameskomo.github.io/config-drift-checker/drift/) ·
[the per-release verdicts feed](https://jameskomo.github.io/config-drift-checker/drift/feed.xml)

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

No eval cases yet? The companion Claude Code plugin writes them from your real setup in about five
minutes: `claude plugin install config-drift-checker@jameskomo`, then `/config-drift-checker:setup`.
It also writes the full two-track workflow (pinned baseline on PRs, canary on every release).

**Cost:** a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` runs on a Pro/Max subscription with no
extra charge, counted against that plan's usage limits; an `ANTHROPIC_API_KEY` bills the key. Either
way `.cdc.yml` caps spend per run and per month, and the Action refuses to start past the cap.

## What it does

- **Detects:** pinned baseline vs a canary on the latest Claude Code; per-case noise bands learned
  from history so flakes warn instead of failing, with guards so a real break can't hide in a band;
  model refusals labelled as refusals; slower, pricier or longer runs flagged even when cases pass.
- **Diagnoses:** a failed skill case says whether the skill was never discovered (fix the packaging)
  or discovered but never invoked (fix the trigger wording); every report lists the whole suite,
  every skill and whether it fired, and exactly which checks ran.
- **Repairs:** with `repair: true`, a red run gets the smallest setup fix as a PR, verified by
  re-running the failing cases; two proven-green canaries open the PR that moves your pins.
- **Reports:** red or green check, PR comment, Slack alert, an HTML report artifact, and a drift
  index with a stability streak and status badge on GitHub Pages.
- **Across agents:** the same cases also run through OpenAI's Codex and Google's Gemini CLIs
  (experimental), so the rules you wrote once stay testable wherever your agent goes next.

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
| `preflight` | `warn` | free checks before any model run (skill linter, suite format doctor); `fail` stops early, `off` skips |

## More

Full documentation, the plugin, community suites with published worth numbers, fleet mode across
many repos, and an org-wide reusable workflow: **https://github.com/jameskomo/config-drift-checker**.
Zero npm dependencies, nothing sent to any server of ours. Licence: FSL-1.1-Apache-2.0.
MD
printf 'node_modules/\n*.log\n' > "$DST/.gitignore"
echo "mirror built at $DST"
