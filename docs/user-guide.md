# config-drift-checker — user guide

Site: https://jameskomo.github.io/config-drift-checker/ · Drift index (our own suite, every release): https://jameskomo.github.io/config-drift-checker/drift/ · Demo: https://jameskomo.github.io/config-drift-checker-demo/

**CI for your Claude Code setup.** Your CLAUDE.md, skills and hooks are how your code gets
written now — and they break silently when Claude Code ships (25 releases last month), when the
model behind an alias changes, or when a teammate edits a skill. config-drift-checker turns "what my
setup must do" into test cases, runs the real agent against them, diffs the result against a
**pinned baseline**, canaries the **latest** model and Claude Code on a schedule, opens a PR when the
canary has proven a new model, and tells you the moment something regresses — with the reason, not
just a score. All of it inside a **budget you set**.

Works with any codebase (Spring Boot, Nuxt, Django, Go — it tests the *agent's behaviour*, not
your app). Runs on your machine and your GitHub Actions, with your Anthropic API key. Nothing is
sent to us.

## 1. Install (once per machine, 2 commands)

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
```
(Once accepted into Anthropic's community marketplace: `claude plugin marketplace add anthropics/claude-plugins-community` then `claude plugin install config-drift-checker@claude-community`.)

You now have four skills in Claude Code — `/config-drift-checker:setup`, `:run`, `:write-case`,
`:repair` — and the runner scripts inside the plugin. Nothing has touched any repo yet.

## 2. Set up a repo (10 minutes, mostly watching)

In the repo whose Claude Code setup you want protected:

```
claude
> /config-drift-checker:setup
```

Claude will:
1. **Find your setup** — `CLAUDE.md`, `.claude/skills`, hooks, or a plugin manifest. If `.claude/`
   is gitignored it uses `agent-config/` instead. If you have no agent config yet, it proposes a
   minimal CLAUDE.md and manifest inferred from your code and asks you to confirm.
2. **Write three starter cases from your real content**: a skill case (real-code where possible —
   it copies your source into a scratch workspace and asks for a feature that doesn't exist yet),
   a negative-trigger case (the skill must *not* fire on an unrelated request), and a hook case
   (a command your guard must block — stubbed so nothing real can be harmed). Each case says which
   rules it `covers:` so the coverage number means something.
3. **Smoke-run them** and show a table of every grader's verdict. Graders that fail for the wrong
   reason get fixed before you see them.
4. **Write `.cdc.yml`** (pins, budget — see below) and `.github/workflows/config-drift-checker.yml`,
   and offer to set your secrets.

Review the diff like any PR. Commit.

## 3. Wire CI (4 things only you can do)

| What | Where | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` secret | repo → Settings → Secrets → Actions (or `gh secret set ANTHROPIC_API_KEY`) | agent runs bill to **your** key (BYOK). Use an API key from console.anthropic.com and **add prepaid credit first** (a few dollars; see §8). With no credit, runs fail with "Credit balance is too low" and nothing is stored. *Alternative:* `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` runs the official CLI under your subscription — check Anthropic's current terms for CI use before relying on it. |
| `SLACK_WEBHOOK_URL` secret (optional) | Slack → Apps → Incoming Webhooks | regression alerts |
| Workflow permissions **Read and write** | repo → Settings → Actions → General | the run stores results on an `eval-results` branch and comments on PRs |
| **Allow GitHub Actions to create and approve pull requests** | same page | the Action opens *bump*, *pin* and *repair* PRs. Without this it pushes the branch and warns; you open the PR by hand |

Then: Actions → **config-drift-checker** → *Run workflow*. That first run records your **baseline**
and, if `.cdc.yml` has no pin yet, opens a **pin PR** that writes the exact model id and Claude Code
version the baseline was measured on.

## 4. Adding the check to an existing pipeline (no Claude Code needed)

If you already have a plugin manifest and an `evals/` folder — or a teammate ran `setup` — the CI
half is **one step**:

```yaml
# .github/workflows/config-drift-checker.yml — pinned track on push/PR, on demand otherwise
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
      - uses: jameskomo/config-drift-checker/action@v0             # ← the whole check
        with:
          plugin-dir: .                        # where .claude-plugin/plugin.json lives
          track: ${{ inputs.track || 'pinned' }}
          force: ${{ inputs.force || 'false' }}
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}   # optional
```

That one step reads `.cdc.yml`, checks the **budget gate**, installs the pinned Claude Code, runs
your suite, diffs against your baseline (score *and* turns/cost/time), stores results on your
`eval-results` branch, comments on the PR, uploads the `eval-report` artifact, opens a pin/bump PR
when one is due, posts to Slack on regression, and sets the check red or green.

**Add the canary** (latest model + latest Claude Code, on a schedule, only when something shipped)
by adding a `watch` job in front — the full template is in the plugin at `ci/config-drift-checker.yml`
and is what `setup` writes. The canary never fails your PR check; it has its own scheduled run.

**Gate merges on it:** Settings → Branches → branch protection → *Require status checks to pass* →
add `eval`. A setup regression then blocks the PR that caused it.

**Inputs you may want:** `runs: 1` and `model: haiku` for cheap PR smoke; `ablation: with-without`
once, to measure what a skill is worth; `promote-baseline: true` after an intentional change;
`repair: true` to let the agent propose a fix PR on red (spends credit, budget-capped);
`open-prs: false` to keep bump/pin PRs off; `claude-code-version: 2.1.258` to override the pin.

**Which path is for me?**

| You are… | Do |
|---|---|
| a developer with Claude Code who wants the cases written for you | §2 `setup`, then push — it writes `.cdc.yml` and the workflow |
| a platform team adding a stage to an existing pipeline | this section: the step + the secret + the two repo settings |
| on GitLab / Buildkite / other CI | run the runner directly: `node <plugin-root>/tools/eval-shim.mjs <plugin> --track pinned --scaffold` and `eval-diff.mjs --config <plugin>` in your job; the Action is a thin wrapper around them |

<a id="cdcyml"></a>
## .cdc.yml

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
```

**Two tracks.** *Pinned* is your baseline: same model id, same Claude Code version, only your setup
changes — that is the PR check. *Canary* is what your developers get today: the alias model on the
latest Claude Code. A canary regression is an alert, never a red PR check, and never touches the
baseline. Every report stamps the resolved model id and Claude Code version, so a red row is always
attributable to *your change*, *the model*, or *the harness*.

**Bump and pin PRs.** After `promote_after` consecutive green canaries on the same model + version,
the Action opens a PR moving `model.pinned`/`harness.pinned` there, with the runs as evidence. If the
pinned track runs with no pin declared, it opens a PR pinning what the baseline actually measured.
Neither is ever auto-merged. Close one to keep your pins; it proposes again after the next streak.

**Budget.** `per_run_usd` is enforced by the runner mid-run (what already ran is kept and scored;
skipped cases show as ❔, not red). `per_month_usd` is enforced before a run starts, from
`spend.json` on your results branch; a run past the cap is *skipped with a notice*, not failed.
A manual *Run workflow* with `force: true` overrides both — the person clicking is the budget.

## 5. What happens from now on (automatic)

- **Every push/PR** that touches your setup: the **pinned** track runs, diffs against the baseline,
  and sets the check.
- **On the schedule** (with the watch job): `release-watch` checks npm *and* Anthropic's model list.
  Nothing new → nothing runs, nothing costs. Something new → the **canary** runs, at most once per
  `min_interval_hours`, within the monthly budget.
- **Canary green twice** on a new model/version → a **bump PR**. Canary red → Slack, job summary,
  and the dashboard says *baseline holding · canary red*.
- Each run: throwaway workspace, your plugin loaded, each case N times (canary: 1, more only on a
  deviation), graded → compared to baseline → **check green or red**, a table on the PR / job summary
  with turns and cost per case, coverage (which rules have a case), an `eval-report` artifact (one
  HTML file: every run, every grader, judge reasons, tool calls, full responses). Results, spend
  ledger, canary streak and the release-watch state live on the `eval-results` branch — history
  without a database.
- After you change your setup on purpose: *Run workflow* with **promote-baseline** ticked.

## 6. Reading a report — what you're expected to do

Every run produces the same report (job summary + the `eval-report` artifact, or `report.html`
locally). It opens with the verdict and one sentence on what to do; the stamp on the right says which
model and Claude Code version ran and whether either *moved* since the baseline.

| The report says | Do this |
|---|---|
| **No drift** / **baseline recorded** | Nothing. Glance at the stamp. Hover a grader chip if you're curious what each check asserts. |
| **N case(s) regressed** | Open the red case(s) and classify each failing run: |
| ↳ *refused or asked before acting* (1 turn, no tool calls) | the case never reached your skill/hook — rewrite the scenario so the model will attempt it (scratch repo, stub binary, explicit ask) |
| ↳ *skill or hook did not fire* (tool attempted, no block / no Skill call) | a real regression. The stamp tells you whether the model or Claude Code moved. Keep the pins, fix or adapt your setup (or run `/config-drift-checker:repair`), tell the maintainers — that's the changelog nobody publishes |
| ↳ *grader wrong* (matched prose instead of code, a negation, nested parentheses) | fix the grader, then `--regrade` the saved run — do not re-spend the suite |
| ↳ *flaky* (mixed verdicts across runs) | raise `runs` for that case. Never loosen the threshold |
| **efficiency drift** (*slower*, *pricier*, *longer*) | every case still passes but the median turns / cost / time moved past its threshold. A warning by default; add it to `fail_on` to make it red. The postmortem-class regressions (verbosity, effort) show up here first |
| **⚠ agent runs errored** | read the first error text — usually no prepaid API credit on the key's account, or a Claude Code startup failure. Nothing was stored; fix and re-run |
| a run shows the **max_turns** badge (amber card) | it was cut short and scored as-is — raise that case's `max_turns` (real-code cases need ~20) |
| **skipped: budget / interval** | not a failure. Raise `budget.per_month_usd`, wait, or re-run manually with `force` |
| you changed the setup on purpose | re-run with **promote-baseline: true** so this run becomes the new baseline |

In one sentence: a green report asks nothing of you; a red one tells you which of four things
happened — the model refused, the setup regressed, the grader was wrong, or the run was flaky —
and what to do about each.

## 6b. The drift index (history across runs, versions and models)

Every CI run also writes, to the `eval-results` branch under `docs/`: `index.html` — the drift index
for your suite (the verdict, the pinned baseline vs the latest canary, budget spent this month,
coverage, a ribbon of every case over every run with pinned runs filled and canaries outlined, score
per case over Claude Code versions, and the run list with model, version, cost and a link to each
run's report) — plus `report.html` (latest), `history/<run>.html` (every run), `latest.json`,
`coverage.svg` (a badge for your README) and `coverage.json`. To publish: repo → Settings → Pages →
Source: branch `eval-results`, folder `/docs`. Ours, for the plugin's own suite on every Claude Code
release, is https://jameskomo.github.io/config-drift-checker/drift/ . Locally:
`node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html`.
Turn it off with `pages: 'false'` on the Action.

**Coverage badge:** `![agent-config coverage](https://raw.githubusercontent.com/<you>/<repo>/eval-results/docs/coverage.svg)`.

## 7. Local commands

```bash
/config-drift-checker:run                      # inside Claude Code: run, diff, explain red
/config-drift-checker:repair                   # after red: smallest setup fix, verified, PR-ready summary
node <plugin-root>/tools/eval-shim.mjs <plugin> --scaffold                  # everything, with/without ablation
node <plugin-root>/tools/eval-shim.mjs <plugin> --track canary --scaffold   # what developers get today
node <plugin-root>/tools/eval-shim.mjs <plugin> --case 'guard*' --runs 1 --ablation none --scaffold --budget 0.5
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json --config <plugin>   # exit 1 on red
node <plugin-root>/tools/eval-report.mjs current.json --baseline baseline.json --config <plugin>
node <plugin-root>/tools/eval-dashboard.mjs <plugin>/evals/results --config <plugin> --out dashboard.html
node <plugin-root>/tools/config-coverage.mjs <plugin> --list       # rule ids to put in a case's covers:
node <plugin-root>/tools/cdc-config.mjs <plugin> init              # write .cdc.yml; set-pins --model … --harness …
node <plugin-root>/tools/release-watch.mjs --state .release-watch.json --models --pin claude-sonnet-5
```
`<plugin-root>` is where Claude Code installed the plugin (`claude plugin list` shows it). Every run
writes `aggregate-result.json` + `report.html` into `<your-plugin>/evals/results/<timestamp>/`.

## 8. Cost (measured) and how it is capped

$0.05–0.08 per short Sonnet run; $0.20–0.25 per real-code run editing three files. A 3-case suite at
3 runs ≈ $0.43 per pinned run; a canary at 1 run per case ≈ $0.15–0.20. Claude Code ships ~25
releases a month; with `min_interval_hours: 72` that is at most ~10 canaries, and `budget.per_month_usd`
is the hard ceiling whatever npm publishes. Use `ablation: none` for CI (with/without is for proving a
skill's worth once) and Haiku for PR smoke.

## 9. Safety

Workspaces are throwaway directories, not sandboxes for Docker, the network or your host. Every
run carries a safety-net hook that blocks `docker compose down -v`, prunes, force-pushes, `rm -rf`
outside the workspace, `DROP TABLE` and similar — in both arms. Write hook cases so the command is
harmless when it *succeeds*: a scratch git repo, or a stub binary created in `.eval-bin/` by the
case's `scaffold_script` (the `setup` skill does this for you). Read third-party suites before
running them with `--scaffold`. The `repair` skill may edit `CLAUDE.md`, skills and hooks only —
never a case or a grader — and every PR it opens carries its re-run evidence and is never auto-merged.

## 10. See it work — the demo repo

`config-drift-checker-demo` (a tiny Spring Boot 3.5 / Java 21 notes API) is a repo with a typical
setup — `CLAUDE.md`, one conventions skill, one guard hook — and nothing else. Everything below was
done by `/config-drift-checker:setup` **unattended** (headless, `--permission-mode acceptEdits`),
78 turns, 13 minutes, $1.68 of API:

1. It found the manifest, skill, hook and CLAUDE.md, and noticed `.claude/` was gitignored.
2. It wrote three cases under `agent-config/evals/` from that content:
   - **`update-note-endpoint`** — a *real-code* case: copies `src/` and `CLAUDE.md` into the workspace,
     asks for a feature the API doesn't have ("update a note's title and body"), and grades the diff:
     envelope + mapping, no `try/catch`, only the expected files changed, skill used, plus an LLM
     rubric on the changed files.
   - **`negative-dockerfile-request`** — "add a Dockerfile": the backend skill must **not** fire, and the
     Dockerfile must exist afterwards.
   - **`guard-blocks-reset-hard`** — a scratch git repo with a real uncommitted edit; asks for
     `git reset --hard`; asserts it was attempted, the hook blocked it, and the trace never shows
     `HEAD is now at`.
3. It smoke-ran them, **fixed two of its own cases** (the hook prompt was vague enough that the model
   chose `git checkout --` instead of the guarded command; an LLM grader was reading the reply
   instead of the diff), re-ran, and reached 1.00 on 2/2 runs per case.
4. It wrote `.github/workflows/config-drift-checker.yml` and printed the hand-off checklist — plus what
   it could not do (no `gh` → secrets left to the owner).

Everything it produced is in the demo repo as it was generated, with its run log in
the demo repo's `docs/claude/README.md`; its baseline results and HTML report are in `agent-config/evals/results/`.
Read the three cases — they are the best starting point for writing your own.

## 11. FAQ

**Isn't this what `/doctor` (or `/skill-doctor`) does?** No. Those are static health checks: they
confirm your settings parse, your hooks are well-formed, your plugins load, your skills follow best
practices. They never run the agent. A setup can be perfectly well-formed and silently useless after a
release, and `/doctor` will say "no issues found" before and after. config-drift-checker runs real tasks
against your setup, on every release, and compares the behaviour with your baseline. Linter versus test suite.

**Will this drain my API key?** Not past `budget.per_month_usd`. The gate reads the ledger on your
results branch before every run and skips (with a notice, not a red check) when the cap is reached;
the runner stops mid-run at `per_run_usd`; scheduled canaries are throttled by `min_interval_hours`.

**Why did a run say "skipped"?** Budget or interval. The job summary says which and what to change.

**Do the bump / pin / repair PRs merge themselves?** Never. They carry the evidence; you decide.

**What if my pinned model is retired?** `release-watch --pin` warns when the id disappears from
Anthropic's model list; the next green canary streak opens a bump PR to a current id.

**Does installing the plugin change my repos?** No. Only `/config-drift-checker:setup` writes files,
and only in the repo you run it in, as a reviewable diff.

**Does pushing a repo trigger Actions/Slack by itself?** Only if that repo contains the workflow
file *and* the secrets. No workflow file → nothing runs. No API key → the run fails loudly.

**Do I need Anthropic's `claude plugin eval` early access?** No. The bundled runner reads the same
case format. If your account is enabled, the Action switches to the official runner automatically.

**Where does my code go?** Into a temporary directory on your runner for the length of one run,
then deleted. Results (scores, responses, tool calls) stay in your repo's `eval-results` branch and
the workflow artifact. We operate no server.

**Can I test CLAUDE.md rules?** Yes — cases copy your `CLAUDE.md` into the workspace via
`scaffold_script`, so the rule is in force during the run and the grader checks the outcome. Declare
`covers:` on the case and the coverage number tells you which rules still have no test.

**Codex / Gemini / Cursor?** Next. The runner is "spawn a headless agent, grade the trace"; the case
format and `.cdc.yml` are agent-agnostic (`agent:` is reserved).

**Licence?** FSL-1.1-Apache-2.0: free to use, modify and self-host in your own CI; you may not offer it as a competing commercial service; each release becomes Apache-2.0 two years after publication.

**Uninstall:** delete the workflow file, `.cdc.yml` and the `evals/` folder; `claude plugin uninstall config-drift-checker@jameskomo`.
