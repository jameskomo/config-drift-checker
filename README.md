# config-drift-checker

**Config Drift Checker for coding-agent setups — CI for your Claude Code configuration.**

Your `CLAUDE.md`, skills and hooks are how your code gets written now. They break silently when
Claude Code ships (it shipped 25 versions in the 30 days before this was written), when the model
behind an alias changes, or when a teammate edits a skill. config-drift-checker turns "what my setup
must do" into test cases in Anthropic's `claude plugin eval` format, runs the real agent against
them on every release and every PR, diffs the result against your baseline, and tells you the day
something regresses — with the reason, not just a score.

- Works with any codebase: it tests the *agent's behaviour*, not your app.
- Runs on your machine and your GitHub Actions with **your** Anthropic API key. No server, nothing sent anywhere.
- Uses Anthropic's official eval format; switches to the official runner automatically where it is enabled.

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

It finds your CLAUDE.md, skills and hooks, writes starter eval cases from them, smoke-runs them,
and writes the GitHub workflow. You add one secret (`ANTHROPIC_API_KEY`) and push. From then on
the suite runs on every Claude Code release and every PR that touches your setup: red check, PR
comment, Slack alert, and an HTML report with every grader's reason.

Already have a suite, or just want the stage? One step:

```yaml
- uses: jameskomo/config-drift-checker/action@v0
  with: { plugin-dir: . }
```

See it end to end on a small Spring Boot service: **[config-drift-checker-demo](https://github.com/jameskomo/config-drift-checker-demo)**.

## What's here

```
config-drift-checker/     the plugin: skills (setup · run · write-case) and the tools they use
  tools/eval-shim.mjs       runs a suite via `claude -p` when the official runner is gated
  tools/eval-diff.mjs       baseline vs current → table, exit 1 on regression
  tools/eval-report.mjs     aggregate-result.json → self-contained HTML report
  tools/release-watch.mjs   "did Claude Code publish a new version?"
  tools/safety-net.mjs      PreToolUse hook injected into every eval run
action/                   composite GitHub Action: install → run → diff → store → report → alert
examples/komo-stack/      an example plugin with a full eval suite and baseline results
docs/                     user guide · architecture · eval format & runner · runbook · security
```

## Documentation

Start with the [user guide](docs/user-guide.md). The full index is in [docs/](docs/README.md).

## Licence

[FSL-1.1-Apache-2.0](LICENSE): free to use, modify and self-host; not to be offered as a competing
commercial service; each release becomes Apache-2.0 two years after publication.
