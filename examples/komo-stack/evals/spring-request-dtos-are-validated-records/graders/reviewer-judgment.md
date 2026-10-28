---
type: llm
criteria: The request and response shapes are Java records grouped in a <Feature>Dtos holder class (e.g. InvoiceDtos or BillingDtos). The request body is validated with jakarta.validation - @Valid on the controller parameter and appropriate constraint annotations (@NotNull/@Positive/@Min/@Size or equivalent) on the record components that fit the fields (an id and an amount that must be present and above zero, a note with a length limit). The response is wrapped in ApiResponse.ok(...). The prompt leaves the exact limits, boxed or primitive types, the HTTP status and the service's return type open, so any reasonable choice there is fine. Score 1 only if all hold.
focus: last_message
---
Judge the DTO and validation conventions.
