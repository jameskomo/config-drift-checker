---
type: regex
pattern: '\bcatch\s*\('
target: last_message
match: not_contains
---
No try/catch anywhere: refused cancellations propagate as domain exceptions to the @RestControllerAdvice handler.
