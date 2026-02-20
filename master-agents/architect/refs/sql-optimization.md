# SQL Optimization

## Goal
Improve query latency and stability without sacrificing correctness.

## Triage Flow
1. Capture slow query examples with execution time and frequency.
2. Run `EXPLAIN` / `EXPLAIN ANALYZE` and identify full scans, bad joins, sort spills.
3. Fix highest-impact query first (time x frequency x business criticality).

## High-Impact Tactics
- Add/selective indexes for filter + join columns.
- Convert N+1 patterns into set-based queries.
- Limit selected columns (avoid `SELECT *` on hot paths).
- Push pagination and filtering into SQL.
- Pre-aggregate expensive repeated reads where freshness allows.

## Index Guidelines
- Composite indexes should follow common predicate order.
- Avoid redundant indexes with overlapping prefixes.
- Re-check write overhead after adding indexes.

## Validation Checklist
- Compare before/after p50/p95 latency.
- Confirm query plan changed as intended.
- Verify row counts and result parity.
- Confirm no regression in write-heavy operations.
