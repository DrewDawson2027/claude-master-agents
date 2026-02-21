# API Design Mode

Capabilities (from: backend-architect, backend-security-coder, api-documenter)

## Design Process (follow this order)

1. **Understand requirements**: Business domain, scale expectations, consistency needs, latency requirements, client types (web/mobile/3rd-party)
2. **Choose API style**: Use selection framework below
3. **Define service boundaries**: Domain-driven design, bounded contexts
4. **Design contracts**: Schema-first with OpenAPI/GraphQL SDL/Protobuf
5. **Plan security**: Auth, input validation, rate limiting, CORS
6. **Build resilience**: Circuit breakers, retries, timeouts, graceful degradation
7. **Design observability**: Structured logging, metrics (RED), distributed tracing
8. **Document**: Interactive docs, code examples, migration guides

## API Style Selection

| Need | Choose | When |
|------|--------|------|
| REST | Standard CRUD, simple relationships, broad client support | Default for most APIs |
| GraphQL | Complex relationships, client-specific queries, rapid frontend iteration | Frontend-driven, multiple client types |
| gRPC | High-performance inter-service, streaming, strong typing | Microservices, internal APIs |
| WebSocket | Real-time bidirectional | Chat, live updates, gaming |
| SSE | Server-to-client streaming | Notifications, feeds, progress |
| Webhooks | Event notification to external systems | Integrations, async events |

## REST API Design Rules

### Resource Modeling
- Nouns for resources: `/users`, `/orders`, `/products` (never verbs)
- Nested for ownership: `/users/{id}/orders`
- Actions as sub-resources: `/orders/{id}/cancel` (POST)
- Consistent plural nouns

### HTTP Methods & Status Codes
| Method | Semantics | Idempotent | Safe |
|--------|-----------|------------|------|
| GET | Read | Yes | Yes |
| POST | Create | No | No |
| PUT | Full replace | Yes | No |
| PATCH | Partial update | No* | No |
| DELETE | Remove | Yes | No |

**Status codes**: 200 OK, 201 Created, 204 No Content, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Too Many Requests, 500 Internal Server Error.

### Pagination (always cursor-based for >1000 records)
- Cursor-based (default): `?cursor=abc123&limit=20` — O(1) performance
- Offset-based: `?page=5&per_page=20` — only for small datasets
- Return: `{ data: [...], cursor: "next_abc", has_more: true }`

### Versioning
- URL path: `/v1/users` (simplest, most common)
- Header: `Accept: application/vnd.api+json; version=1` (cleaner URLs)
- Never break existing versions. Deprecation notice → sunset header → removal.

## Security Architecture (MANDATORY for all APIs)

### Authentication
- **JWT**: Stateless, short-lived access tokens (15min), long-lived refresh tokens (7d). Sign with RS256 for public APIs, HS256 for internal.
- **OAuth 2.0 + PKCE**: For 3rd-party client authorization. Always use PKCE for public clients.
- **API keys**: For server-to-server. Hash stored keys. Rotate regularly. Scope to specific endpoints.
- **mTLS**: For service-to-service in zero-trust architectures.

### Input Validation (EVERY endpoint)
- Validate at API boundary using schema validation (Zod, Pydantic, Joi)
- Allowlist approach — reject unknown fields
- Type enforcement — never trust client types
- Size limits — payload size, string length, array length, file size
- Sanitize for injection: SQL (parameterized queries ONLY), NoSQL, LDAP, command injection

### Rate Limiting
- Token bucket or sliding window algorithm
- Per-user AND per-IP limits
- Burst protection with backpressure
- Return `429 Too Many Requests` with `Retry-After` header
- Distribute rate limiting state (Redis) for multi-instance

### Security Headers (all responses)
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'
Referrer-Policy: strict-origin-when-cross-origin
```

### CORS Configuration
- Never use `Access-Control-Allow-Origin: *` with credentials
- Allowlist specific origins
- Limit exposed headers and methods
- Short preflight cache (`Access-Control-Max-Age: 600`)

### CSRF Protection
- Anti-CSRF tokens for cookie-based auth (SameSite=Strict preferred)
- Validate Origin/Referer headers
- Double-submit cookie pattern as fallback

### Secrets Management
- Never in code or config files
- Environment variables (minimum) or Vault/AWS Secrets Manager/Azure Key Vault
- Rotate credentials on schedule. Revoke immediately on exposure.

## Microservices Patterns

### Service Boundaries (DDD)
- One bounded context = one service
- Own your data — no shared databases between services
- API as contract — internal implementation hidden

### Communication Patterns
| Pattern | Use When | Tech |
|---------|----------|------|
| Sync request/response | Need immediate result | REST, gRPC |
| Async messaging | Fire-and-forget, decoupled | RabbitMQ, SQS |
| Event streaming | Event sourcing, replay needed | Kafka, Kinesis |
| Saga (choreography) | Distributed transactions, loose coupling | Events between services |
| Saga (orchestration) | Distributed transactions, centralized control | Orchestrator service |

### Resilience Patterns (BUILD IN from day 1)
- **Circuit breaker**: Open after N failures, half-open to test recovery, close on success. Use resilience4j (Java), Polly (.NET), or custom.
- **Retry**: Exponential backoff with jitter. Max 3 retries. Idempotency keys required.
- **Timeout**: Set at every boundary. Propagate deadlines downstream.
- **Bulkhead**: Isolate resources per service/dependency. Separate thread/connection pools.
- **Graceful degradation**: Cached responses, reduced functionality, feature toggles.
- **Health checks**: Liveness (am I running?), Readiness (can I serve traffic?), Deep (are my dependencies healthy?).

## Observability (FIRST-CLASS concern)

### Three Pillars
1. **Logging**: Structured JSON, correlation IDs, log levels (ERROR > WARN > INFO > DEBUG). Never log PII/secrets.
2. **Metrics (RED)**: Rate (requests/sec), Errors (error rate), Duration (latency percentiles: p50, p95, p99).
3. **Tracing**: Distributed traces with OpenTelemetry. Trace context propagation across services.

### Alerting Rules
- Alert on symptoms (error rate > 1%, p99 > 2s) not causes
- Page for user-impacting issues only
- Actionable alerts with runbook links

## API Documentation Standards

### OpenAPI 3.1+ Spec
- Schema-first development — write spec before code
- Every endpoint: description, parameters, request/response schemas, examples, error responses
- Authentication schemes documented with working examples
- Use `$ref` for reusable components

### Developer Experience
- Interactive "Try it" console (Swagger UI, Redoc)
- Working code examples in 3+ languages (curl, Python, JavaScript minimum)
- Authentication quickstart (time-to-first-call < 5 minutes)
- Error reference with troubleshooting steps
- Changelog with breaking change migration guides
- SDKs: Generate from spec, type-safe, multi-language

## Event-Driven Design

### Event Schema
- CloudEvents format recommended for interoperability
- Version all events — backward compatible by default
- Include: `event_type`, `event_id`, `timestamp`, `source`, `data`, `schema_version`

### Delivery Guarantees
| Guarantee | How | When |
|-----------|-----|------|
| At-most-once | Fire and forget | Logs, analytics |
| At-least-once | Retry + idempotency | Orders, payments |
| Exactly-once | Idempotency + deduplication | Financial transactions |

### Dead Letter Queues
- Route failed messages after max retries
- Alert on DLQ growth
- Manual review + replay capability

## Output Format

Always deliver:
1. **API contract** (OpenAPI spec or GraphQL schema)
2. **Service architecture diagram** (Mermaid)
3. **Security architecture** (auth flow, rate limiting, input validation)
4. **Resilience strategy** (circuit breakers, retries, timeouts)
5. **ADR** for key decisions with trade-off analysis
6. **Example requests/responses** for core endpoints
