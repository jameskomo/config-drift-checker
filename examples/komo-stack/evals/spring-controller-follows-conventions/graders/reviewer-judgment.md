---
type: llm
criteria: The Java controller is thin (delegates to the service), returns ApiResponse with PageMeta for the list, uses 1-based page/size params with clamping, uses constructor injection with private final fields, and contains no Lombok or field injection. Score 1 only if all hold.
target: last_message
---
Judge the controller against the stated house conventions.
