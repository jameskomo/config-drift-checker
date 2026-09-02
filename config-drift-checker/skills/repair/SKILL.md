---
name: repair
description: After a red eval run, propose the smallest change to the agent setup (CLAUDE.md, a skill, a hook) that restores the drifted behaviour, verify it by re-running only the failing cases, and write a PR-ready summary. Use when the user says "fix the regression", "repair the setup", "make the eval green again", or when the config-drift-checker Action runs with repair: true.
---

# config-drift-checker: repair

You are fixing the **setup under test**, never the test. The eval caught a behaviour drift; your job is to
restore the behaviour with the smallest possible edit and prove it with a re-run.

## Inputs (all paths are given in the request)

- **Plugin under test** — the directory with `.claude-plugin/plugin.json`; its `CLAUDE.md`, `skills/**`,
  `hooks/**` are the only files you may change.
- **Failing report** — `aggregate-result.json` of the red run. **Diff vs baseline** — the markdown table.
  **Baseline** — the last green `aggregate-result.json`.
- **Shim** — `eval-shim.mjs`. **Budget** — the most you may spend on verification runs (USD).
- **Summary path** — where to write `repair-summary.md`.

## Hard rules

1. Never edit anything under `evals/` — not prompts, not graders, not `case.yaml`. A grader that looks wrong
   goes in the summary as a finding, not a fix.
2. Never loosen a rule to make a case pass ("archive instead of delete" does not become "delete is fine").
   Restoring a behaviour means making the instruction land again on the current model/version: sharper wording,
   an explicit example, moving a rule nearer the top, a hook where prose stopped working.
3. One concern per repair. If two unrelated cases went red, fix the first, note the second.
4. Stay inside the budget: pass `--budget <remaining>` to every shim call and stop when it is spent.
5. Never touch git history or push. The caller commits and opens the PR.

## Procedure

1. **Read the failure, not the score.** For each red case open its `arms.with` runs: `numTurns`, `toolUses`,
   the failing graders' `reason`, the `response`. Classify: *refused before acting* · *skill/hook did not
   fire* · *did the wrong thing* · *did the right thing, said it wrong* · *grader wrong* · *flaky*.
   Only the middle three are repairable here; the others go in the summary.
2. **Find the instruction that should have produced the behaviour** in `CLAUDE.md` / the skill / the hook.
   Compare with the baseline run's transcript: what did the agent do then that it does not do now?
3. **Make the smallest edit** that makes the instruction unambiguous on the current model. Prefer, in order:
   reword the rule → add a one-line example → move the rule earlier / under a clearer heading → add a
   `PreToolUse` hook if prose is structurally unreliable for a must-never rule.
4. **Verify**: `node <shim> <plugin> --case <dir> --runs 2 --ablation none --scaffold --budget <remaining>
   --output-dir <tmp>`. Green = every run scores 1.00 on the scored graders. Compare cost/turns to the baseline
   too — a fix that doubles turns is not a fix.
5. Up to **two** attempts. If the second is not green, revert your edits (`git checkout -- <plugin-dir>` or
   undo them by hand) and write a summary that says what you tried and what you learned.
6. **Write `repair-summary.md`** (this becomes the PR body):

```
## What drifted
<case> — <one sentence: what the agent did vs what the setup requires>, since Claude Code <from> → <to> / model <from> → <to>.

## The change
<file>: <one sentence per edit, and why this wording>

## Evidence
| case | before (red run) | after (verification) | turns | cost |
| … | 0.33 (2/3 runs failed `blocked-by-hook`) | 1.00 (2/2) | 6 → 5 | $0.21 |

## Not changed
<anything you noticed but left alone: a suspicious grader, a second unrelated red case, a flaky run>
```

If nothing safe was found: title the file `## No safe fix found`, keep the *What drifted* and *Not changed*
sections, and make sure the working tree is clean.
