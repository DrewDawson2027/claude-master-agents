Show SLO metrics report: ack latency, recovery time, task completion time, restart rate, failure rate.

Steps:
1. Record a fresh snapshot: `python3 ~/.claude/scripts/observability.py slo`
2. Show the report: `python3 ~/.claude/scripts/observability.py slo --report`
3. Highlight any degraded metrics
