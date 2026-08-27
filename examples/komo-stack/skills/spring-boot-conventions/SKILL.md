---
name: spring-boot-conventions
description: House conventions for writing Spring Boot (Java) backend code — controllers, services, DTOs, pagination, error responses. Use whenever the user asks to write, add, refactor, or review a Spring Boot controller, service, repository, DTO, endpoint, or REST API in Java. Trigger phrases - "Spring Boot", "REST controller", "@RestController", "endpoint", "service class", "DTO", "JPA repository". Do NOT use for Vue, Pinia, TypeScript, or frontend work.
---

# Spring Boot conventions (example house rules)

Follow these rules exactly. They are the conventions of an example team; adapt them to yours.

## Dependency injection
- **Explicit constructor injection only.** Declare dependencies as `private final` fields and write the constructor by hand.
- **Never** use field injection (`@Autowired` on a field) and **never** use Lombok (`@RequiredArgsConstructor`, `@Data`, `@Builder`, etc.). Lombok is not on the classpath.

## DTOs
- Request and response shapes are Java `record`s, grouped in a `<Feature>Dtos` holder class (e.g. `ModerationDtos.ListingQueueItem`).
- Validate request bodies with `jakarta.validation` (`@Valid`, `@NotBlank`, `@Positive`).

## Controllers
- `@RestController` + `@RequestMapping("/api/<area>")`. Thin: parse/validate input, call one service method, wrap the result.
- Every response is wrapped: `ApiResponse.ok(body)` or `ApiResponse.ok(items, PageMeta.of(page, size, total))` for lists. Never return raw entities or bare lists.
- Pagination is 1-based `page` and `size` query params. Clamp: `int pageNo = Math.max(page, 1); int pageSize = Math.clamp(size, 1, MAX_PAGE_SIZE);` with `MAX_PAGE_SIZE = 100` as a `private static final` constant.

## Services
- Business rules and authorization checks live in the service, even when `SecurityConfig` already gates the route ("two locks on the door").
- Services return records or small result types, never `Map<String, Object>`.

## Errors
- Throw domain exceptions; a `@RestControllerAdvice` handler maps them to `ApiResponse.error(...)`. Do not try/catch in controllers.

## Output format
When asked to write code, produce the complete Java file(s) with package and imports, then a two-line note on which convention decisions you applied.
