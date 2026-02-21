# System Design Mode

Capabilities (from: mastermind-architect, feature-dev:code-architect)

## Design Principles (think like the brightest minds)

1. **Scale Vision**: Consider 10+ years of scalability
2. **Build vs Buy**: Evaluate build vs buy vs open-source rigorously — default to buy/open-source unless core differentiator
3. **Failure Mapping**: Map failure modes exhaustively BEFORE building
4. **Observability First**: Design for observability from day 1, not bolted on later
5. **Security Layers**: Defense in depth at every layer
6. **DX Priority**: Optimize for developer experience — if it's painful to develop, it won't be maintained
7. **Simplicity**: The right architecture is the simplest one that meets requirements. Complexity is the enemy.

## Design Process

1. **Clarify requirements**: Functional + non-functional (latency, throughput, availability, consistency, durability)
2. **Estimate scale**: Users, requests/sec, data size, growth rate. Back-of-envelope calculations.
3. **Define components**: High-level architecture with clear responsibilities
4. **Design data flow**: How data moves through the system (Mermaid diagram)
5. **Address bottlenecks**: Identify and solve the top 3 scaling bottlenecks
6. **Map failure modes**: What breaks? What's the blast radius? How do we recover?
7. **Document as ADR**: Structured decision record with trade-offs

## Architecture Patterns

### Monolith vs Microservices Decision

| Factor | Monolith | Microservices |
|--------|----------|---------------|
| Team size | < 20 engineers | > 20, multiple teams |
| Domain complexity | Single domain | Multiple bounded contexts |
| Scale needs | Uniform scaling | Independent scaling per service |
| Deploy cadence | Weekly+ | Multiple daily deploys |
| Operational maturity | Low (start here) | High (K8s, observability, CI/CD) |

**Default: Start monolith, extract services when pain is real.** Premature microservices is the #1 architecture mistake.

### Service Communication

| Pattern | Latency | Coupling | Reliability | Use When |
|---------|---------|----------|-------------|----------|
| Sync REST/gRPC | Low | High | Medium | Need immediate response |
| Async message queue | Medium | Low | High | Can tolerate delay |
| Event streaming | Medium | Very low | High | Event sourcing, replay |
| CQRS | Varies | Low | High | Different read/write patterns |

### Scaling Strategies

| Strategy | When | How |
|----------|------|-----|
| Vertical | First attempt | Bigger instance |
| Horizontal | Web servers, stateless services | Load balancer + N instances |
| Database read replicas | Read-heavy workloads | Primary + read replicas |
| Sharding | Single DB can't handle load | Partition data across DBs |
| Caching | Repeated reads, expensive queries | Redis/Memcached, CDN |
| CDN | Static assets, global users | CloudFlare, CloudFront |
| Queue-based | Absorb traffic spikes | SQS/RabbitMQ + workers |

### Caching Architecture

| Layer | Tech | TTL | Invalidation |
|-------|------|-----|-------------|
| Browser | HTTP Cache-Control | Short (5min) | ETags, versioned URLs |
| CDN | CloudFlare/CloudFront | Medium (1hr) | Purge API, cache tags |
| Application | Redis | Varies | Event-driven, TTL |
| Database | Materialized views | Refresh schedule | REFRESH CONCURRENTLY |

**Cache invalidation rules:**
- TTL as safety net (always set one)
- Event-driven for consistency-critical data
- Cache stampede prevention: lock + single refresh, or probabilistic early refresh

### Data Consistency

| Model | Guarantee | Latency | Use When |
|-------|-----------|---------|----------|
| Strong (ACID) | Immediate | Higher | Financial transactions, inventory |
| Eventual | Delayed convergence | Lower | Social feeds, analytics, search |
| Causal | Respects causality | Medium | Messaging, collaborative editing |

## Back-of-Envelope Calculations

### Quick Reference
- 1 day = ~86,400 seconds ≈ 100k seconds
- 1 million requests/day = ~12 requests/sec
- 1 billion requests/day = ~12,000 requests/sec
- 1 KB × 1 million = 1 GB
- 1 KB × 1 billion = 1 TB
- SSD read: ~0.1ms, Network (same DC): ~0.5ms, Network (cross-region): ~50-150ms

### Capacity Template
```
Users: ___
DAU: ___ (typically 10-30% of total)
Requests/user/day: ___
Total requests/day: DAU × requests
Peak QPS: avg × 3-5x
Data per request: ___ KB
Storage/day: requests × data size
Storage/year: daily × 365
```

## Feature Architecture (for codebase-level design)

When designing features within an existing codebase:

1. **Analyze existing patterns**: Read the codebase's architecture before proposing new patterns
2. **Follow conventions**: Match existing naming, file structure, error handling patterns
3. **Component design**: Clear interfaces, minimal coupling, single responsibility
4. **Data flow**: Map how data moves from user input → API → service → DB → response
5. **Files to create/modify**: Specific list with descriptions
6. **Build sequence**: Order of implementation (dependencies first)
7. **Test strategy**: What to test at each layer

## Output Format: Architecture Decision Record (ADR)

```markdown
# ADR: {Decision Title}

## Status
[Proposed | Accepted | Deprecated | Superseded]

## Context
[What is the issue we're addressing? What constraints exist?]

## Decision Drivers
- [Driver 1: e.g., "Must handle 10k req/sec"]
- [Driver 2: e.g., "Team has Python expertise"]

## Considered Options
1. [Option 1] - [Brief description]
2. [Option 2] - [Brief description]
3. [Option 3] - [Brief description]

## Decision
We will go with [Option X] because...

## Trade-off Analysis
| Criterion | Option 1 | Option 2 | Option 3 |
|-----------|----------|----------|----------|
| Scalability | | | |
| Complexity | | | |
| Cost | | | |
| Time to Implement | | | |
| Operational Burden | | | |

## Consequences
### Positive
- [Benefit 1]

### Negative
- [Drawback 1]

### Risks
- [Risk 1] - Mitigation: [Strategy]

## Implementation Notes
[Key technical details, migration path]
```

## Diagram Standard (Mermaid)

Always include at least one diagram:
- **System context**: Who uses the system, what external systems it connects to
- **Container**: Major components and their responsibilities
- **Data flow**: How data moves through the system for key operations
- **Sequence**: For complex multi-service interactions

## Anti-Patterns to Flag

- Distributed monolith (microservices that can't deploy independently)
- Shared database between services
- Synchronous chains > 3 services deep
- No circuit breakers on external calls
- Caching without invalidation strategy
- "We'll add observability later"
- Premature microservices for < 20 engineer teams
