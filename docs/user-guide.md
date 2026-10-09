# User guide

Everything from install to reading a red report. What the tool is and how it relates to
`claude plugin eval` is in the [README](../README.md); this page assumes you want it running.
Claude Code is the first-class agent throughout; the experimental Codex path is in the FAQ.

Live examples: [our drift index](https://jameskomo.github.io/config-drift-checker/drift/) (this
plugin's own suite on every Claude Code release) · [a real break, self-diagnosed](https://jameskomo.github.io/config-drift-checker/example-break/report.html) · [the repair that fixed it](https://github.com/jameskomo/config-drift-checker/blob/main/docs/example-break/repair-summary.md) · [demo repo](https://github.com/jameskomo/config-drift-checker-demo)

## 0. Everything in the box

One row per capability, with where this guide covers it. If you can't find a feature here, we
didn't ship it.

| Capability | Where |
|---|---|
| One-command setup, headless or $0 scaffold (`cdc-bootstrap`) | §2 |
| Ready-made community suites with published worth numbers | §2 |
| CI wiring, secrets, branch gating, useful Action inputs | §3, §4 |
| Pins, canary cadence, thresholds, budgets (`.cdc.yml`) | §5 |
| Release watch, canary runs, bump and pin PRs | §6 |
| Free preflight before any model run: skill linter, suite format doctor, format drift per release | §7 |
| Reading reports: noise bands, refusals, discovered vs invoked, panels | §7 |
| Which release broke it (`drift-bisect`) | §7 |
| Which model and Claude Code version your setup survives (`drift-matrix`) | §7 |
| Context-cost drift: tokens your setup adds to every session, per release (`context-cost`) | §7 |
| Real usage vs evals: tested but unused, used but untested (`usage-check`) | §7 |
| Bring skill-creator `evals.json` suites, or export to them (`evals-convert`) | §2 |
| Plugins with MCP servers: mocks and `mock_calls` graders under both runners | §2 |
| Parallel agent runs (`concurrency` input) | §4 |
| The public Claude Code release report | §9 |
| Autonomous repair: when it runs, its hard limits, a live example | §7 |
| Fleet dashboard and pin policy across repos | §8 |
| Org-wide rollout with a reusable workflow, no hosted app | §8 |
| The observatory, stability streak, status badge, drift-wire feed | §9 |
| Weekly digest and the pre-written release post | §9 |
| Local commands for every tool, including `trace-keeper` | §10 |
| Measured costs and the levers that cap them | §11 |
| Safety: workspaces, the safety-net hook, third-party suites | §12 |
| Codex and Gemini (experimental): same cases, other agents | §14 (FAQ) |

## 1. Install (once per machine)

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
```

You now have four skills in Claude Code (`/config-drift-checker:setup`, `:run`, `:write-case`,
`:repair`) and the runner tools inside the plugin. Nothing has touched any repo yet.

## 2. Set up a repo (10 minutes, mostly watching)

In the repo whose setup you want protected:

```
claude "/config-drift-checker:setup"
```

Claude will:

1. **Find your setup**: `CLAUDE.md`, `.claude/skills`, hooks, or a plugin manifest. If `.claude/`
   is gitignored it uses `agent-config/` instead; if you have no agent config yet, it proposes one
   from your code and asks first.
2. **Write starter cases from your real content**: a skill case (real-code where possible), a
   negative-trigger case, a hook case (stubbed so nothing real can be harmed). Each case lists the
   rules it covers in a `covers.yaml`, which is where the coverage number comes from.
3. **Smoke-run them** and show every grader's verdict, fixing graders that fail for the wrong reason.
4. **Write `.cdc.yml`** (pins and budget, see the [reference](#cdcyml)) and the GitHub workflow,
   and offer to set your secrets.

Review the diff like any PR. Commit.

**Without entering Claude at all:** `node <plugin-root>/tools/cdc-bootstrap.mjs .` runs the same
setup headlessly from a plain terminal (state a spend cap with `--budget`, default 3). Add
`--no-agent` for a $0 deterministic scaffold instead: a minimal manifest if you have none, a blank
starter case (official `claude plugin eval init --bare`), `.cdc.yml` with the harness pinned to
your installed Claude Code, and the workflow; you then write the case content yourself. Both modes
are idempotent, never overwrite existing files, and end with the same hand-off checklist.

**Or start from a ready-made setup:** [community suites](community-suites.md) are maintained
setups with eval suites and a published with/without worth measurement; the first is Spring Boot
conventions (`claude plugin install komo-stack@jameskomo`), where the guard hook measures +0.75
on its case. Adopt one and adapt the rules; the suite keeps measuring your adaptation.

### Bring your skill-creator evals

If you built a skill with Anthropic's skill-creator, its `evals/evals.json` can become your
plugin-eval suite. Claude Code's two eval formats don't read each other's cases; this converts:

```bash
node <plugin-root>/tools/evals-convert.mjs import skills/<skill>/evals/evals.json --dry-run   # see the plan
node <plugin-root>/tools/evals-convert.mjs import skills/<skill>/evals/evals.json             # write the cases
node <plugin-root>/tools/evals-convert.mjs export <plugin> --out evals.json                   # the other way
```

Each eval becomes a case directory. Its prompt becomes the case prompt, its expectations become
judged (`llm`) graders, its input files are copied into the workspace by a scaffold script, and a
check that your skill fired is added. skill-creator's trigger sets become trigger and
negative-trigger cases. Existing cases are never overwritten unless you pass `--force`, and the
import prints the exact `claude plugin eval` command to run them. `export` writes an `evals.json`
and lists every check skill-creator has no place for (regex, tool order and similar) instead of
dropping them silently. The full mapping is in
[the format reference](eval-format-and-runner.md).

### Plugins with MCP servers: test against mocks

A plugin that talks to a tracker, a database or any other MCP server can be tested without the
real service. Put mocks in `evals/mocks/<server>/<tool>.md` (or a case's own `mocks/` folder) in
the official `claude plugin eval` format: the body is the tool's answer, and frontmatter can add
`expect:` (the run fails if the agent sends something else), `error: true`, and substitutions like
`{{input.id}}`. Both runners answer from the mocks and keep the plugin's real servers down by
default (`--allow-real-servers` lets unmocked ones start). Grade what the agent sent with
`target: mock_calls`. The bundled runner supports fixed mocks; a case that needs a `type: agent`
mock (the judge model playing the server) is marked "needs the official runner" instead of
failing. `suite-doctor` checks mock files before any run, which matters because the official $0
load check does not validate them.

## 3. Wire CI (the parts only you can do)

**One auth secret**, either kind:

- `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` (Pro/Max/Team/Enterprise) and paste the
  result. Runs then use your subscription, $0 API credit. This is
  [Anthropic's documented CI path](https://code.claude.com/docs/en/github-actions#manual-setup).
  The token is tied to the person who generated it, and every CI run draws on that person's
  plan usage limits, the same limits their own Claude Code sessions use. For a team, give CI a
  dedicated seat or use an API key so the test suite never competes with someone's working day.
- `ANTHROPIC_API_KEY` (console.anthropic.com): better for an org-wide secret. Runs bill prepaid
  credit, so add a few dollars first; with none, runs fail with "Credit balance is too low" and
  nothing is stored. If both secrets are set, the API key wins.

**Two repo settings** (Settings → Actions → General): workflow permissions *Read and write* (results
are stored on an `eval-results` branch, PRs get comments), and *Allow GitHub Actions to create and
approve pull requests* (for bump/pin/repair PRs; without it the branch is pushed and the job warns).

**Optional**: a `SLACK_WEBHOOK_URL` secret for regression alerts.

Then: Actions → **config-drift-checker** → *Run workflow*. The first run records your **baseline**
and, if `.cdc.yml` has no pin yet, opens a **pin PR** with the exact model id and Claude Code
version the baseline was measured on.

## 4. Adding the check to an existing pipeline (no Claude Code needed)

Already have a suite, or a teammate ran `setup`? The CI half is one step:

```yaml
# .github/workflows/config-drift-checker.yml: pinned track on push/PR, on demand otherwise
on:
  push: { branches: [main], paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  pull_request: { paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  workflow_dispatch:
    inputs:
      track: { description: 'pinned | canary', default: 'pinned' }
      force: { description: 'skip the budget and interval gates', type: boolean, default: false }
permissions: { contents: write, pull-requests: write }
jobs:
  eval:
    runs-on: ubuntu-latest
    env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }   # your key; runs bill to you
    steps:
      - uses: actions/checkout@v7
      - uses: jameskomo/config-drift-checker/action@v1             # ← the whole check
        with:
          plugin-dir: .                        # where .claude-plugin/plugin.json lives
          track: ${{ inputs.track || 'pinned' }}
          force: ${{ inputs.force || 'false' }}
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}   # optional
```

That step reads `.cdc.yml`, checks the budget gate, installs the pinned Claude Code, runs the
suite, diffs against your baseline (score and turns/cost/time), stores results, comments on the
PR, uploads the `eval-report` artifact, opens a pin/bump PR when due, posts to Slack on
regression, and sets the check.

**Add the canary** (latest model and Claude Code, on a schedule, only when something shipped) with
the `watch` job from the full template at `ci/config-drift-checker.yml` in the plugin; that is what
`setup` writes. The canary never fails your PR check.

**Gate merges on it**: branch protection → *Require status checks to pass* → add `eval`.

**Useful inputs:**

| Input | What it does |
|---|---|
| `runs: 1`, `model: haiku` | cheap PR smoke |
| `ablation: with-without` | measure what each skill is worth (run once, not in every CI run) |
| `promote-baseline: true` | after an intentional setup change |
| `repair: true` | on red, the agent proposes a fix PR (spends credit, budget-capped). [A real repair, verified](https://github.com/jameskomo/config-drift-checker/blob/main/docs/example-break/repair-summary.md) |
| `open-prs: false` | no bump/pin PRs |
| `claude-code-version: 2.1.258` | override the pin for this run |
| `coverage-min: 80` | fail when under 80% of your rules have a case (empty = report only) |
| `report-base-url: https://<you>.github.io/<repo>/history` | case names in the PR comment deep-link into that run's HTML report (needs Pages serving the results branch) |
| `preflight: fail` | stop before any model run when the skill linter or suite doctor finds an error (default `warn` reports only) |
| `concurrency: 3` | run up to three agent runs at once (1 to 8). They share one rate limit, so this saves wall-clock time, not money; results keep case order |

**Which path is for me?**

| You are | Do |
|---|---|
| a developer with Claude Code who wants the cases written for you | §2 `setup`, then push |
| a platform team adding a stage to an existing pipeline | this section: the step, the secret, the two repo settings |
| on GitLab / Buildkite / other CI | run the tools directly: `node <plugin-root>/tools/eval-shim.mjs <plugin> --track pinned --scaffold` then `eval-diff.mjs --config <plugin>`; the Action is a thin wrapper around them |

<a id="cdcyml"></a>
## 5. `.cdc.yml` reference

One file at the plugin root says what is pinned, what floats, and how much may be spent.
`node <plugin-root>/tools/cdc-config.mjs <plugin> init` writes it with comments; `setup` does it for you.

```yaml
track: pinned            # default track for a run; the Action passes --track explicitly
model:
  pinned: claude-sonnet-5   # exact model id the baseline is measured on (null = alias until the pin PR)
  canary: sonnet            # the alias your developers actually get; resolved at run time
harness:
  pinned: 2.1.258           # @anthropic-ai/claude-code version for the baseline (null = latest)
  canary: latest
judge_model: haiku
canary:
  runs: 1                   # one run per case, then…
  expand_on_deviation: 2    # …two more only if a grader failed (sequential testing)
  promote_after: 2          # consecutive green canaries before a bump PR is opened
  min_interval_hours: 72    # never canary more often than this on a schedule
thresholds:                 # relative change that counts as drift
  score: 0.15
  turns: 0.5
  cost: 0.5
  duration: 0.5
fail_on: [score]            # which drifts turn the check red; the rest are warnings
budget:
  per_run_usd: 2            # the runner stops starting agent runs past this
  per_month_usd: 10         # the Action refuses to start a run past this (ledger on eval-results)
noise:
  history_runs: 10          # past runs that set each case's noise band in the diff
baseline:
  min_runs: 3               # a run with fewer scored runs per case is refused as a baseline
```

**Two tracks.** *Pinned*: same model id, same Claude Code version, only your setup changes; that is
the PR check and the baseline. *Canary*: the alias model on the latest Claude Code, what your
developers get today. A canary regression is an alert, never a red PR check, and never touches the
baseline. Every report stamps the resolved model and version, so a red row is always attributable
to your change, the model, or the harness.

**Bump and pin PRs.** After `promote_after` consecutive green canaries on the same model and
version, a PR proposes moving your pins there, runs attached as evidence. A pinned run with no pin
declared gets a PR pinning what the baseline actually measured. Neither is ever auto-merged; close
one and it proposes again after the next streak.

**Budget.** `per_run_usd` stops the runner mid-suite (what ran is kept; skipped cases show ❔, not
red). `per_month_usd` is checked before a run starts, against the ledger on your results branch; a
run past the cap is skipped with a notice, not failed. A manual run with `force: true` overrides
both, because the person clicking is the budget.

**Noise.** One model refusal can swing a 3-run case by 0.33, well past a flat 0.15 threshold, so
the diff learns each case's noise band instead of guessing:

- The band is the spread (max minus min) of the case's run scores across the baseline plus the
  newest `noise.history_runs` runs on the same track.
- A drop past the threshold but inside the band is **noisy**: an amber warning, never red.
- Two escalations keep the band honest: if no current run reaches the baseline score (a uniform
  shift, not a flake), or the case was already down in the last two runs, it is red anyway. One
  old flake can never widen the band into a blind spot.
- Runs that took one turn with no tool calls and a short reply, on a case whose baseline acts,
  get a *likely refusals* note: that is a model guardrail change, not setup drift.
- More runs per case shrink the band. Never loosen the threshold.
- A baseline with fewer scored runs than `baseline.min_runs` is warned about in diffs and refused
  as a new baseline.

## 6. What happens from now on (automatic)

- **Every push/PR touching the setup**: the pinned track runs, diffs against the baseline, sets
  the check.
- **On the schedule**: `release-watch` checks npm and Anthropic's model list. Nothing new means
  nothing runs and nothing costs. Something new means the canary runs, at most once per
  `min_interval_hours`, inside the monthly budget.
- **Canary green twice** on a new model or version: a bump PR. **Canary red**: Slack, job summary,
  and the drift index says *baseline holding · canary red*.
- After an intentional setup change: *Run workflow* with **promote-baseline** ticked.

Results, spend ledger, canary streak and release-watch state all live on the `eval-results`
branch: history without a database.

## 7. Reading a report

Every run produces the same report (job summary plus the `eval-report` artifact, or `report.html`
locally). It opens with the verdict; the stamp says which model and Claude Code version ran,
whether either moved since the baseline, and how many of the suite's cases this run evaluated
(cases not run, from a filter or a budget stop, are listed under the table so nothing is silently
absent). A panel under the verdict counts every grader verdict and agent run and marks which
checks come from this tool's layer versus a plain `claude plugin eval` run; a second panel lists
every skill discovered at run start and whether any case invoked it.

| The report says | Do this |
|---|---|
| **No drift** / **baseline recorded** | Nothing. Glance at the stamp. |
| **N case(s) regressed** | Open the red case(s) and classify each failing run: |
| ↳ *refused or asked before acting* (1 turn, no tool calls) | the case never reached your skill/hook. Rewrite the scenario so the model will attempt it |
| ↳ *skill or hook did not fire* | a real regression. The stamp says whether the model or Claude Code moved. Keep the pins, fix or adapt the setup (or `/config-drift-checker:repair`), tell the maintainers |
| ↳ a note says *discovered but never invoked* | the skill file is fine; its trigger description no longer matches. Fix the wording, not the packaging |
| ↳ a note says *not discovered: packaging* | the skill file itself is missing, renamed or malformed. Fix the packaging, not the wording |
| ↳ *grader wrong* (matched prose, a negation) | fix the grader, then `--regrade` the saved run; don't re-spend the suite |
| ↳ *flaky* (mixed verdicts across runs) | raise `runs` for that case. Never loosen the threshold |
| **efficiency drift** (*slower*, *pricier*, *longer*) | every case passes but median turns/cost/time moved. A warning by default; add to `fail_on` to make it red |
| **⚠ noisy** | dropped past the threshold but inside the historical band, with at least one run still at baseline. A warning; more runs shrink the band |
| *likely refusals* note | the model declined the task (guardrail change), your setup did not break. Read the transcript; consider rewording the prompt. A full answer without tools is the opposite: real drift |
| **⚠ baseline quality** (*thin* / *unstable*) | the baseline has too few runs or varies; re-baseline with more runs. Never red |
| **⚠ agent runs errored** | read the first error. Usually no prepaid credit, or a Claude Code startup failure. Nothing was stored |
| a run shows **max_turns** (amber) | cut short and scored as-is; raise that case's `max_turns` (real-code cases need about 20) |
| **skipped: budget / interval** | not a failure. Raise the cap, wait, or re-run with `force` |

In one sentence: a green report asks nothing of you; a red one tells you which of four things
happened (the model refused, the setup regressed, the grader was wrong, or the run was flaky) and
what to do.

### Preflight: catch broken skills and format drift for free

Before any model run, the Action runs two static checks on the Claude Code version it just
installed, and puts both in the job summary:

- **Skill linter** (`tools/skill-lint.mjs <plugin>`): every SKILL.md must have frontmatter a strict
  parser accepts (an unquoted `: ` inside a description breaks it), a name, and a description that
  tells the agent when to use the skill and, when you ship several, when not to. It also flags
  file references in a skill that point at nothing. `--strict` fails on warnings too.
- **Suite doctor** (`tools/suite-doctor.mjs <plugin> [--fix]`): checks every eval case against the
  current official format, and asks the installed Claude Code's runner to load the suite without
  starting a single model run. Any case the new version rejects is named with the exact setting it
  rejected. Changes we know about, like the ones Claude Code 2.1.287 made (`focus` instead of
  `target` on llm graders, scaffold scripts as files, `min: 0` with `max: 0`), are fixed in place
  by `--fix`, and the list of known fixes grows whenever our own canary catches a new change.

Both results are kept with every run and shown in two places. Each run's HTML report has a
**Setup health** panel: one tile for your skills and one for the eval suite format (how many cases
the runner loaded on that Claude Code version, and whether the runner confirmed it), then every
finding with its fix, marked when `--fix` can apply it. The observatory adds a **Setup health**
section with a **format drift per Claude Code release** strip, styled like the behaviour timeline
above it: green when every case loaded, amber for warnings or when the runner could not confirm,
red when a release rejected part of your suite. `verdicts.json` carries the same per-release
health for other tools.

The Action's `preflight` input decides what happens on a finding: `warn` (default) reports it,
`fail` stops before spending any model runs, `off` skips the checks.

Locally, with the plugin installed: `node <plugin-root>/tools/skill-lint.mjs <plugin>` and
`node <plugin-root>/tools/suite-doctor.mjs <plugin> [--fix]`. Or on any plugin without installing
anything (each tool is one dependency-free file; read it before running):

```bash
curl -fsSLO https://raw.githubusercontent.com/jameskomo/config-drift-checker/v1/config-drift-checker/tools/skill-lint.mjs && node skill-lint.mjs <plugin-dir>
curl -fsSLO https://raw.githubusercontent.com/jameskomo/config-drift-checker/v1/config-drift-checker/tools/suite-doctor.mjs && node suite-doctor.mjs <plugin-dir> --fix
```

What changed in Claude Code 2.1.287, which `--fix` handles: llm graders take `focus:` instead of
`target:`; `context.scaffold_script` names a script file; `tool_used` needs `min: 0` with `max: 0`
to mean "never"; `arm: with` becomes `with-only`; a `covers:` key moves to `covers.yaml`. The full
list with reasons is in the [v1.2.0 release notes](https://github.com/jameskomo/config-drift-checker/releases/tag/v1.2.0).

### Which release broke it: `drift-bisect`

When a case that passed weeks ago fails today and several Claude Code releases shipped in
between, `tools/drift-bisect.mjs <plugin> --case <glob> --good <version> --bad <version>` finds
the culprit: it binary-searches the published versions, installing each midpoint into a throwaway
prefix (your global install is untouched) and running just that case. Twenty releases cost four
or five runs. The output names the first bad and last good version, ready for a bug report or a
`harness.pinned` decision. `--budget` caps the total spend; a subscription token makes it $0 API.

### Model and version matrix: which model can my setup use?

`drift-bisect` finds one bad release. `drift-matrix` answers the wider question before you change
anything: would my setup survive Haiku, or Opus, or the last five Claude Code releases?

```bash
node <plugin-root>/tools/drift-matrix.mjs <plugin> --models sonnet,haiku,opus --last 5 --dry-run   # the grid and a cost estimate, $0
node <plugin-root>/tools/drift-matrix.mjs <plugin> --models sonnet,haiku --last 5 --budget 5
node <plugin-root>/tools/drift-matrix.mjs --from <plugin>/evals/results/matrix-<stamp>             # redraw the page, no runs
```

Each Claude Code version is installed into a throwaway folder, so your own install is never
touched, and each cell runs with the official runner when that release has one (the bundled runner
otherwise). You get one page: rows are cases, columns are version and model, and every cell is
coloured against a reference cell, by default the model and version pinned in `.cdc.yml`. Each
model also gets a plain verdict, such as "haiku: safe on 2.1.290 to 2.1.295; fails
spring-service-owns-rules-and-errors on 2.1.288". `--budget` caps the whole grid; cells past it
show as not run rather than failed. `--case` and `--tag` narrow the suite, and `--json` / `--md`
write the same result as data. To run it in GitHub Actions on demand, copy
`ci/drift-matrix.yml` from the plugin.

### Context-cost drift: what your setup costs every session

Every session pays for your skill, agent and command descriptions, and for CLAUDE.md, before
anyone types a word. A Claude Code release can change that bill even when your files stay the
same. `context-cost` measures it:

```bash
node <plugin-root>/tools/context-cost.mjs <plugin> --md -                       # today's figure
node <plugin-root>/tools/context-cost.mjs <plugin> --store evals/results/context-cost
node <plugin-root>/tools/context-cost.mjs --history evals/results --md -        # the trend per release
```

It asks Claude Code's own `claude plugin details` for the always-on and on-invoke tokens of each
component, in a throwaway config with no credentials and no model calls, and adds CLAUDE.md
(which that command doesn't count) as a labelled estimate. On releases without `plugin details`
it falls back to an estimate and says so. With `--history` it reports the trend, for example
"Your setup got 18% more expensive on Claude Code 2.1.295: 400 to 472 always-on tokens per
session", names the components that moved most, and says whether your files changed or Claude
Code did. The Action measures it on every run, and the observatory shows a "Context cost per
release" strip once measurements exist.

### Real usage vs evals: is your suite testing what people do?

Your eval suite says which skills trigger. Your session history says which ones people actually
use. `usage-check` sets the two side by side:

```bash
node <plugin-root>/tools/usage-check.mjs <plugin>                                     # last 30 days
node <plugin-root>/tools/usage-check.mjs <plugin> results/aggregate-result.json --since 90d --projects '*my-repo*'
claude -p "/skill-doctor" > sd.txt && node <plugin-root>/tools/usage-check.mjs <plugin> --skill-doctor sd.txt --html usage.html
```

It reads your local Claude Code transcripts (`~/.claude/projects`), counts how often each skill was
invoked, and gives every skill one verdict:

- **dead weight**: never invoked and no case. It costs context every session.
- **tested but unused**: your suite may test a prompt nobody writes.
- **used but untested**: if it breaks, nothing will tell you.
- **healthy**.

Add the text of `/skill-doctor` with `--skill-doctor` to include its measured context cost per
skill. Output is text, `--json`, `--md` or a self-contained `--html` page. Only skill names, counts
and dates are read out of the transcripts; no prompt or reply text is ever copied. This one runs
on your machine, not in CI, because that's where the real usage lives.

### When and how repair runs

Repair never runs on its own. It runs in exactly two situations: you invoke
`/config-drift-checker:repair` after a red run, or the Action ran with `repair: true` and the run
came out red. What it then does, in order: reads the failing runs' transcripts and classifies the
failure; finds the instruction in your CLAUDE.md, skill or hook that should have produced the
behaviour; makes the smallest edit that makes it land again (reword, add an example, move the rule,
or add a hook when prose is structurally unreliable); re-runs only the failing cases to prove the
fix; and writes a PR-ready summary. Hard limits: it may touch CLAUDE.md, skills and hooks only,
never anything under `evals/`; it never loosens a rule to make a case pass; it stops at the budget;
and its PR is never auto-merged, you review it like any other. Full procedure:
[the repair skill](https://github.com/jameskomo/config-drift-checker/blob/main/config-drift-checker/skills/repair/SKILL.md).
What one looks like in practice:
[a real repair, verified](https://github.com/jameskomo/config-drift-checker/blob/main/docs/example-break/repair-summary.md).

## 8. Fleet: many repos, one view

Running the check on several repos? `tools/fleet.mjs` pulls every repo's published results (their
`eval-results` branches) into one dashboard with a pin policy:

```bash
node <plugin-root>/tools/fleet.mjs --config fleet.yml --out fleet.html
```

`fleet.yml` lists the repos and the pins they should all be on (`policy: model / harness`); the
table shows each repo's status, pins, policy skew, month spend, coverage and last run, and any
repo whose pins differ from the policy is flagged. Repos with errored or missing data exit the
command red, so the fleet view is itself a check. The ready workflow template is
`ci/fleet.yml` in the plugin: drop it in a small fleet repo with your `fleet.yml`, and it publishes
`docs/fleet.html` on a schedule (Pages source: main, folder /docs); private repos need a PAT with
org read as `FLEET_TOKEN`.

### Rolling it out across an org (no hosted app)

Put `ci/org-reusable.yml` (from the plugin) into your org's `.github` repository as
`.github/workflows/config-drift-checker.yml`, set the org-level Actions secret
(`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) once, and each member repo installs the whole
check with the three-line caller in `ci/org-caller.yml`: `uses: your-org/.github/...` plus
`secrets: inherit`. Combine with the fleet dashboard above and you have org rollout plus org
overview with zero hosted infrastructure. A GitHub App could remove even the caller file, but it
would put a server of ours between your code and your key, which is exactly what this tool
promises not to have; if that trade ever changes, it will be loudly opt-in.

## 9. The drift index

Every CI run also writes a dashboard to the `eval-results` branch under `docs/`: the verdict,
pinned baseline vs latest canary, budget spent, coverage, a ribbon of every case over every run,
score per case over Claude Code versions, and a linked run list. Publish it: Settings → Pages →
Source: branch `eval-results`, folder `/docs`. Turn it off with `pages: 'false'` on the Action.

- Ours: https://jameskomo.github.io/config-drift-checker/drift/
- Coverage badge: `![agent-config coverage](https://raw.githubusercontent.com/<you>/<repo>/eval-results/docs/coverage.svg)`
- Status badge (live: latest Claude Code tested, releases-clean streak, red on drift):
  `![agent setup](https://raw.githubusercontent.com/<you>/<repo>/eval-results/docs/status.svg)`
- The drift wire: next to the index the dashboard writes `verdicts.json` (one verdict per Claude
  Code version) and `feed.xml`, an Atom feed anyone can subscribe to: your suite's behavioural
  changelog of Claude Code releases. Set the Action's `report-base-url` (or `--page-url` locally)
  so the feed carries absolute links.
- Digest and posts: `node tools/drift-digest.mjs <drift-docs> --md digest.md --posts-dir posts/`
  writes the week's digest plus full per-platform announcements for the newest verdict (`x.txt`
  sized to the limit, `linkedin.txt`, `bluesky-mastodon.txt`, and `reddit.md` only when a release
  actually drifted). Marketing copy is yours to keep private; only the data (`verdicts.json`,
  `feed.xml`) is published.
- Locally: `node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html`

### The public Claude Code release report

Your own observatory watches your suite. The
[release report](https://jameskomo.github.io/config-drift-checker/release-report/) watches
everyone's: on every Claude Code release, a daily job loads every public `claude plugin eval` suite
we can find, under the new version and the one before it. Each case is listed as loads, broke on
this release, fixed on this release, or never loaded, with the runner's own error and the
suite-doctor fix. It is free and safe by construction: the runner's $0 cost ceiling stops before
any agent starts, the runner gets no credentials, and nothing from the cloned repos is installed or
run. Suite authors can fix their cases with `node tools/suite-doctor.mjs <plugin> --fix`, or open an
issue to opt out. Run it yourself with `node <plugin-root>/tools/release-report.mjs --discover`.

## 10. Local commands

```bash
/config-drift-checker:run                      # inside Claude Code: run, diff, explain red
/config-drift-checker:repair                   # after red: smallest setup fix, verified, PR-ready summary
node <plugin-root>/tools/eval-shim.mjs <plugin> --scaffold                  # everything, with/without ablation
node <plugin-root>/tools/eval-shim.mjs <plugin> --track canary --scaffold   # what developers get today
node <plugin-root>/tools/eval-shim.mjs <plugin> --case 'guard*' --runs 1 --ablation none --scaffold --budget 0.5
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json --config <plugin>   # exit 1 on red
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json --history evals/results --config <plugin>   # + noise bands
node <plugin-root>/tools/baseline-check.mjs aggregate-result.json --config <plugin>   # exit 1 if not baseline material
node <plugin-root>/tools/eval-report.mjs current.json --baseline baseline.json --config <plugin>
node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html
node <plugin-root>/tools/config-coverage.mjs <plugin> --list       # rule ids to put in a case's covers.yaml
node <plugin-root>/tools/config-coverage.mjs <plugin> --fail-under 80   # exit 1 under 80% coverage
node <plugin-root>/tools/cdc-config.mjs <plugin> init              # write .cdc.yml; set-pins --model … --harness …
node <plugin-root>/tools/release-watch.mjs --state .release-watch.json --models --pin claude-sonnet-5
node <plugin-root>/tools/trace-keeper.mjs out.json --clean         # after claude plugin eval --keep-temp: keep transcripts
node <plugin-root>/tools/drift-matrix.mjs <plugin> --models sonnet,haiku --last 5 --dry-run   # models x releases grid
node <plugin-root>/tools/context-cost.mjs <plugin> --md -           # tokens your setup adds to every session
node <plugin-root>/tools/usage-check.mjs <plugin> --since 30d       # real skill usage vs your eval cases
node <plugin-root>/tools/evals-convert.mjs import skills/<s>/evals/evals.json --dry-run   # skill-creator suites in
node <plugin-root>/tools/release-report.mjs --discover              # every public suite on the newest release, $0
```

`<plugin-root>` is where Claude Code installed the plugin (`claude plugin list` shows it). Every
run writes `aggregate-result.json` and `report.html` into `<your-plugin>/evals/results/<timestamp>/`.

## 11. Cost (measured)

$0.05 to $0.08 per short Sonnet run; $0.20 to $0.25 per real-code run. A 3-case suite at 3 runs is
about $0.43 per pinned run; a canary at 1 run per case is $0.15 to $0.20. With
`min_interval_hours: 72`, 25 Claude Code releases a month collapse into at most about 10 canaries,
and `budget.per_month_usd` is the hard ceiling whatever npm publishes. On a subscription token,
API cost is $0 but runs count against that plan's usage limits: a six-case canary is about six
short agent runs per release, three times that only when a case deviates. Use `ablation: none`
in CI and Haiku for PR smoke.

## 12. Safety

Workspaces are throwaway directories, not sandboxes for Docker, the network or your host. Every
run carries a safety-net hook that blocks `docker compose down -v`, prunes, force-pushes, `rm -rf`
outside the workspace, `DROP TABLE` and similar, in both arms. Write hook cases so the command is
harmless when it succeeds: a scratch git repo, or a stub binary in `.eval-bin/` (the `setup` skill
does this for you). Read third-party suites before running them with `--scaffold`. The `repair`
skill may edit `CLAUDE.md`, skills and hooks only, never a case or grader, and every PR it opens
carries its re-run evidence and is never auto-merged.

## 13. See it work: the demo repo

[config-drift-checker-demo](https://github.com/jameskomo/config-drift-checker-demo) is a small
Spring Boot notes API with a typical setup: CLAUDE.md, one conventions skill, one guard hook.
`/config-drift-checker:setup` ran against it unattended (78 turns, 13 minutes, $1.68) and wrote
three cases from the real content: a real-code case that asks for a feature the API doesn't have
and grades the diff, a negative-trigger case, and a guard-hook case in a scratch git repo. It
smoke-ran them, fixed two of its own graders, and reached 1.00. Everything it produced is in the
repo as generated, run log included. Read those three cases first; they are the best starting
point for writing your own.

## 14. FAQ

**Isn't this what `/doctor` or `/skill-doctor` does?** No. Those are static health checks: they
never run the agent. A setup can be perfectly well-formed and silently useless after a release.
This runs real tasks and compares behaviour with your baseline. Linter versus test suite.

**Will this drain my API key?** Not past `budget.per_month_usd`. The gate reads the ledger before
every run and skips with a notice at the cap; the runner stops mid-run at `per_run_usd`; scheduled
canaries are throttled by `min_interval_hours`.

**Do the bump / pin / repair PRs merge themselves?** Never. They carry the evidence; you decide.

**What if my pinned model is retired?** `release-watch --pin` warns when the id disappears from
Anthropic's model list; the next green canary streak opens a bump PR to a current id.

**Does installing the plugin change my repos?** No. Only `setup` writes files, only in the repo
you run it in, as a reviewable diff.

**Does pushing a repo trigger Actions/Slack by itself?** Only if that repo has the workflow file
and the secrets. No workflow file, nothing runs. No key, the run fails loudly.

**Do I need Anthropic's `claude plugin eval`?** It ships with current Claude Code and the Action
prefers it automatically; the bundled runner covers older versions. Both read the same case
format, and a `claude plugin eval ... --json out.json` result diffs directly against any baseline.
One caveat: the official runner keeps transcripts in a temp trace, so refusal labelling needs
`--keep-temp` plus `tools/trace-keeper.mjs` (see the runbook).

**Where does my code go?** Into a temporary directory on your runner for one run, then deleted.
Results stay in your repo's `eval-results` branch and the workflow artifact. We operate no server.

**Can I test CLAUDE.md rules?** Yes. Cases copy your `CLAUDE.md` into the workspace via
`scaffold_script`, so the rule is in force during the run and the grader checks the outcome.

**Codex / Gemini / Cursor?** Codex is in, experimental: `--agent codex` on the shim runs the same
cases through OpenAI's Codex CLI (`codex exec`), bridges your `CLAUDE.md` to `AGENTS.md` in the
workspace, and grades with the same graders; Claude-only indicators like `tool_used: Skill` are
skipped, not failed, so scores stay comparable. Codex has no subscription-token equivalent here,
so runs use your ChatGPT plan's included usage (or bill an OpenAI key). Gemini is in too:
`--agent gemini` runs headlessly with `GEMINI.md` bridging on the free Google tier; it emits no
machine-readable tool calls, so tool-use indicators are skipped and the content graders carry
the score. The case format and `.cdc.yml` stay agent-agnostic.

**Licence?** FSL-1.1-Apache-2.0: free to use, modify and self-host in your own CI; not to be
offered as a competing commercial service; each release becomes Apache-2.0 two years after
publication.

**Uninstall:** delete the workflow file, `.cdc.yml` and the `evals/` folder;
`claude plugin uninstall config-drift-checker@jameskomo`.
