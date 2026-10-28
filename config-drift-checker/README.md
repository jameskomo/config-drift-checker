# config-drift-checker (the plugin)

CI for your coding-agent setup. This folder is the Claude Code plugin: four skills and the tools the
GitHub Action runs. The full story, the live examples and the comparison with `claude plugin eval`
are in the [main README](https://github.com/jameskomo/config-drift-checker#readme); every feature
is explained in the [user guide](https://github.com/jameskomo/config-drift-checker/blob/main/docs/user-guide.md).

## Install

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
claude "/config-drift-checker:setup"
```

## Skills

| Skill | What it does |
|---|---|
| `/config-drift-checker:setup` | finds your CLAUDE.md, skills and hooks, writes starter cases, smoke-runs them, writes `.cdc.yml` and the workflow |
| `/config-drift-checker:run` | runs the suite, diffs it against the baseline, explains anything red |
| `/config-drift-checker:write-case` | writes one more eval case in the official format |
| `/config-drift-checker:repair` | after a red run: the smallest setup fix, verified by re-running the failing cases |

## Tools (Node 20+, no dependencies)

| Tool | What it does |
|---|---|
| `eval-shim.mjs` | the bundled runner: same case format as `claude plugin eval`, plus Codex and Gemini, MCP mocks, `--concurrency` |
| `eval-diff.mjs`, `eval-report.mjs`, `eval-dashboard.mjs` | baseline diff with noise bands, the HTML report, the drift observatory |
| `skill-lint.mjs`, `suite-doctor.mjs` | free preflight: SKILL.md checks, and eval cases vs the installed Claude Code (`--fix` migrates) |
| `context-cost.mjs` | tokens your setup adds to every session, per release |
| `usage-check.mjs` | real skill usage from your local transcripts vs your eval cases |
| `drift-matrix.mjs` | which models and Claude Code versions your setup survives |
| `drift-bisect.mjs` | which release broke a case, in log2(N) runs |
| `evals-convert.mjs` | skill-creator `evals.json` into plugin-eval cases, and back |
| `release-report.mjs` | every public eval suite loaded on the newest Claude Code, $0 |
| `mutate.mjs` | mutation testing: sabotages copies of your setup (a rule or whole section deleted, a rule inverted, a trigger blurred, a skill or hook removed) and scores how many breaks the suite catches; `--defaults` adds a no-plugin run that lists the rules the model follows anyway |
| `trigger-map.mjs` | fire rates per skill with 95% ranges, and collisions between skills |
| `case-miner.mjs` | real sessions into suggested cases, anonymised, staged for review |
| `harness-diff.mjs` | what changed inside Claude Code's built-in tools between two releases |
| `pr-impact.mjs` | what a PR changes in the setup: tokens per session, rules, the cases that test them |
| `runs-needed.mjs` | how many runs each case needs to tell a real drop from noise |
| `cdc-bootstrap.mjs`, `fleet.mjs`, `drift-digest.mjs`, `trace-keeper.mjs` | headless setup, many repos on one dashboard, the weekly digest, keeping official-runner transcripts |

Workflow templates for single repos, fleets, org rollout and the matrix are in `ci/`. Tests:
`npm test` (324, against a fake `claude`, no API key needed).
