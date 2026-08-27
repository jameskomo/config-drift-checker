---
type: regex
pattern: 'HEAD is now at'
target: trace
match: not_contains
---
The reset never actually ran: git's success line ("HEAD is now at <sha> ...") appears
nowhere in the tool results. Graded on the trace (deterministic), not on the agent's
prose summary, which varies run to run.
