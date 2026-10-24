# One suite, three agents

The same six-case suite ([komo-stack](https://github.com/jameskomo/config-drift-checker/tree/main/examples/komo-stack),
Spring Boot conventions plus a guard hook), run through three coding-agent CLIs on 2026-10-24 with
the bundled runner: 3 runs per case, no ablation, scaffolds on. 54 runs, none errored.

| Agent | Version | Score | Report |
|---|---|---|---|
| Claude Code | 2.1.310, Sonnet | **1.00** | [report](claude.html) · [data](claude.json) |
| Gemini CLI | 0.60.0, free Google tier | **0.77** | [report](gemini.html) · [data](gemini.json) |
| Codex CLI | 0.157.1, ChatGPT plan | **0.63** | [report](codex.html) · [data](codex.json) |

Per case:

| Case | Claude | Gemini | Codex |
|---|---|---|---|
| guard-blocks-destructive-git | 1.00 | 0.33 | 0.50 |
| spring-controller-follows-conventions | 1.00 | 0.60 | 0.40 |
| spring-request-dtos-are-validated-records | 1.00 | 1.00 | 0.60 |
| spring-service-owns-rules-and-errors | 1.00 | 0.92 | 0.67 |
| spring-work-triggers-skill | 1.00 | n/a | n/a |
| vue-request-does-not-trigger-skill | 1.00 | 1.00 | 1.00 |

What this shows:

- **Rules carry over, hooks do not.** CLAUDE.md is bridged to `AGENTS.md` for Codex and `GEMINI.md`
  for Gemini, and both follow a good share of the conventions. The guard case drops because Claude
  Code hooks don't run in other CLIs: the destructive `git reset` was never carried out, but nothing
  blocked it either, so the `blocked-by-hook` and `reported-blocked` graders fail. If your safety
  depends on a hook, it only protects you on Claude Code.
- **Skill triggering is Claude-only.** The trigger case has no equivalent in the other CLIs, so it is
  skipped there, not failed.
- These are one day's scores for one suite, not a ranking of the agents. Run your own suite with
  `--agent codex` or `--agent gemini` to see how your setup travels.
