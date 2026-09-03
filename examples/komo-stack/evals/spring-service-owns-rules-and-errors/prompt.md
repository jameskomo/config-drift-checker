---
description: Proves business rules and authorization live in the service (not the controller), failures are domain exceptions mapped by a @RestControllerAdvice handler, and services return records rather than Map<String, Object>; exercises the spring-boot-conventions skill.
name: Spring service owns rules, exceptions and result types
tags: [skill, spring]
covers: [skill/spring-boot-conventions/business-rules-and-authorization-checks-live, skill/spring-boot-conventions/services-return-records-or-small-result, skill/spring-boot-conventions/throw-domain-exceptions-a-restcontrolleradvice-handler]
runs: 3
max_turns: 8
timeout_seconds: 300
---
Add invoice cancellation to our Spring Boot billing module, package `com.acme.billing`.
The rule: a customer may cancel only their own invoice, and only while it is still unpaid.
Assume an `InvoiceRepository` with `Optional<Invoice> findById(long id)` exists and that the
caller passes the current customer's id as `long customerId`; `Invoice` has `customerId()`,
`status()` and `markCancelled()`. Write the service class that implements this, and whatever
else is needed for a failed cancellation to reach the API client as a proper error response.
Print the complete Java source in your reply.
