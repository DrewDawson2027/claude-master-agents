# SQL Optimization Reference Card

## EXPLAIN Analysis (always start here)

```sql
-- Basic
EXPLAIN SELECT * FROM users WHERE email = 'user@example.com';
-- With execution stats
EXPLAIN ANALYZE SELECT ...;
-- Full details
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT ...;
```

**Key scan types (best → worst):**
- Index Only Scan → Index Scan → Bitmap Index Scan → Seq Scan

**Join types:** Nested Loop (small sets) → Hash Join (larger) → Merge Join (sorted data)

## Index Types & When to Use

| Type | Use For | Operators |
|------|---------|-----------|
| B-tree | Equality, range, ORDER BY | `=`, `<`, `>`, `BETWEEN` |
| Hash | Equality only | `=` |
| GIN | JSONB, arrays, full-text | `@>`, `?`, `@@` |
| GiST | Ranges, geometry | `&&`, `@>` (range overlap) |
| BRIN | Very large ordered tables | Correlation-based |

## Index Patterns

```sql
-- Composite (column order = leftmost prefix matching)
CREATE INDEX ON orders(user_id, status);

-- Partial (index subset of rows)
CREATE INDEX ON users(email) WHERE status = 'active';

-- Expression (computed keys)
CREATE INDEX ON users(LOWER(email));

-- Covering (index-only scans)
CREATE INDEX ON users(email) INCLUDE (name, created_at);
```

## Query Anti-Patterns → Fixes

| Anti-Pattern | Fix |
|-------------|-----|
| `SELECT *` | Select only needed columns |
| Function in WHERE (`LOWER(email)`) | Expression index or store normalized |
| `OFFSET 100000` | Cursor-based pagination |
| N+1 queries (loop of SELECTs) | JOIN or batch `IN (...)` |
| Correlated subquery | JOIN + GROUP BY or window function |
| `COUNT(*)` on huge table | `pg_class.reltuples` for estimates |
| `LIKE '%abc'` (leading wildcard) | `pg_trgm` GIN index or full-text search |
| Implicit type conversion | Match types exactly |

## Batch Operations

```sql
-- Multi-row INSERT (not individual)
INSERT INTO t (a, b) VALUES (1,'x'), (2,'y'), (3,'z');

-- COPY for bulk (fastest)
COPY t (a, b) FROM '/tmp/data.csv' CSV HEADER;

-- Batch UPDATE via temp table
CREATE TEMP TABLE updates (id INT, val TEXT);
INSERT INTO updates VALUES ...;
UPDATE t SET col = u.val FROM updates u WHERE t.id = u.id;
```

## Materialized Views

```sql
CREATE MATERIALIZED VIEW summary AS SELECT ...;
CREATE INDEX ON summary(key_col);
REFRESH MATERIALIZED VIEW CONCURRENTLY summary; -- needs unique index
```

## Monitoring Queries (PostgreSQL)

```sql
-- Slowest queries
SELECT query, calls, mean_time FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10;

-- Missing indexes (high seq scans)
SELECT tablename, seq_scan, idx_scan FROM pg_stat_user_tables WHERE seq_scan > 100 ORDER BY seq_scan DESC;

-- Unused indexes (waste)
SELECT indexname, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0;
```

## Maintenance
- `ANALYZE` after bulk changes (updates statistics)
- `VACUUM ANALYZE` regularly (reclaims dead tuples + stats)
- `REINDEX` if index bloat suspected
- Monitor `pg_stat_statements` for regression
