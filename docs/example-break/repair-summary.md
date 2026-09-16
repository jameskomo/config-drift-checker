## What drifted
`spring-work-triggers-skill` (tripwire) and the three Spring content cases: the agent wrote Spring Boot code without ever invoking `spring-boot-conventions`, so none of the house rules (ApiResponse envelope, 1-based page clamping, `<Feature>Dtos` holder) landed, since Claude Code 2.1.258 → 2.1.273 / model claude-sonnet-5 → claude-sonnet-5.

Classification: **skill did not fire**, not a harness regression. The skill's frontmatter `description` on disk described Terraform/HCL and ended with "Do NOT use for Java, Spring Boot, or backend work". The agent read it and declined correctly; two of three red runs say so in their reply ("its description says it's actually for Terraform/HCL … so I won't invoke it"). The report's own diagnosis note pointed the same way: discovered but never invoked, suspect the trigger description.

## The change
`skills/spring-boot-conventions/SKILL.md`: restored the frontmatter `description` to the Spring Boot trigger text ("House conventions for writing Spring Boot (Java) backend code … Trigger phrases - "Spring Boot", "REST controller", "@RestController", "endpoint", "service class", "DTO", "JPA repository". Do NOT use for Vue, Pinia, TypeScript, or frontend work."). This is the wording that fired 3/3 in the green baseline, so it is the smallest proven edit; no rule in the skill body was touched. The file is now byte-identical to `HEAD`.

## Evidence
Verification: `--runs 2 --ablation none --scaffold --budget 2`, Claude Code 2.1.273, claude-sonnet-5, judge haiku. Spent $0.28 of the $2.00 budget. First attempt was green.

| case | before (red run) | after (verification) | turns | cost/run |
| --- | --- | --- | --- | --- |
| spring-work-triggers-skill | 0.00 (3/3 runs failed `skill-fired`) | 1.00 (2/2, skill invoked in both) | baseline 3 → red 1 → now 3/4 | $0.058 → $0.070, $0.077 |
| spring-controller-follows-conventions | 0.28 (3/3 failed `api-response-wrapper`, `page-clamping`, `reviewer-judgment`, `skill-fired`; 1/3 failed `no-field-injection`) | 1.00 (2/2, all six graders pass) | baseline 3 → red 1 → now 3/3 | $0.058 → $0.066, $0.068 |

Turns are back to the baseline's 3 (the red run's drop to 1 was the skill call disappearing, not efficiency). Per-run cost is a few cents above baseline, within the run-to-run noise the diff table reports, nowhere near the 0.5 efficiency threshold.

## Not changed
- `spring-request-dtos-are-validated-records` (0.50) and `spring-service-owns-rules-and-errors` (0.60) were not re-run, to keep verification under budget. Both failed `skill-fired` ×3 with the same "skipped the skill because of its description" transcripts, so they share this root cause. The full suite should be re-run before merge to confirm.
- `spring-service-owns-rules-and-errors` has an unstable baseline (±0.20, 0.93 in the last green run). That predates this drift; more runs per case, not a threshold change, is the fix.
- In three red runs the agent tried `Write` and was denied ("Claude Code is running in don't ask mode"). It then printed the source in its reply as the prompt asks, so this did not affect grading, but it is worth knowing the shim's permission mode denies file writes on this harness version.
- Nothing under `evals/` was touched. No grader looked wrong: every failure traced to the missing skill call.
- Because the fix restores the file to `HEAD`, `git diff` in the plugin directory is empty. The caller's PR should be cut from the broken working tree, or the change described here will not show up as a diff.
