---
type: llm
criteria: The ownership check (customerId matches the invoice's customer) and the unpaid-status rule are both enforced inside the service method itself — not left to the controller or to security configuration — and each violation throws a distinct domain exception. Errors reach the client through a @RestControllerAdvice handler producing ApiResponse.error(...), with no try/catch in any controller. The service never returns Map<String, Object> (void, a record, or a small result type are all fine). Score 1 only if all hold.
target: last_message
---
Judge the service against the "two locks on the door" and error-handling house conventions.
