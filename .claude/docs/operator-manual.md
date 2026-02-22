# Operator Manual — Claude Parity Layer

## System Architecture

The parity layer consists of interconnected Python scripts exposed via an MCP coordinator:

| Script | Purpose | Lines |
|--------|---------|-------|
| `team_runtime.py` | Core team orchestration: boot, scale, tasks, messaging, recovery | ~3800 |
| `cost_runtime.py` | Cost tracking: summary, budget, export, statusline | ~750 |
| `observability.py` | Health reports, timelines, SLO metrics, audit trails | ~500 |
| `policy_engine.py` | Governance: lint, action gates, tool checks, redaction, signing | ~400 |
| `collaboration.py` | Multi-human: roles, handoffs, presence, comments, ownership | ~400 |
| `smart_automation.py` | Automation: auto-recommend, decompose, recover, scale, optimize | ~450 |
| `release.py` | Distribution: bundle, changelog, verify | ~250 |

**MCP Coordinator** (`mcp-coordinator/index.js`) wraps all scripts as ~105 MCP tools callable from any Claude session.

**Hooks** enforce policies automatically: token-guard, self-heal, session-watchdog, read-efficiency-guard, agent-lifecycle.

---

## Quick Start

```bash
# Full bootstrap (checks prereqs, installs, audits)
~/.claude/scripts/claude-stack bootstrap

# Or verify existing install
~/.claude/scripts/claude-stack status
```

Prerequisites: `python3 >= 3.10`, `node >= 18`, `tmux`, `jq`, `ccusage` (optional).

---

## Daily Operations

### Team Management

| Command | What it does |
|---------|-------------|
| `/team-boot` | Boot a standard team (coder + reviewer) |
| `/team-boot-heavy` | Boot heavy preset (coder + reviewer + tester + researcher) |
| `/team-boot-lite` | Boot lite preset (single haiku worker) |
| `/team-boot-auto` | Auto-select preset based on budget + task type |
| `/team-dashboard` | View team status, tasks, members |
| `/team-doctor` | Health check: member status, task integrity, config |
| `/team-scale` | Scale to a different preset |
| `/team-teardown` | Gracefully stop all members and archive |

### Cost Monitoring

| Command | What it does |
|---------|-------------|
| `/cost` | Today's cost summary |
| `/cost-team` | Per-team cost rollups |
| `/cost-budget` | Budget status and remaining |

### Observability

| Command | What it does |
|---------|-------------|
| `/ops-health-report` | Unified health dashboard |
| `/ops-slo` | SLO metrics: latency, recovery time, restart rate |
| `/ops-audit-trail` | Audit log of sensitive operations |

### Governance

| Command | What it does |
|---------|-------------|
| `/ops-policy-lint` | Validate all policy configs |
| `/ops-policy-check` | Check if an action is allowed |

### Collaboration

| Command | What it does |
|---------|-------------|
| `/ops-handoff` | Create/view operator handoff snapshots |
| `/ops-auto-scale` | Auto-scale evaluation by load + budget |
| `/ops-weekly-optimize` | Weekly optimization recommendations |

---

## Team Lifecycle

```
boot → configure → run tasks → monitor → scale → teardown/archive
```

1. **Boot**: `/team-boot` creates tmux sessions, spawns Claude agents, initializes task list
2. **Configure**: Set budgets (`cost/budgets.json`), policies (`governance/team-policies/`)
3. **Run**: Assign tasks, agents work autonomously, check inbox for messages
4. **Monitor**: `/team-dashboard`, `/ops-health-report`, `/ops-slo`
5. **Scale**: `/team-scale` or `/ops-auto-scale` adjusts member count by load
6. **Recovery**: `/team-doctor` → `/team-recover` → `/team-recover-hard` (escalating)
7. **Teardown**: `/team-teardown` or `/team-archive` for later resumption

---

## Multi-Operator Workflow

### Roles
- **Lead**: Full access — can scale, teardown, replace, set roles
- **Operator**: Task operations — can claim, update, add tasks, send messages
- **Viewer**: Read-only — dashboard, status, task list, inbox

### Shift Handoff
1. Outgoing operator: `/ops-handoff` → create (captures task counts, member states, events, cost)
2. Incoming operator: `/ops-handoff` → view latest (shows deltas: "what changed while you were away")

### Presence
Set your availability: `coord_collab_set_presence` with status `available|busy|away|offline`
See who's online: `coord_collab_who`

---

## Troubleshooting Quick Reference

| Symptom | Fix |
|---------|-----|
| Team won't boot | `which tmux` — install if missing |
| Cost data empty | `which ccusage` — install if missing |
| Session frozen | `/team-doctor` → `/team-recover-hard` |
| Budget exceeded | `/cost-budget` → adjust `cost/budgets.json` |
| Parity grade < A | `/ops-health-report` → `claude-stack repair` |

See `troubleshooting.md` for the full matrix.
