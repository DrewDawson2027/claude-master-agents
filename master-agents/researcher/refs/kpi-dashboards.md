# KPI Dashboards

## Goal
Design dashboards that drive decisions, not vanity reporting.

## KPI Selection
- Define one **north-star metric** tied to user value.
- Add supporting KPIs across acquisition, activation, retention, and reliability.
- Include at least one quality guardrail (for example error rate, churn, refund rate).

## Dashboard Standards
- Every chart must answer a decision question.
- Show trend + target + variance.
- Include timeframe, data freshness, and source.
- Use consistent metric definitions across teams.
- Prefer rates and cohorts over raw totals when comparing periods.

## Anti-Patterns
- Too many top-level KPIs (more than 7).
- Mixing lagging and leading indicators without labeling.
- No ownership for each KPI.
- No threshold for action.

## Output Pattern
- **North Star**: metric, owner, target.
- **Core KPI Table**: metric, definition, source, cadence, threshold.
- **Alert Rules**: trigger, escalation path, response SLA.
