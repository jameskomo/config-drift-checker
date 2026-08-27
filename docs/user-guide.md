# config-drift-checker — user guide

**CI for your Claude Code setup.** Your CLAUDE.md, skills and hooks are how your code gets
written now — and they break silently when Claude Code ships (25 releases last month), when the
model behind an alias changes, or when a teammate edits a skill. config-drift-checker turns "what my
setup must do" into test cases, runs the real agent against them on every release and every PR,
diffs the result against your baseline, and tells you the day something regresses — with the
reason, not just a score.

Works with any codebase (Spring Boot, Nuxt, Django, Go — it tests the *agent's behaviour*, not
your app). Runs on your machine and your GitHub Actions, with your Anthropic API key. Nothing is
sent to us.

## 1. Install (once per machine, 2 commands)

```bash
claude plugin marketplace add jameskomo/config-drift-checker
claude plugin install config-drift-checker@jameskomo
```
(Once listed in Anthropic's official marketplace: `claude plugin install config-drift-checker`.)

You now have three skills in Claude Code: `/config-drift-checker:setup`, `/config-drift-checker:run`,
`/config-drift-checker:write-case`, and the runner scripts inside the plugin. Nothing has touched any
repo yet.

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
   (a command your guard must block — stubbed so nothing real can be harmed).
3. **Smoke-run them** and show a table of every grader's verdict. Graders that fail for the wrong
   reason get fixed before you see them.
4. **Write `.github/workflows/config-drift-checker.yml`** and offer to set your secrets.

Review the diff like any PR. Commit.

## 3. Wire CI (3 things only you can do)

| What | Where | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` secret | repo → Settings → Secrets → Actions (or `gh secret set ANTHROPIC_API_KEY`) | agent runs bill to **your** key (BYOK). Use an API key from console.anthropic.com, not a consumer subscription — and **add prepaid API credit first** (Billing → a few dollars is enough; a suite costs $1–2 per release). Set a monthly limit there. With no credit, runs fail with "Credit balance is too low" and nothing is stored |
| `SLACK_WEBHOOK_URL` secret (optional) | Slack → Apps → Incoming Webhooks | regression alerts |
| Workflow permissions **Read and write** | repo → Settings → Actions → General | the run stores results on an `eval-results` branch and comments on PRs |

Then: Actions → **config-drift-checker** → *Run workflow*. That first run records your **baseline**.

## 4. Adding the check to an existing pipeline (no Claude Code needed)

If you already have a plugin manifest and an `evals/` folder — or a teammate ran `setup` — the CI
half is **one step**. It can live in its own workflow (recommended: the 6-hourly release-watch
schedule then never touches your main pipeline) or as an extra job in an existing one.

```yaml
# .github/workflows/config-drift-checker.yml
on:
  schedule: [{ cron: '17 */6 * * *' }]        # release-watch: runs only when Claude Code shipped
  pull_request: { paths: ['CLAUDE.md', '.claude/**', 'agent-config/**'] }
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  eval:
    runs-on: ubuntu-latest
    env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }   # your key; runs bill to you
    steps:
      - uses: actions/checkout@v6
      - uses: jameskomo/config-drift-checker/action@v0             # ← the whole check
        with:
          plugin-dir: .                        # where .claude-plugin/plugin.json lives
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}   # optional
```

That one step installs Claude Code, runs your suite, diffs against your baseline, stores results
on your `eval-results` branch, comments on the PR, uploads the `eval-report` artifact, posts to
Slack on regression, and sets the check red or green. (The full template with the release-watch
job that skips runs when nothing shipped is in the plugin: `ci/config-drift-checker.yml`.)

**Gate merges on it:** Settings → Branches → branch protection → *Require status checks to pass* →
add `eval`. A setup regression then blocks the PR that caused it.

**Inputs you may want:** `runs: 1` and `model: haiku` for cheap PR smoke; `ablation: with-without`
once, to measure what a skill is worth; `threshold: 0.15` (default) for what counts as a drop;
`promote-baseline: true` after an intentional change; `claude-code-version: 2.1.247` to pin.

**Which path is for me?**

| You are… | Do |
|---|---|
| a developer with Claude Code who wants the cases written for you | §2 `setup`, then push — it writes the workflow above |
| a platform team adding a stage to an existing pipeline | this section: the step + the secret + (optionally) branch protection |
| on GitLab / Buildkite / other CI | run the runner directly: `node <plugin-root>/tools/eval-shim.mjs <plugin> --scaffold` and `eval-diff.mjs` in your job; the Action is a thin wrapper around them |

## 5. What happens from now on (automatic)

- **Every 6 hours** a tiny job checks npm; if Claude Code published a new version, the suite runs
  against it. No release → nothing runs, nothing costs.
- **Every PR** that touches your setup runs the suite (use `runs: 1`/`model: haiku` for cheap PR smoke).
- Each run: throwaway workspace, your plugin loaded, each case N times, graded → compared to
  baseline → **check green or red**, a table on the PR / job summary, Slack on regression, and an
  `eval-report` artifact (one HTML file: every run, every grader, judge reasons, tool calls, full
  responses). Results are stored on the `eval-results` branch — history without a database.
- After you change your setup on purpose: *Run workflow* with **promote-baseline** ticked.

## 6. Reading a report — what you're expected to do

Every run produces the same report (job summary + the `eval-report` artifact, or `report.html`
locally). It opens with a "How to read this report" block; the rules are:

| The report says | Do this |
|---|---|
| **No regressions** / **baseline recorded** | Nothing. Glance at the strip (overall, cost, model, runner). Hover a grader chip if you're curious what each check asserts. |
| **N regression(s)** | Open the red case card(s) and classify each failing run: |
| ↳ *refused or asked before acting* (1 turn, no tool calls) | the case never reached your skill/hook — rewrite the scenario so the model will attempt it (scratch repo, stub binary, explicit ask) |
| ↳ *skill or hook did not fire* (tool attempted, no block / no Skill call) | a real regression. Pin `claude-code-version` to the last good release in the workflow, fix or adapt your setup, and tell the maintainers — that's the changelog nobody publishes |
| ↳ *grader wrong* (matched prose instead of code, a negation, nested parentheses) | fix the grader, then `--regrade` the saved run — do not re-spend the suite |
| ↳ *flaky* (mixed verdicts across runs) | raise `runs` for that case. Never loosen the threshold |
| **⚠ agent runs errored** | read the first error text — usually no prepaid API credit on the key's account, or a Claude Code startup failure. Nothing was stored; fix and re-run |
| a run shows the **max_turns** badge | it was cut short and scored as-is — raise that case's `max_turns` (real-code cases need ~20) |
| you changed the setup on purpose | re-run with **promote-baseline: true** so this run becomes the new baseline |

In one sentence: a green report asks nothing of you; a red one tells you which of four things
happened — the model refused, the setup regressed, the grader was wrong, or the run was flaky —
and what to do about each.

## 7. Local commands

```bash
/config-drift-checker:run                      # inside Claude Code: run, diff, explain red
node <plugin-root>/tools/eval-shim.mjs <plugin> --scaffold                 # everything, with/without ablation
node <plugin-root>/tools/eval-shim.mjs <plugin> --case 'guard*' --runs 1 --ablation none --scaffold
node <plugin-root>/tools/eval-diff.mjs baseline.json current.json          # exit 1 on regression
node <plugin-root>/tools/eval-report.mjs current.json --baseline baseline.json
```
`<plugin-root>` is where Claude Code installed the plugin (`claude plugin list` shows it). Every run
writes `aggregate-result.json` + `report.html` into `<your-plugin>/evals/results/<timestamp>/`.

## 8. Cost (measured)

$0.05–0.08 per short Sonnet run; $0.20–0.25 per real-code run editing three files. A 5-case suite
at 3 runs ≈ $1–2 per release. Use `ablation: none` for scheduled runs (with/without is for proving a
skill's worth once), Haiku for PR smoke, and the release-watch — not a nightly cron.

## 9. Safety

Workspaces are throwaway directories, not sandboxes for Docker, the network or your host. Every
run carries a safety-net hook that blocks `docker compose down -v`, prunes, force-pushes, `rm -rf`
outside the workspace, `DROP TABLE` and similar — in both arms. Write hook cases so the command is
harmless when it *succeeds*: a scratch git repo, or a stub binary created in `.eval-bin/` by the
case's `scaffold_script` (the `setup` skill does this for you). Read third-party suites before
running them with `--scaffold`.

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
`scaffold_script`, so the rule is in force during the run and the grader checks the outcome.

**Codex / Cursor?** v0.2. The runner is "spawn a headless agent, grade the trace"; the case
format is agent-agnostic.

**Licence?** FSL-1.1-Apache-2.0: free to use, modify and self-host in your own CI; you may not offer it as a competing commercial service; each release becomes Apache-2.0 two years after publication.

**Uninstall:** delete the workflow file and the `evals/` folder; `claude plugin uninstall config-drift-checker@jameskomo`.
