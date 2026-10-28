---
description: Proves business rules and authorization live in the service (not the controller), failures are domain exceptions mapped by a @RestControllerAdvice handler, and services return records rather than Map<String, Object>; exercises the spring-boot-conventions skill.
tags: [skill, spring]
runs: 3
max_turns: 8
timeout_seconds: 300
---
Add invoice cancellation to our Spring Boot billing module, package `com.acme.billing`:
`POST /api/billing/invoices/{id}/cancel`. A customer may cancel only their own invoice, and only
while it is still unpaid. Assume an `InvoiceRepository` with `Optional<Invoice> findById(long id)`
exists and that the caller's customer id is available as `long customerId`; `Invoice` has
`customerId()`, `status()` and `markCancelled()`. Write the endpoint and everything behind it,
including how a refused cancellation reaches the API client. Print the complete Java source in your reply.
