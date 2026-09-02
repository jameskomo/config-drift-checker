---
name: setup
description: Set up regression testing (CI) for this repository's Claude Code configuration — plugin, skills, hooks, CLAUDE.md. Use when the user says "set up config-drift-checker", "add evals for my plugin/skills/hooks", "test my Claude Code setup", "make sure my hooks keep working after updates", or "wire the eval GitHub Action". Do NOT use for evaluating an LLM application or prompts — this is for agent configuration only.
---

# config-drift-checker: setup

Goal: leave the repo with (1) an `evals/` suite generated from the user's **real** configuration,
(2) a passing local smoke run, (3) the GitHub workflow in place, (4) a checklist of the one or two
things only the user can do. Ask nothing you can discover from the repo.

## 1. Discover the setup

Look, in order, for: `.claude-plugin/plugin.json` (a plugin — its dir is the target);
`.claude/skills/*/SKILL.md`, `.claude/hooks/*`, `.claude/settings.json` hooks, `CLAUDE.md`.
If there is no plugin manifest, create a minimal one at the repo root pointing at the skills and
hooks you found (`claude plugin init --help` shows the shape) — evals need a plugin target.
**Check ignores first:** run `git check-ignore -v .claude/evals/x` — many repos ignore `.claude/`
(worktrees, local settings). If it is ignored, put skills, hooks and evals under `agent-config/`
at the repo root and set `"experimental": {"evals": "agent-config/evals"}` in the manifest; never
edit the user's `.gitignore` for this. Note that a plugin does not carry `CLAUDE.md` — cases that
test CLAUDE.md rules must copy it into the workspace via `scaffold_script`.
List what you found to the user in five lines or fewer.

## 2. Generate starter cases (three, from real content)

Turn budgets: `max_turns: 30` and `timeout_seconds: 900` for real-code cases (the agent reads,
edits several files and writes a test), `12` for single-file or prose cases, `6` for hook cases. A
run that hits `max_turns` is scored as-is and flagged TRUNCATED — treat that as "raise the budget".
Give every case a `description:` line in `prompt.md` frontmatter, one sentence stating what the
case proves and which part of the setup (skill, hook, CLAUDE.md rule) it exercises; the HTML report
shows it under the case heading. Also give it `covers: [..]` — the ids of the rules it exercises,
from `node ${CLAUDE_PLUGIN_ROOT}/tools/config-coverage.mjs <plugin> --list` (run it after step 1;
a negative-trigger case covers nothing, which is correct). The coverage number in every report
comes from these. Write them under `<plugin>/evals/<case>/` using the official layout (prompt.md + graders/*.md,
optional case.yaml). Use `${CLAUDE_PLUGIN_ROOT}/../examples/komo-stack/evals/` as the reference if present,
or the format section of the `write-case` skill.

- **One positive skill case** per important skill: a prompt that should trigger it, graders that
  check the skill's *observable* conventions in the output (regex on code position, not prose),
  a `tool_used: Skill` indicator, and one `llm` grader with the rubric taken from the SKILL.md.
  For backend/code skills prefer a **real-code case**: `scaffold_script` copies the real source
  (`cp -r "$EVAL_PLUGIN_ROOT/backend/src/main/java" …` plus `CLAUDE.md`), the prompt asks for a
  feature that does **not** exist yet (grep first — an existing feature makes the agent correctly
  do nothing and the case fails for the wrong reason), `allowed_tools: [Read, Glob, Grep, Edit, Write]`,
  graders use `target: files` (only files the agent changed are graded) and an
  "only these files changed" `not_contains` on the `### path` headers.
- **One negative-trigger case**: a plausible request the skill must NOT fire on
  (`tool_used: Skill, max: 0, arm: both`).
- **One hook case** per guard hook: scaffold a scratch state in `case.yaml` (e.g. `git init`, a
  commit), ask the agent to run a command the hook blocks *and that the model will actually
  attempt* (not force-push to main — models refuse that unprompted), graders: attempted
  (`tool_used: Bash`), reported-blocked (regex), not-succeeded (regex not_contains).

## 3. Smoke run

```
node ${CLAUDE_PLUGIN_ROOT}/tools/eval-shim.mjs <plugin> --runs 1 --ablation none --scaffold
```
Read the per-grader verdicts. Fix graders that fail for the wrong reason (prose match, missing
scaffold, unsatisfiable negative). Re-run once. Show the user the table.

## 4. Pin and budget — `.cdc.yml`

Write `<plugin>/.cdc.yml` from what the smoke run resolved:
```
node ${CLAUDE_PLUGIN_ROOT}/tools/cdc-config.mjs <plugin> init --model <aggregates.resolvedModels[0] of the smoke run> --harness <claude --version, first token>
```
Then **ask the user one question only**: how much they are willing to spend per month on this suite,
and set `budget.per_month_usd` to it (default 10). Explain in two sentences: the pinned track is the
baseline every PR is checked against; the canary runs the alias model on the latest Claude Code when
a release ships, at most every 72 h, never past the budget, and opens a bump PR after two greens.

## 5. Wire CI

Copy `${CLAUDE_PLUGIN_ROOT}/ci/config-drift-checker.yml` to `.github/workflows/config-drift-checker.yml`
**as is** — it is generic: it checks out the published `jameskomo/config-drift-checker` for the watch job
and uses `jameskomo/config-drift-checker/action@v0` with `plugin-dir: .`. Only adjust the `paths:` filters
to the directories that hold this repo's CLAUDE.md, skills, hooks and source. Never point it at
in-repo tool paths. If `gh` is available and authenticated, offer to run
`gh secret set ANTHROPIC_API_KEY` (the user pastes the key; never echo it) and
`gh secret set SLACK_WEBHOOK_URL`.

## 6. Hand-off checklist (print exactly)

1. Push. 2. Settings → Actions → General: workflow permissions *Read and write*, and tick *Allow
GitHub Actions to create and approve pull requests* (for bump/pin PRs). 3. Actions →
config-drift-checker → Run workflow (records the baseline; merge the pin PR it opens if `.cdc.yml`
had no pin). 4. The next Claude Code or model release runs the canary; regressions appear as a red
check, a PR comment, Slack and the drift index (`eval-results` branch → Pages). 5. After intentional
changes: Run workflow with `promote-baseline: true`. 6. Spend never passes `budget.per_month_usd`
in `.cdc.yml`; a skipped run says so in the job summary.
