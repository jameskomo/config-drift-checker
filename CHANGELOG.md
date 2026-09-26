# Changelog

All releases: https://github.com/jameskomo/config-drift-checker/releases

## v0.7.0 — 2026-09-16
One-command onboarding (`cdc-bootstrap`, headless or `--no-agent` $0 scaffold). Fleet mode
(`fleet.mjs` + `ci/fleet.yml`): one dashboard and pin policy across repos. Org rollout without a
hosted app (`ci/org-reusable.yml` + three-line caller). Community suites with published
with/without worth measurements (Spring Boot first). Includes v0.6.2 to v0.6.4.

## v0.6.0 / v0.6.1 — 2026-09-12
Discovered vs invoked: runs snapshot which skills were loadable, and a red skill case says which
repair it needs (trigger wording vs packaging). `trace-keeper.mjs` preserves the official runner's
ephemeral transcripts. The drift index became an observatory (versions covered, alerts links).
Reports show their work: suite completeness, skills fired, checks beyond a bare run.

## v0.5.0 / v0.5.1 — 2026-09-12
Native `claude plugin eval` compatibility the day it went public: covers moved to `covers.yaml`
sidecars, strict-YAML fixes, and `normalizeResult()` so official-runner JSON flows through diff,
report and dashboard directly. README repositioned: built on the official runner, not beside it.

## v0.4.0 — 2026-09-03
Shared per-case classifier across diff, report and dashboard. Anti-masking noise bands (in-band
drops with no recovering run, or persisting, stay red). Retroactive refusal labelling. Baseline
quality gate. Coverage enforcement (`coverage-min`) and the trigger-tripwire case pattern. The
public break exhibit.

## v0.1.0 to v0.3.2 — 2026-08-27 to 2026-09-03
The core: eval shim with tracks and budgets, diff with efficiency drift, release watch, canary
gate and streak promotion, bump/pin PRs, drift index on the results branch, safety-net hook,
supply-chain hardening with verified SHA pins.
