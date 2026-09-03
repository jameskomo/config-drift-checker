---
type: regex
pattern: '@(NotNull|NotBlank|Positive|Min|Max|Size)\('
target: last_message
match: contains
---
Constraint annotations from jakarta.validation appear on the record components.
