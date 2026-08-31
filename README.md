# config-drift-checker

**CI for your agent setup.** · [site](https://jameskomo.github.io/config-drift-checker/) · [demo: trend dashboard](https://jameskomo.github.io/config-drift-checker-demo/) · [demo: interactive report](https://jameskomo.github.io/config-drift-checker-demo/dashboard/) · [demo: static report](https://jameskomo.github.io/config-drift-checker-demo/report.html)

A tool that tells your team **when** its coding-agent setup — `CLAUDE.md`, skills, hooks — stopped
doing what it should, **why**, and **what changed**: a model change behind an alias, a Claude Code
release, or a teammate's edit.

## What it is

Your CLAUDE.md, skills and hooks are how your code gets written now. They are configuration that
other people change underneath you: Claude Code shipped 25 versions in the 30 days before this was
written, the model behind `sonnet` changes server-side with no changelog, and a colleague can edit
a skill in a PR nobody tests. Today you find out when a developer notices "it stopped running the
tests before committing" — often weeks later.

config-drift-checker turns *what your setup must do* into test cases, runs the real agent against
them, and keeps score over time:

1. **Cases** in Anthropic's own `claude plugin eval` format — a prompt, graders (regex, tool-use,
   file, LLM rubric), an optional scaffold that sets up a scratch repo or copies your real source.
   `/config-drift-checker:setup` writes the first ones *from your actual setup*, so you don't start
   from a blank page.
2. **Runs** on every Claude Code release (a watcher polls npm), on every PR that touches the setup,
   and on demand — in a throwaway workspace, with your plugin loaded, several times per case.
3. **Scores and reasons**: every grader's verdict and the judge's explanation, the tool calls, the
   full response — not just a number.
4. **Diff against your baseline** → red or green check, PR comment, Slack alert, HTML report, and a
   dashboard of every case over every Claude Code version, served from your results branch by GitHub Pages.

Two things ride on top of that core:

- **Ablation** — the same cases run *with* and *without* your plugin. The delta tells you what each
  skill or hook is actually worth: in our demo the guard hook is the only thing that reliably stops
  a destructive command, and a conventions skill turned out to add nothing the codebase and
  CLAUDE.md didn't already carry.
- **Generated cases** — the setup skill reads your configuration and writes real-code cases,
  negative-trigger cases and hook cases for it, then repairs its own graders until the smoke run
  passes.

**What it is not:** a linter for CLAUDE.md (it runs the real agent), a test of the model's general
quality (it tests *your* configuration on *your* tasks), or a hosted service (it runs on your
machine and your CI with your key; nothing is sent anywhere).

Works with any codebase — it tests the agent's behaviour, not your app. Uses the official runner
automatically where `claude plugin eval` is enabled, a bundled runner otherwise.

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
  tools/eval-dashboard.mjs  results history → dashboard (score per case over versions, run list)
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
