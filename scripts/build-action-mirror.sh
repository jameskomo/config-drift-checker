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
# config-drift-checker — GitHub Action

**CI for your Claude Code configuration.** Runs your `claude plugin eval` suite against the real
agent on every Claude Code release and every PR, diffs against your baseline, stores history on an
`eval-results` branch, comments on PRs, uploads an HTML report, alerts Slack, and sets the check.

```yaml
on:
  schedule: [{ cron: '17 */6 * * *' }]      # release-watch: runs only when Claude Code shipped
  pull_request: { paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  eval:
    runs-on: ubuntu-latest
    env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }   # your key — runs bill to you
    steps:
      - uses: actions/checkout@v6
      - uses: jameskomo/config-drift-checker-action@v0
        with: { plugin-dir: . }
```

| input | default | |
|---|---|---|
| `plugin-dir` | — | directory containing `.claude-plugin/plugin.json` and the eval cases |
| `runs` | case default (3) | runs per case |
| `model` / `judge-model` | `sonnet` / `haiku` | agent and LLM-grader models |
| `ablation` | `none` | `with-without` runs a no-plugin arm and reports the delta |
| `scaffold` | `true` | run each case's `scaffold_script` (only for suites you authored) |
| `threshold` | `0.15` | score drop that counts as a regression |
| `claude-code-version` | `latest` | pin the Claude Code version under test |
| `results-branch` | `eval-results` | where `baseline.json` and `history/` are stored |
| `promote-baseline` | `false` | overwrite the baseline with this run |
| `slack-webhook-url` | — | incoming-webhook URL for regression alerts |

Outputs: `regressed`, `runner` (official or shim), `claude-version`, `result-path`.

Writing the cases, and the Claude Code plugin that generates them from your setup:
**https://github.com/jameskomo/config-drift-checker**. Licence: FSL-1.1-Apache-2.0.
MD
printf 'node_modules/\n*.log\n' > "$DST/.gitignore"
echo "mirror built at $DST"
