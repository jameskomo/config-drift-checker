---
type: regex
pattern: throw\s+new\s+[A-Z]\w*Exception\(
target: last_message
match: contains
---
Rule violations are raised as thrown domain exceptions, not encoded in the return value.
