---
type: regex
pattern: '^\s*@Autowired\b|^\s*@RequiredArgsConstructor\b|^\s*import\s+lombok\.'
flags: m
target: last_message
match: not_contains
---
No field injection and no Lombok in the code itself (annotation or import at line start — prose mentioning them does not count).
