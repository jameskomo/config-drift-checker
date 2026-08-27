---
name: run
description: Run the agent-config eval suite locally and compare with the stored baseline; explain why a case went red. Use when the user says "run the evals", "run config-drift-checker", "did the Claude Code update break my setup", "why is the eval red", or "compare against baseline".
---

# config-drift-checker: run

```
node ${CLAUDE_PLUGIN_ROOT}/tools/eval-shim.mjs <plugin> [--case <glob>] [--runs n] [--ablation none|with-without] [--scaffold] [--model m]
node ${CLAUDE_PLUGIN_ROOT}/tools/eval-diff.mjs <baseline.json> <current.json> [--threshold 0.15]
node ${CLAUDE_PLUGIN_ROOT}/tools/release-watch.mjs --state .claude-code-version
```

- Default to `--ablation none --scaffold` for regression checks (with-without only to prove a
  plugin's worth). Use `--runs 1` for a quick look, 3+ before trusting a score.
- Baseline lives at `<plugin>/evals/results/<timestamp>/aggregate-result.json` locally, or
  `baseline.json` on the `eval-results` branch (`git show origin/eval-results:baseline.json`).
- If the official runner is enabled (`claude plugin eval` in an empty dir prints "No eval cases
  found"), prefer `claude plugin eval <plugin> --allow-tools Bash --scaffold --json out.json`.

## Explaining red — read the run, not the score

For each failing case open the run entries in the JSON: `numTurns`, `toolUses`, `response`,
per-grader `verdict`. Classify and say which:
1. **Model refused before acting** (1 turn, 0 tool calls) → the case doesn't exercise the hook; change the command/scaffold.
2. **Hook/skill didn't fire** (tool attempted, no block / no Skill call) → real regression or config change — check `claude --version` vs `.claude-code-version`.
3. **Grader wrong** (prose matched, negative grader with min=1) → fix the grader, not the setup.
4. **Flaky** (mixed verdicts across runs) → raise `runs`; never loosen the threshold.
