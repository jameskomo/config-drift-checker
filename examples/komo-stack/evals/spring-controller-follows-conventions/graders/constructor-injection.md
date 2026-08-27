---
type: regex
pattern: public\s+\w+Controller\s*\(\s*\w+Service\s+\w+
target: last_message
match: contains
---
The controller declares an explicit hand-written constructor taking the service.
