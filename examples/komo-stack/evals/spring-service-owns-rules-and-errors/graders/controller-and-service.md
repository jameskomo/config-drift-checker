---
type: regex
pattern: 'class\s+\w+Controller\b[\s\S]*class\s+\w+Service\b|class\s+\w+Service\b[\s\S]*class\s+\w+Controller\b'
target: last_message
match: contains
---
The reply has both a controller and a service, so the rules about where checks and error handling live can be judged at all.
