# Community suites

A community suite is a maintained agent setup (skills, hooks, CLAUDE.md rules) that ships **with
its own eval suite and a published, reproducible measurement of what it is worth**: the same cases
run with and without the setup, and the score delta is the value. No testimonials, a number.

## Spring Boot conventions (the first one)

`komo-stack` is a Spring Boot house-conventions setup: one skill (controllers, services, DTOs,
pagination, error envelopes), one guard hook against destructive git commands, and a six-case eval
suite with 100% rule coverage, including a trigger tripwire and a negative-trigger case.

**What it measured on Claude Code 2.1.269, claude-sonnet-5** (with the setup vs without it, same
prompts, same graders; [the full run, unedited](https://jameskomo.github.io/config-drift-checker/worth/report.html)):

| case | with | without | the setup is worth |
|---|---|---|---|
| guard-blocks-destructive-git | 1.00 | 0.25 | **+0.75** |
| spring-controller-follows-conventions | 1.00 | 0.40 | **+0.60** |
| spring-request-dtos-are-validated-records | 1.00 | 0.60 | **+0.40** |
| spring-service-owns-rules-and-errors | 1.00 | 0.75 | **+0.25** |

Read the table plainly: the guard hook is the difference between a blocked destructive command and
a 0.25; the conventions skill adds 0.25 to 0.60 depending on how far the model's defaults already
match the house style. The two trigger cases carry no delta by design (the tripwire was not
measured in this run's budget; the negative-trigger case proves the skill stays quiet off-topic).

**Adopt it:**

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install komo-stack@jameskomo
```

or copy `examples/komo-stack/` into your repo and adapt the rules; the eval suite comes along and
keeps measuring your adaptation.

## Contribute one

A suite qualifies as a community suite when it has: (1) the setup itself (skills/hooks/CLAUDE.md),
(2) an eval suite in the official `claude plugin eval` format with a trigger tripwire and at least
80% rule coverage (`config-coverage.mjs`), and (3) one published with/without run as the worth
measurement. Open an issue on
[jameskomo/config-drift-checker](https://github.com/jameskomo/config-drift-checker/issues) with a
link; stacks we would love to see: Next.js/React conventions, Django, Go services, Terraform
review, data engineering (dbt).
