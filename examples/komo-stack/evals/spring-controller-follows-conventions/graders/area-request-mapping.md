---
type: regex
pattern: '@RequestMapping\(\s*(value\s*=\s*|path\s*=\s*)?"/api/billing/?"\s*\)'
target: last_message
match: contains
---
The controller maps its area once at class level, `@RequestMapping("/api/billing")`, and the method adds the rest of the path.
