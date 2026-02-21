# Database Design Mode

Capabilities (from: database-architect, sql-pro, postgresql skill)

## Design Process (follow this order)

1. **Understand requirements**: Business domain, access patterns (read/write ratio), scale expectations, consistency needs, compliance (GDPR/HIPAA/PCI)
2. **Select technology**: Use decision framework below
3. **Design schema**: Conceptual → Logical (normalize to 3NF) → Physical (denormalize only for measured, high-ROI reads)
4. **Plan indexing**: Based on actual query patterns, not speculation
5. **Design caching**: Multi-tier if needed (app → query → object → CDN)
6. **Plan scalability**: Partitioning, sharding, replication strategies
7. **Migration strategy**: Version-controlled, zero-downtime approach
8. **Document decisions**: ADR format with trade-offs and alternatives considered

## Technology Selection Framework

| Need | Choose | Why |
|------|--------|-----|
| Relational + ACID | PostgreSQL (default) | Best open-source, extensible, JSONB |
| High-write throughput | TimescaleDB (time-series), Cassandra (wide-column) | Optimized for append patterns |
| Document store | MongoDB (flexible schema), Firestore (serverless) | Schema-on-read flexibility |
| Key-value / cache | Redis | Sub-ms reads, pub/sub, data structures |
| Search | Elasticsearch, Meilisearch (simpler) | Full-text, fuzzy, faceted |
| Graph relationships | Neo4j | When JOINs become unmanageable |
| Analytics/OLAP | ClickHouse, BigQuery, Snowflake | Columnar, aggregation-heavy |
| Multi-model | Use polyglot persistence | Right tool per access pattern |

**Decision drivers:** CAP theorem position, operational complexity, cost, team expertise, cloud provider alignment.

## PostgreSQL Design Rules (PRIMARY — use for most projects)

### Data Types (strict rules)
- **IDs**: `BIGINT GENERATED ALWAYS AS IDENTITY` (default). `UUID` only for distributed/federated systems. Generate with `gen_random_uuid()`.
- **Strings**: `TEXT` always. Never `VARCHAR(n)` or `CHAR(n)`. Use `CHECK (LENGTH(col) <= n)` if limit needed.
- **Money**: `NUMERIC(p,s)` — never float, never `MONEY` type.
- **Time**: `TIMESTAMPTZ` always — never bare `TIMESTAMP`. `DATE` for date-only. `now()` for transaction time, `clock_timestamp()` for wall-clock.
- **Booleans**: `BOOLEAN NOT NULL` unless tri-state required.
- **Enums**: `CREATE TYPE ... AS ENUM` for stable sets (days, states). `TEXT + CHECK` for evolving business values.
- **JSON**: `JSONB` only (never `JSON`). Index with GIN. Use for optional/semi-structured attrs only — keep core relations in tables.
- **Arrays**: `TEXT[]`, `INTEGER[]` etc. Index with GIN for `@>`, `<@`, `&&`. Good for tags; bad for relations (use junction tables).
- **Ranges**: `daterange`, `numrange`, `tstzrange`. Index with GiST. Prefer `[)` bounds consistently.

### DO NOT USE
- `timestamp` (without timezone) → use `timestamptz`
- `char(n)` or `varchar(n)` → use `text`
- `money` type → use `numeric`
- `serial` → use `generated always as identity`
- `timetz` → use `timestamptz`

### Constraints
- **PK**: Always define. Implicit UNIQUE + NOT NULL + B-tree index.
- **FK**: Always specify `ON DELETE` action. Always add explicit index on FK columns (PostgreSQL does NOT auto-index FKs).
- **NOT NULL**: Add everywhere semantically required. Use `DEFAULT` for common values.
- **UNIQUE**: Use `NULLS NOT DISTINCT` (PG15+) unless you specifically need duplicate NULLs.
- **CHECK**: Remember NULL passes checks (three-valued logic). Combine with NOT NULL.
- **EXCLUDE**: For overlap prevention (e.g., room booking with GiST).

### Indexing Strategy
- **B-tree** (default): Equality/range (`=`, `<`, `>`, `BETWEEN`, `ORDER BY`)
- **Composite**: Column order matters — leftmost prefix matching. Most selective columns first.
- **Covering**: `CREATE INDEX ON tbl (id) INCLUDE (name, email)` — index-only scans.
- **Partial**: Hot subsets — `CREATE INDEX ON tbl (user_id) WHERE status = 'active'`
- **Expression**: Computed keys — `CREATE INDEX ON tbl (LOWER(email))`
- **GIN**: JSONB (`@>`, `?`), arrays, full-text search (`@@`)
- **GiST**: Ranges, geometry, exclusion constraints
- **BRIN**: Very large, naturally ordered data (time-series). Minimal storage.

### Gotchas
- Unquoted identifiers → lowercased. Use `snake_case` convention.
- UNIQUE allows multiple NULLs (use `NULLS NOT DISTINCT` PG15+).
- FK columns NOT auto-indexed — add them manually.
- No silent coercions — length/precision overflows error out.
- Sequences have gaps (normal — don't "fix").
- No clustered PK by default (heap storage). `CLUSTER` is one-off.
- MVCC: updates leave dead tuples — design to avoid hot wide-row churn.

### Partitioning (>100M rows or periodic data maintenance)
- **RANGE**: Time-series — `PARTITION BY RANGE (created_at)`
- **LIST**: Discrete values — `PARTITION BY LIST (region)`
- **HASH**: Even distribution — `PARTITION BY HASH (user_id)`
- No global UNIQUE constraints — include partition key in PK/UNIQUE.
- Use declarative partitioning (PG10+). Never table inheritance.
- Consider TimescaleDB for automated time-based partitioning + compression.

### Performance Patterns
- **Update-heavy**: Separate hot/cold columns, `fillfactor=90` for HOT updates, avoid updating indexed columns.
- **Insert-heavy**: Minimize indexes, use `COPY`/multi-row INSERT, UNLOGGED for staging, defer index creation for bulk loads.
- **Upsert**: Requires UNIQUE index on conflict target. Use `EXCLUDED.column`. `DO NOTHING` faster than `DO UPDATE`.

## Schema Design Patterns

### Normalization Strategy
- Start at 3NF always. Denormalize only for measured read performance gains.
- **OLTP**: Normalize for write efficiency and consistency.
- **OLAP**: Denormalize (star/snowflake schema) for read performance.
- **Hybrid**: Materialized views for analytical queries on normalized data.

### Multi-Tenancy Approaches
| Approach | Isolation | Complexity | Cost | Best For |
|----------|-----------|------------|------|----------|
| Shared schema + RLS | Low | Low | Low | Most SaaS |
| Schema per tenant | Medium | Medium | Medium | Compliance-heavy |
| DB per tenant | High | High | High | Enterprise/regulated |

### Hierarchical Data
- **Adjacency list**: Simple parent_id FK. Easy writes, recursive queries for reads.
- **Materialized path**: Store full path (`/1/3/7/`). Fast reads, complex writes.
- **Closure table**: All ancestor-descendant pairs. Fast reads + writes, more storage.
- **Nested sets**: Left/right values. Very fast reads, expensive writes.

## Migration Planning

1. **Never** use `git add .` or broad staging for migrations.
2. Zero-downtime approach: add column → backfill → add constraint → update code → drop old.
3. `CREATE INDEX CONCURRENTLY` to avoid write locks (can't run in transactions).
4. Volatile defaults (e.g., `now()`) cause full table rewrite — avoid for large tables.
5. Tools: Alembic (Python), Prisma Migrate (JS/TS), Flyway (Java), Liquibase (multi).
6. Test migrations on production-sized data before deploying.

## Cloud Database Selection

| Cloud | Managed PostgreSQL | Serverless | NoSQL | Analytics |
|-------|-------------------|------------|-------|-----------|
| AWS | RDS/Aurora | Aurora Serverless | DynamoDB | Redshift/Athena |
| GCP | Cloud SQL | Spanner | Firestore | BigQuery |
| Azure | DB for PostgreSQL | Cosmos DB | Cosmos DB | Synapse |

Default recommendation: **PostgreSQL on Aurora** (AWS) or **Cloud SQL** (GCP) unless specific needs dictate otherwise.

## Extensions (PostgreSQL)
- `pgcrypto`: Password hashing with `crypt()`
- `pg_trgm`: Fuzzy text search (`%`, `similarity()`)
- `timescaledb`: Time-series partitioning, compression, continuous aggregates
- `postgis`: Geospatial queries
- `pgvector`: Vector similarity search for embeddings
- `pgaudit`: Compliance audit logging

## Output Format

Always deliver:
1. **Technology recommendation** with selection rationale
2. **Schema DDL** with tables, constraints, indexes (not just descriptions)
3. **Index strategy** tied to specific query patterns
4. **Migration plan** with phases and rollback procedures
5. **ADR** documenting trade-offs and alternatives considered
6. **Mermaid ERD** when requested
