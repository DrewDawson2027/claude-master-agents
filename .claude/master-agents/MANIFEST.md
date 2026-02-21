# Master Agent System — Manifest

Registry of all modes, reference cards, keywords, and purposes. Source of truth for the master agent architecture.

---

## Agents

| Agent | Base Prompt | Tools | Default Mode |
|-------|-------------|-------|-------------|
| master-coder | `~/.claude/agents/master-coder.md` | Read, Write, Edit, Bash, Grep, Glob, ToolSearch | build-mode |
| master-researcher | `~/.claude/agents/master-researcher.md` | WebSearch, WebFetch, Read, Write, ToolSearch | general-mode |
| master-architect | `~/.claude/agents/master-architect.md` | Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, ToolSearch | system-design |
| master-workflow | `~/.claude/agents/master-workflow.md` | Read, Write, Edit, Bash, Grep, Glob, Task, AskUserQuestion, ToolSearch | feature-workflow |

---

## Mode Files

### master-coder modes (`~/.claude/master-agents/coder/`)

| Mode | File | Keywords | Lines | Purpose |
|------|------|----------|-------|---------|
| Build | `build-mode.md` | build, create, implement, add, feature | 98 | End-to-end feature development |
| Debug | `debug-mode.md` | fix, broken, error, debug, failing, bug | 113 | Systematic root cause analysis |
| Review | `review-mode.md` | review, check, audit, PR, code quality | 131 | Code review + security audit |
| Refactor | `refactor-mode.md` | simplify, refactor, clean up, reduce | 79 | Code simplification |
| Atlas | `atlas-mode.md` | atlas, Atlas, atlas-betting | 91 | Atlas platform domain knowledge |

### master-researcher modes (`~/.claude/master-agents/researcher/`)

| Mode | File | Keywords | Lines | Purpose |
|------|------|----------|-------|---------|
| Academic | `academic-mode.md` | paper, study, academic, SSRN, journal | 111 | Academic/scientific research |
| Market | `market-mode.md` | competitor, market, landscape, GTM, pricing | 149 | Market/competitor intelligence |
| Technical | `technical-mode.md` | docs, documentation, library, framework, API | 95 | Technical documentation research |
| General | `general-mode.md` | research, find out, what is, how does | 96 | Multi-source general research |

### master-architect modes (`~/.claude/master-agents/architect/`)

| Mode | File | Keywords | Lines | Purpose |
|------|------|----------|-------|---------|
| Database | `database-design.md` | database, schema, table, migration, SQL | 147 | Database/data model design |
| API | `api-design.md` | API, endpoint, REST, GraphQL, gRPC | 182 | API architecture design |
| System | `system-design.md` | system design, infrastructure, architecture | 178 | System architecture design |
| Frontend | `frontend-design.md` | frontend, dashboard, UI architecture | 139 | Frontend architecture design |

### master-workflow modes (`~/.claude/master-agents/workflow/`)

| Mode | File | Keywords | Lines | Purpose |
|------|------|----------|-------|---------|
| GSD | `gsd-exec.md` | /gsd:, .planning/, execute plan, progress | 183 | GSD framework execution |
| Feature | `feature-workflow.md` | new feature, spec-driven, requirements | 144 | Spec-driven feature development |
| Git | `git-workflow.md` | commit, push, PR, pull request, git branch | 148 | Git operations workflow |
| Autonomous | `autonomous.md` | autonomous, ralph loop, vibe code | 119 | Autonomous execution loops |

---

## Reference Cards

### master-coder refs (`~/.claude/master-agents/coder/refs/`)

| Ref Card | File | Keywords | Lines |
|----------|------|----------|-------|
| Auth Patterns | `auth-patterns.md` | auth, OAuth, JWT, login, session | 34 |
| TypeScript Types | `typescript-types.md` | TypeScript types, generics | 46 |
| Testing Python | `testing-py.md` | pytest, testing Python | 69 |
| Testing JS | `testing-js.md` | Jest, Vitest, testing JS/TS | 62 |
| Design Principles | `design-principles.md` | UI, dashboard, design system, Tailwind | 170 |
| Async Python | `async-python.md` | async, await, asyncio | 53 |
| E2E Testing | `e2e-testing.md` | E2E, Playwright, Cypress | 46 |
| Python Frameworks | `python-frameworks.md` | FastAPI, Django, Flask | 46 |
| Error Handling | `error-handling.md` | error handling, try/catch | 53 |
| Modern JS | `modern-js.md` | ES6, modern JS, promises | 58 |
| Node.js Backend | `nodejs-backend.md` | Node.js, Express, Fastify | 52 |
| Monorepo | `monorepo.md` | monorepo, Turborepo, Nx | 46 |
| Git Advanced | `git-advanced.md` | rebase, cherry-pick, bisect | 51 |
| Python Tooling | `python-tooling.md` | packaging, PyPI, uv, pip | 57 |

### master-researcher refs (`~/.claude/master-agents/researcher/refs/`)

| Ref Card | File | Keywords | Lines |
|----------|------|----------|-------|
| Data Storytelling | `data-storytelling.md` | present, stakeholder, narrative | 39 |
| KPI Dashboards | `kpi-dashboards.md` | KPI, metrics, OKR | 44 |

### master-architect refs (`~/.claude/master-agents/architect/refs/`)

| Ref Card | File | Keywords | Lines |
|----------|------|----------|-------|
| SQL Optimization | `sql-optimization.md` | query optimization, EXPLAIN | 98 |
| Design Principles | `design-principles.md` | UI, dashboard, design system | 170 |

---

## MCP Tool Integrations

| Agent | MCP Tools Available | Via |
|-------|-------------------|-----|
| master-coder | serena (semantic code), typescript-lsp, pyright-lsp, context7 (docs), greptile | ToolSearch |
| master-researcher | context7 (docs), greptile (code search), patent-search, claude-mem | ToolSearch |
| master-architect | context7 (docs), serena (code analysis), greptile | ToolSearch |
| master-workflow | gh CLI (PRs, issues via Bash), claude-mem (persistent memory) | Bash + ToolSearch |

---

## Lifecycle Hooks

| Hook Event | Script | Purpose |
|-----------|--------|---------|
| SubagentStart | `agent-lifecycle.sh` | Logs agent spawn timestamp for duration tracking |
| SubagentStop | `agent-lifecycle.sh` | Logs agent completion with duration calculation |
| PreCompact | `pre-compact-save.sh` | Saves session state before context compaction |
| PreToolUse (Task) | `token-guard.py` | Enforces agent caps, necessity scoring, cooldowns |
| PreToolUse (Read) | `read-efficiency-guard.py` | Blocks duplicate/sequential reads |
| SessionStart | `session-register.sh` | Registers session, bootstraps cache |
| SessionStart | `self-heal.py` | Validates 60+ checks, auto-repairs config |

Metrics log: `~/.claude/hooks/session-state/agent-metrics.jsonl`
Compaction log: `~/.claude/session-cache/compaction-log.jsonl`

---

## Prompt Caching Architecture

Agent system prompts are the stable prefix cached by Claude Code's internal prompt caching. Mode files load via the Read tool (tool results, not system prompt), so they never break the cache prefix. This is optimal:

- System prompt (~65-80 lines) = **cached** across invocations
- Mode file (~100-140 lines) = loaded via Read, **not** in cache prefix
- Reference cards = loaded via Read on demand, **not** in cache prefix
- Total re-tokenized per spawn: only the mode file (~130 lines avg)

---

## How to Extend

### Adding a new mode
1. Create `~/.claude/master-agents/{agent}/{mode-name}.md`
2. Add keyword row to the agent's Mode Detection table in `~/.claude/agents/master-{agent}.md`
3. Update this MANIFEST.md
4. Run self-heal to validate: `python3 ~/.claude/hooks/self-heal.py`

### Adding a new reference card
1. Create `~/.claude/master-agents/{agent}/refs/{card-name}.md`
2. Add keyword row to the agent's Reference Card Detection table
3. Update this MANIFEST.md

### Adding MCP tool support
1. Add `ToolSearch` to the agent's `tools:` frontmatter (if not already there)
2. Add a row to the agent's MCP Tools table with the tool name and ToolSearch query
3. Update this MANIFEST.md
