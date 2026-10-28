---
type: regex
pattern: public\s+\w+Controller\s*\(\s*\w+Service\s+\w+
target: last_message
match: contains
---
The controller declares an explicit hand-written constructor taking the service. No rule asks for this any more: the model does it by default, so this grader stays as a tripwire in case a model stops.
