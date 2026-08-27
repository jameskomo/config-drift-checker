---
type: regex
pattern: Math\.(clamp|min)\(.*MAX_PAGE_SIZE|MAX_PAGE_SIZE\s*=\s*100
target: last_message
match: contains
---
Page size is clamped against a MAX_PAGE_SIZE constant.
