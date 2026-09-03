---
description: The tripwire for "the skill stopped working": on plainly in-scope Spring work, the spring-boot-conventions skill must fire. If plugin loading breaks (a Claude Code update, a renamed skill, a drifted trigger description), this is the case that goes red first — cleanly, before the content cases fail in confusing ways. Twin of the vue negative-trigger case.
name: Spring work triggers the conventions skill
tags: [skill, spring, trigger]
covers: []
runs: 3
max_turns: 6
timeout_seconds: 240
---
Quick one: sketch a Spring Boot endpoint `GET /api/billing/invoices/{id}` for our billing module,
package `com.acme.billing`, assuming `InvoiceService.getInvoice(long id)` exists. Print the Java
source in your reply.
