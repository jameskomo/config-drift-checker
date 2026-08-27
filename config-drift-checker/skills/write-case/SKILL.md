---
name: write-case
description: Author or fix an eval case (prompt.md, graders/*.md, case.yaml) for a Claude Code plugin, skill, or hook in the official `claude plugin eval` format. Use when the user says "write an eval for", "add a test case for this skill/hook", "my grader is wrong", or "how do I assert the hook fired".
---

# config-drift-checker: write-case

Layout: `<plugin>/evals/<case-dir>/prompt.md`, `graders/<name>.md`, optional `case.yaml`.

**prompt.md** frontmatter: `name`, `description` (one sentence a reviewer would read in the report:
what this case proves and which part of the setup it exercises), `tags: [..]`, `runs` (3), `max_turns`, `timeout_seconds`,
`allowed_tools: [Bash]` (only what the case needs), `model`. Body = the user prompt, written the
way a real user would write it (do not mention the skill or hook by name).

**graders/*.md** frontmatter `type`:
- `regex`: `pattern`, `flags`, `match: contains|not_contains|count:N`, `target: last_message|trace|files`
- `tool_used`: `tool`, `input_match`, `min`, `max`, `arm: with|without|both`
- `file_exists`: `path` (glob)
- `llm`: `criteria` (one paragraph; "score 1 only if all hold")
Body = one sentence a reviewer would understand.

**case.yaml** (`schema_version: "1.1"`): `context.scaffold_script` (bash; give the agent a state
to act on — a git repo, a file, a branch), `context.add_dirs` (fixtures).

## Rules that came from real failures
1. `not_contains` graders must match **code position** (`^\s*@Autowired`, flag `m`), never a
   word that can appear in prose — the model will say "I avoided X".
2. A negative-trigger case (`tool_used: Skill, max: 0, arm: both`) for every skill.
3. Hook cases: choose a command the model will *attempt* in a scratch repo (`git reset --hard
   HEAD`, `git clean -fd`), not one it refuses on its own (`git push --force origin main`).
   Assert three things: attempted (tool_used Bash), reported blocked (regex), not succeeded
   (regex not_contains on success phrases like "HEAD is now at|ran successfully").
4. `tool_used: Skill` graders are indicators under ablation, not score — that is correct; add
   `arm: both` only when the assertion must hold without the plugin too.
5. Keep prompts short and realistic; put setup in `scaffold_script`, not in the prompt.
6. Regex over Java/TS: never rely on `name\([^)]*\)` to find a method — parameter annotations
   contain parentheses. Anchor on something unique and flat (the mapping annotation string, the
   record name) and use a bounded lazy window `[\s\S]{0,900}?`.
7. Test every regex against a hand-written snippet of the expected code with `node -e` **before**
   spending an agent run; a grader that fails a correct answer costs more trust than it saves.
8. **Safety (learned the hard way):** the without-arm has no guard, and workspaces do not
   sandbox Docker, the network, or the host. A hook case's command must be harmless when it
   *succeeds*: scratch git repo, or a stub binary created by `scaffold_script` in `.eval-bin/`
   (`printf '#!/usr/bin/env bash\necho stub $*\n' > .eval-bin/docker-compose; chmod +x …`).
   The runner's safety net blocks compose down -v / prune / force-push / rm -rf outside the
   workspace unless the binary is stubbed. Check for `name:`/`container_name:` in compose files
   and for real remotes before writing the prompt.
9. Turn budgets: real-code cases need `max_turns: 20` (read → edit 2–4 files → test); single-file
   or prose cases 12; hook cases 6. Runs that hit the cap are scored as-is and flagged TRUNCATED —
   a signal to raise the budget, not a failure of the setup.
