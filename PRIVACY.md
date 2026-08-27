# Privacy

**config-drift-checker collects no data and operates no servers.**

- The plugin and the GitHub Action run on your machine and in your own CI. There is no telemetry,
  no analytics, no account, and no endpoint of ours that anything is sent to.
- The only network traffic is Claude Code's own calls to Anthropic's API using **your** credentials
  (your subscription locally, your API key in CI), and `npm view` to check the published Claude Code
  version for release-watch.
- Eval runs happen in throwaway directories that are deleted after each run. Results — scores,
  the agent's responses and tool calls, and files it changed — are written only to your repository
  (`evals/results/`, the `eval-results` branch) and your workflow artifacts. You decide whether that
  repository is public or private.
- A PreToolUse "safety net" hook is injected into eval sessions to block destructive commands; it
  reads the command being run and nothing else, and writes nothing.
- Anthropic's handling of the prompts and responses in those API calls is governed by
  Anthropic's own policies, under your agreement with them: https://www.anthropic.com/legal/privacy

Questions: progressoverperfection01@gmail.com
