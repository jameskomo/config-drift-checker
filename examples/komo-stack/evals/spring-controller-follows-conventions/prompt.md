---
description: Proves the conventions skill shapes generated Java: envelope, constructor injection, page clamping; exercises the spring-boot-conventions skill.
name: Spring controller follows house conventions
tags: [skill, spring]
covers: [skill/spring-boot-conventions/explicit-constructor-injection-only-declare-dependencies, skill/spring-boot-conventions/never-use-field-injection-autowired, skill/spring-boot-conventions/every-response-is-wrapped-apiresponse-ok, skill/spring-boot-conventions/pagination-is-1-based-page, skill/spring-boot-conventions/restcontroller-requestmapping-api-area-thin-parse]
runs: 3
max_turns: 8
timeout_seconds: 300
---
Write a Spring Boot REST controller for listing a customer's invoices with pagination.
Package `com.acme.billing`. Endpoint `GET /api/billing/invoices?page=&size=`.
Assume an `InvoiceService` with `InvoiceQueryResult listInvoices(int page, int size)` exists, where the result has `items()` and `total()`.
Print the complete Java source in your reply.
