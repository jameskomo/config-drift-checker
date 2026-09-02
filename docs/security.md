# Security & privacy

## Scanning

- **Zero runtime dependencies.** `config-drift-checker/tools/*.mjs` import only Node builtins
  (`node:fs`, `node:child_process`, `node:path`, …) — nothing from npm ships with the plugin, so
  there's no third-party package to be compromised via a supply-chain attack.
- **CodeQL** static analysis runs on every push/PR to `main` and weekly
  ([`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml)); results are in this repo's
  Security tab.
- **Dependabot** watches GitHub Actions pins (and npm, if dependencies are ever added) for known
  CVEs ([`.github/dependabot.yml`](../.github/dependabot.yml)).
- The code itself is public — read `tools/`, `action/`, and `skills/` directly rather than taking
  our word for it.

## What runs where — and what we see (nothing)

- The agent runs in **your** GitHub runner with **your** API key
  (`ANTHROPIC_API_KEY` secret → env → `claude`). No call to any service of ours exists.
- Prompts, transcripts, tool calls, files the agent creates, and results live in your
  workflow logs and `eval-results` branch. Make that repo private if the suite touches real code.
- `case.yaml` `scaffold_script` runs arbitrary bash as the runner user — only when
  `scaffold: true`, and only for suites you authored. Treat third-party suites like third-party
  CI: read them first.
- The shim creates a fresh `CLAUDE_CONFIG_DIR` per run (locally it copies your credentials file
  in and deletes the dir afterwards) so evals never see your personal settings or global CLAUDE.md,
  and never write to them.
- Tools available to the agent are exactly the case's `allowed_tools`; everything else is denied
  (`--permission-mode dontAsk`). **Network, Docker, and the host are not sandboxed** in v0.1 —
  same as the official runner. On 2026-08-27 a without-arm run tore down a real Docker stack
  from a throwaway workspace . Since then every run carries a **safety-net
  PreToolUse hook** that blocks host-global destructive commands in both arms; cases that must
  run such a command stub the binary in `.eval-bin/`. `--no-safety-net` exists and is dangerous.
- Hook cases must be harmless when the command *succeeds* (the without-arm has no guard by
  design): scratch git repos, stubbed binaries, never the real service.
- **Spend is capped by you.** `.cdc.yml` `budget.per_run_usd` stops the runner mid-suite;
  `budget.per_month_usd` makes the Action refuse to start (a notice, not a red check) from the ledger
  on your results branch; scheduled canaries are throttled by `canary.min_interval_hours`. The only
  network calls the tools make themselves are `npm view` and `GET /v1/models` with your key.
- **PRs the Action opens** (bump, pin, repair) come from a bot identity on a `cdc/*` branch, carry
  their evidence in the body, and are never merged by us. They need *Allow GitHub Actions to create
  and approve pull requests* (Settings → Actions → General); without it the branch is pushed and the
  job warns. The `repair` skill may edit `CLAUDE.md`, skills and hooks only — never `evals/` — and runs
  under the remaining monthly budget with a hard cap of $2 per incident.
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; Pro/Max/Team/Enterprise) is accepted as an
  alternative to an API key and passed straight to the official CLI — the same mechanism Anthropic
  documents for its own GitHub Action. It is a long-lived credential tied to one person's
  subscription: store it only as an Actions secret, rotate it by running `setup-token` again, and
  prefer an API key for anything shared across an organisation.
