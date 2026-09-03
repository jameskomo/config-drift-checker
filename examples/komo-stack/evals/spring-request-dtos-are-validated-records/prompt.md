---
description: Proves request/response shapes are Java records grouped in a <Feature>Dtos holder and that request bodies are validated with jakarta.validation; exercises the spring-boot-conventions skill.
name: Request bodies are validated records in a Dtos holder
tags: [skill, spring]
covers: [skill/spring-boot-conventions/request-and-response-shapes-are-java, skill/spring-boot-conventions/validate-request-bodies-with-jakarta-validation]
runs: 3
max_turns: 8
timeout_seconds: 300
---
Add invoice creation to our Spring Boot billing module, package `com.acme.billing`:
`POST /api/billing/invoices`. The body carries `customerId` (required, positive),
`amountCents` (required, at least 1) and an optional `note` (up to 200 characters).
Assume `InvoiceService.create(long customerId, long amountCents, String note)` exists and
returns the created invoice's data. Define the request and response shapes and the controller
method. Print the complete Java source in your reply.
