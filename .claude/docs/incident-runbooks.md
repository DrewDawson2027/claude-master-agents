# Incident Runbooks

## 1. Frozen Session

**Trigger**: Agent stops responding, no heartbeat for 5+ minutes.

**Detection**:
- `/team-doctor` shows member with stale heartbeat
- `/ops-slo` shows elevated ack latency
- Session watchdog hook fires automatically

**Steps**:
1. Check member status: `/team-dashboard`
2. Attempt soft recovery: `/team-recover` — sends SIGINT, waits for response
3. If still frozen: `/team-recover-hard` — kills process, restarts from checkpoint
4. If repeated: `/team-restart-member` with specific member ID
5. Check for hung MCP calls: look for stale connections in events log

**Escalation**: If 3+ recoveries in 1 hour, investigate root cause (MCP timeout, resource exhaustion, hook loop).

**Prevention**: Session watchdog hook auto-detects after 5 min inactivity. Ensure `session-watchdog.sh` is enabled in settings.

---

## 2. Budget Exceeded

**Trigger**: Daily cost reaches or exceeds budget limit.

**Detection**:
- `/cost-budget` shows > 100% utilization
- Token guard hook blocks new agent spawns
- `/ops-auto-scale` recommends scale-down

**Steps**:
1. Check current spend: `/cost` and `/cost-team`
2. Identify top spenders: look at per-session costs
3. Scale down: `/team-scale` to lite preset
4. Pause non-critical work: `/team-selftest` to verify essentials only
5. If urgent work needed: increase budget in `~/.claude/cost/budgets.json`

**Escalation**: If budget exceeded 3+ days running, review preset selection and task complexity.

**Prevention**: Set conservative budgets. Use `/ops-auto-scale` to auto-adjust. Use haiku for routine tasks.

---

## 3. Member Crash Loop

**Trigger**: Same member restarts > 3 times per hour.

**Detection**:
- `/ops-slo` shows restart_rate_24h > 5
- Events log shows repeated `MemberRestarted` events
- `/team-doctor` flags instability

**Steps**:
1. Identify the crashing member: check events for restart patterns
2. Pause the member: remove from task rotation
3. Check for root cause:
   - Bad task causing repeated failure? Check task content
   - MCP server issue? Check MCP readiness
   - Resource exhaustion? Check system resources
4. Replace the member: `/team-replace-member` with fresh agent
5. Resume tasks: reassign the member's tasks

**Escalation**: If crash loop persists after replacement, the issue is in the task or environment, not the member.

**Prevention**: Enable auto-recover: `smart_automation.py auto-recover` detects and handles this automatically.

---

## 4. tmux Session Lost

**Trigger**: tmux session disappears (system restart, terminal crash).

**Detection**:
- `/team-dashboard` can't connect to sessions
- `tmux ls` shows missing sessions
- `/team-doctor` reports session health failures

**Steps**:
1. List surviving sessions: `tmux ls`
2. Attempt auto-heal: `/team-auto-heal` — detects and respawns missing sessions
3. If auto-heal fails: `/team-recover-hard` — full team restart
4. If archive exists: `/team-recover` from last checkpoint
5. Verify task state preserved: `/ops-team-tasks`

**Escalation**: If tmux repeatedly crashes, check system stability and tmux version.

**Prevention**: The auto-heal hook runs periodically. Ensure system has stable tmux installation.

---

## 5. Parity Regression

**Trigger**: Parity audit shows grade < A in any category.

**Detection**:
- `/ops-health-report` shows parity issues
- `python3 ~/.claude/scripts/parity_audit.py` shows missing tools/files
- Post-install or post-update

**Steps**:
1. Run parity audit: `python3 ~/.claude/scripts/parity_audit.py`
2. Identify missing items: check the `missing` arrays per category
3. Run repair: `~/.claude/scripts/claude-stack repair`
4. If repair can't fix: manually check for deleted/renamed files
5. Re-run audit to confirm grade A

**Escalation**: If repair fails, check if a recent update removed required components.

**Prevention**: Run `claude-stack status` after any system update.

---

## 6. Cost Spike

**Trigger**: Unusual cost increase (> 2x normal daily spend).

**Detection**:
- `/cost` shows abnormal total
- Budget alerts fire
- `/ops-auto-scale` triggers scale-down

**Steps**:
1. Identify the spike: `/cost-team` for per-team breakdown
2. Check for runaway agents: agents in tight loops, excessive tool calls
3. Throttle: scale to lite preset immediately
4. Investigate: check event log for anomalous patterns
5. Address root cause: fix task, adjust budget, or update token guard limits

**Escalation**: If cost spike from a specific MCP server, check for API cost amplification.

**Prevention**: Token guard hook limits agent spawns. Budget enforcement stops runaway costs. Use `/ops-weekly-optimize` to identify waste patterns.

---

## General Incident Template

```
TRIGGER:    What triggers this incident
DETECTION:  How to detect it (commands, metrics, alerts)
STEPS:      Ordered remediation actions
ESCALATION: When and how to escalate
PREVENTION: How to prevent recurrence
```
