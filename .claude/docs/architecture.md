# Architecture — Claude Parity Layer

## System Diagram

```mermaid
graph TB
    subgraph "User Interface"
        CLI[Claude Code CLI]
        SLASH[Slash Commands<br/>ops-*, team-*, cost*]
    end

    subgraph "MCP Coordinator"
        COORD[index.js<br/>~105 MCP Tools]
    end

    subgraph "Core Runtime"
        TR[team_runtime.py<br/>Team Orchestration]
        CR[cost_runtime.py<br/>Cost Tracking]
    end

    subgraph "Phase F: Observability + Governance"
        OBS[observability.py<br/>Health, SLO, Timeline]
        POL[policy_engine.py<br/>Lint, Gates, Redact]
    end

    subgraph "Phase I: Collaboration + Automation"
        COL[collaboration.py<br/>Roles, Handoffs, Presence]
        AUTO[smart_automation.py<br/>Scale, Recover, Optimize]
    end

    subgraph "Phase G: Distribution"
        REL[release.py<br/>Bundle, Changelog]
        CS[claude-stack<br/>Bootstrap, Repair]
    end

    subgraph "Hooks"
        TG[token-guard.py]
        SH[self-heal.py]
        SW[session-watchdog.sh]
        REG[read-efficiency-guard.py]
    end

    subgraph "Data Layer"
        EVENTS[events.jsonl<br/>Append-only log]
        TASKS[tasks.json<br/>Task state]
        CONFIG[config.json<br/>Team config]
        COST[cost/*.json<br/>Budget + usage]
        MSGS[messages.jsonl<br/>Inbox]
        COMMENTS[comments.jsonl<br/>Annotations]
        SLO[slo-history.jsonl<br/>SLO metrics]
    end

    subgraph "Governance"
        TRUST[TRUST_TIERS.md]
        RUBRIC[parity-rubric.json]
        POLICIES[team-policies/*.json]
    end

    subgraph "Infrastructure"
        TMUX[tmux sessions<br/>Agent processes]
    end

    CLI --> COORD
    SLASH --> COORD
    COORD --> TR
    COORD --> CR
    COORD --> OBS
    COORD --> POL
    COORD --> COL
    COORD --> AUTO
    COORD --> REL

    TR --> TMUX
    TR --> EVENTS
    TR --> TASKS
    TR --> CONFIG
    TR --> MSGS

    CR --> COST

    OBS --> EVENTS
    OBS --> SLO
    OBS --> TR
    OBS --> CR

    POL --> TRUST
    POL --> RUBRIC
    POL --> POLICIES

    COL --> CONFIG
    COL --> EVENTS
    COL --> TASKS
    COL --> COMMENTS

    AUTO --> TR
    AUTO --> CR
    AUTO --> EVENTS
    AUTO --> TASKS
    AUTO --> COST

    TG -.->|PreToolUse| CLI
    SH -.->|PostToolUse| CLI
    SW -.->|PostToolUse| CLI
    REG -.->|PreToolUse| CLI
```

## Data Flow

```
User Request
  → Slash Command / MCP Tool Call
    → Coordinator (index.js)
      → Python Script (execFileSync)
        → Read/Write JSON/JSONL files
        → Execute subprocess (tmux, ccusage)
      → Return text/JSON result
    → Display to user
```

### Event Flow
```
Action → team_runtime.py appends to events.jsonl
  → observability.py reads events for:
      - Health report (aggregate counts)
      - Timeline (chronological view)
      - SLO metrics (latency, rates)
      - Audit trail (filtered by type)
  → smart_automation.py reads events for:
      - Auto-recover (failure/restart counts)
      - Auto-scale (queue depth)
      - Weekly optimize (7-day analysis)
```

### Hook Flow
```
PreToolUse:
  token-guard.py → enforces agent limits, token budgets
  read-efficiency-guard.py → prevents excessive sequential reads

PostToolUse:
  self-heal.py → auto-repairs config drift
  session-watchdog.sh → detects hung sessions
  agent-lifecycle.sh → tracks agent metrics
```

## File Layout

```
~/.claude/
├── scripts/
│   ├── team_runtime.py          # Core orchestration
│   ├── cost_runtime.py          # Cost tracking
│   ├── observability.py         # Health + SLO
│   ├── policy_engine.py         # Governance
│   ├── collaboration.py         # Multi-human
│   ├── smart_automation.py      # Automation
│   ├── release.py               # Distribution
│   └── claude-stack             # CLI wrapper
├── mcp-coordinator/
│   └── index.js                 # MCP tool gateway
├── hooks/
│   ├── token-guard.py           # Agent limits
│   ├── self-heal.py             # Auto-repair
│   └── ...
├── governance/
│   ├── TRUST_TIERS.md           # Trust policy
│   ├── parity-rubric.json       # Grading rubric
│   └── team-policies/           # Per-team policies
├── cost/
│   ├── budgets.json             # Budget limits
│   ├── config.json              # Cost config
│   └── cache.json               # Usage data
├── teams/{id}/
│   ├── config.json              # Team config
│   ├── tasks.json               # Task state
│   ├── events.jsonl             # Event log
│   ├── messages.jsonl           # Inbox
│   ├── comments.jsonl           # Annotations
│   └── handoffs/                # Handoff snapshots
├── reports/
│   ├── slo-history.jsonl        # SLO metrics
│   └── weekly-optimize-*.md     # Optimization reports
├── commands/
│   ├── ops-*.md                 # Ops slash commands
│   ├── team-*.md                # Team slash commands
│   └── cost*.md                 # Cost slash commands
├── docs/
│   ├── operator-manual.md       # This manual
│   ├── incident-runbooks.md     # Incident response
│   ├── architecture.md          # This diagram
│   ├── config-reference.md      # Config schemas
│   └── troubleshooting.md       # Symptom → fix
└── distribution/
    ├── manifest.json            # Bundle manifest
    └── compatibility.md         # Platform compat
```
