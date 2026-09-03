---
type: regex
pattern: Map<String,\s*Object>
target: last_message
match: not_contains
---
The service does not smuggle results or errors through Map&lt;String, Object&gt;.
