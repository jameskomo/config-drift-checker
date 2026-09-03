---
type: llm
criteria: The request and response shapes are Java records grouped in a <Feature>Dtos holder class (e.g. InvoiceDtos or BillingDtos). The request body is validated with jakarta.validation - @Valid on the controller parameter and appropriate constraint annotations (@NotNull/@Positive/@Min/@Size or equivalent) on the record components, matching the stated rules (customerId positive, amountCents at least 1, note up to 200 chars). The response is wrapped in ApiResponse.ok(...). Score 1 only if all hold.
target: last_message
---
Judge the DTO and validation conventions.
