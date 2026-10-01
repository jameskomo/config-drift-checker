# Changelog

All releases: https://github.com/jameskomo/config-drift-checker/releases

## v1.3.0 (2026-10-01)
Free preflight before any model run. `skill-lint` checks every SKILL.md (frontmatter strict
parsers reject, vague or missing trigger descriptions, overlapping skills without negative scope,
broken file references). `suite-doctor` checks eval cases against the installed Claude Code's
runner without starting a run (`--max-cost-usd 0`), names every case that no longer loads, and
`--fix` migrates the known format changes. The Action runs both after installing Claude Code
(`preflight: warn | fail | off`). Our own skills now pass `skill-lint --strict`.

## v1.2.0 (2026-10-01)
Native on Claude Code 2.1.287, whose canary run caught five eval-format changes the day they
shipped: `--trust-plugin` in CI, an OS sandbox for shell tools, `focus:` on llm graders, scaffold
scripts as files, and `min: 0` with `max: 0`. The Action installs the sandbox, health-checks the
official result and falls back to the bundled runner when it is unusable; errored runs no longer
count as regressions. The reference suite passes 6 of 6 natively.

## v1.1.0 / v1.1.1 (2026-09-26)
One suite, three agents: the Codex adapter (`--agent codex`, `AGENTS.md` bridging) and the Gemini
adapter (`--agent gemini`, `GEMINI.md` bridging, free Google tier), both live-calibrated the day
they shipped and labeled experimental until full published comparisons. Claude-only indicators
are skipped with a reason on other agents, never failed. README and guide rebuilt around the
grouped capability tables and the everything-in-the-box index.

## v1.0.0 (2026-09-26)
The stability promise: the `v1`/`v0` moving tags never break your workflow. The Drift Wire
(per-release verdicts as `verdicts.json` and a subscribable Atom feed), the live stability streak
and embeddable status badge, `drift-bisect` (binary-search Claude Code releases for the one that
broke a case), the pre-written weekly digest and release post, the hosted-tier waitlist,
SECURITY.md, issue templates, an auth preflight in `cdc-bootstrap`, and the animated README demo.

## v0.7.0 (2026-09-16)
One-command onboarding (`cdc-bootstrap`, headless or `--no-agent` $0 scaffold). Fleet mode
(`fleet.mjs` + `ci/fleet.yml`): one dashboard and pin policy across repos. Org rollout without a
hosted app (`ci/org-reusable.yml` + three-line caller). Community suites with published
with/without worth measurements (Spring Boot first). Includes v0.6.2 to v0.6.4.

## v0.6.0 / v0.6.1 (2026-09-12)
Discovered vs invoked: runs snapshot which skills were loadable, and a red skill case says which
repair it needs (trigger wording vs packaging). `trace-keeper.mjs` preserves the official runner's
ephemeral transcripts. The drift index became an observatory (versions covered, alerts links).
Reports show their work: suite completeness, skills fired, checks beyond a bare run.

## v0.5.0 / v0.5.1 (2026-09-12)
Native `claude plugin eval` compatibility the day it went public: covers moved to `covers.yaml`
sidecars, strict-YAML fixes, and `normalizeResult()` so official-runner JSON flows through diff,
report and dashboard directly. README repositioned: built on the official runner, not beside it.

## v0.4.0 (2026-09-03)
Shared per-case classifier across diff, report and dashboard. Anti-masking noise bands (in-band
drops with no recovering run, or persisting, stay red). Retroactive refusal labelling. Baseline
quality gate. Coverage enforcement (`coverage-min`) and the trigger-tripwire case pattern. The
public break exhibit.

## v0.1.0 to v0.3.2 (2026-08-27 to 2026-09-03)
The core: eval shim with tracks and budgets, diff with efficiency drift, release watch, canary
gate and streak promotion, bump/pin PRs, drift index on the results branch, safety-net hook,
supply-chain hardening with verified SHA pins.
