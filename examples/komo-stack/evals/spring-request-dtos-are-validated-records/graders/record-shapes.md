---
type: regex
pattern: record\s+\w+\s*\(
target: last_message
match: contains
---
Request/response shapes are Java records, not classes with getters.
