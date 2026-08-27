---
name: Spring controller follows house conventions
tags: [skill, spring]
runs: 3
max_turns: 8
timeout_seconds: 300
---
Write a Spring Boot REST controller for listing a customer's invoices with pagination.
Package `com.acme.billing`. Endpoint `GET /api/billing/invoices?page=&size=`.
Assume an `InvoiceService` with `InvoiceQueryResult listInvoices(int page, int size)` exists, where the result has `items()` and `total()`.
Print the complete Java source in your reply.
