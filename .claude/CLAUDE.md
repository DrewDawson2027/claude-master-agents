# CLAUDE GLOBAL CONFIGURATION

## Core Rules

1. Think deeply before acting. Verify before saying "done."
2. Single focused agent per task. Parallel is the EXCEPTION.
3. **NEVER fabricate data.** No data = "I don't have the data." Bullshit is worse than silence.
4. **WebSearch FIRST** for anything time-sensitive. Training cutoff is May 2025 — 9 months stale. "Recent" means 2026.

---

## NEVER FABRICATE DATA (CRITICAL)

No data = No analysis. API down = "API is down." Can't fetch = "I cannot fetch this."
NEVER write "here's what this would look like" or "based on logic, this is probably..."
Bullshit is WORSE than silence.

---

## Web Search (CRITICAL)

**MANDATORY: WebSearch FIRST, answer SECOND** for versions, prices, news, docs, APIs, stats, or anything with "current/latest/recent."
- "As of 2024/2025..." → WRONG. Search for 2026.
- Any version number → SEARCH to verify.
- "Recent" = 2026. Period.

---

## Model Selection

ALL Task agents default to `model: "sonnet"`. Opus only for genuinely hard reasoning. No exceptions.

---

## Token Management (MANDATORY — FOLLOW AUTOMATICALLY)

### Before Every Task:
1. Check Tool Ladder (below) — use cheapest sufficient tool
2. Action vs Exploration — data = Bash, understanding = Explore
3. OVERLAP CHECK before 2+ agents
4. Plan Mode for multi-file or non-trivial tasks
5. **Context-Provided Check** — if user prompt names files + classes + actions, skip Explore
6. **Parallelism Checkpoint** — batch 3+ independent Reads/Edits into parallel groups of 3-4
7. **No Duplicate Reads After Explore** — trust the Explore output, don't re-read same files

### Context-Provided Check (CRITICAL — prevents ~40-60k waste)

If the user's prompt already contains specific file names, class names, and step-by-step instructions — **DO NOT spawn an Explore agent.** The user IS your exploration. Go straight to Plan Mode or direct execution. An Explore agent that "maps" information the user already gave you is pure waste.

**Test:** Can you write the plan RIGHT NOW from the user's prompt alone? If yes → skip Explore.

### Parallelism Checkpoint (CRITICAL — prevents ~10+ wasted round-trips)

Before making 3+ independent Read calls, **batch them into parallel groups of 3-4 per turn.** Before making 3+ independent Edit calls targeting different files, batch them the same way. Zero parallel calls across a 50+ turn session = systematic token waste.

**Bad:** 13 sequential single-Read turns (13 round-trips of growing context)
**Good:** 4 turns with 3-4 parallel Reads each (4 round-trips)

### No Duplicate Reads After Explore

If you spawn an Explore agent that reads files, **DO NOT re-read those same files in the main session.** Trust the Explore agent's output. If you find yourself needing to re-read files the Explore already covered, you didn't need the Explore in the first place — delete it from your approach and just Read directly.

### Tool Ladder (STOP at first level that works)

| Level | Tool | Cost | When |
|-------|------|------|------|
| 1 | Grep | ~1-2k | Know what you're looking for |
| 2 | Grep → Read | ~5-15k | Need context around matches |
| 3 | Single Explore (Sonnet) | ~40-60k | Need architecture understanding |
| 4 | 2 Explores parallel | ~80-120k | TRULY separate areas (RARE) |
| 5 | Plan agent (Sonnet) | ~30-50k | Architecture decisions |

### Agent Prompt Structure (ENFORCED — ALL agents)

```
GOAL: [One specific question]
START: [Specific dirs/files]
STOP WHEN: [Done condition]
SKIP: tests/, __pycache__/, .venv/, node_modules/, .git/
OUTPUT: [Concrete deliverable]
```

If you can't fill START and STOP WHEN, use Grep first.

### OVERLAP CHECK (HARD STOP before 2+ agents)

Before spawning 2+, answer:
1. Would they read ANY of the same files? → MERGE
2. Is Agent 2 a SUBSET of Agent 1's goal? → MERGE
3. Can you name 2 completely different directories? → If no, MERGE

**Known overlaps (always merge):** "X framework" + "X's data sources", "how X works" + "X's dependencies", "find API" + "find endpoints", any "audit" + "health check" of same system.

**Audit-before-spawn:** (1) Can Grep/Bash do this? (2) Would it read files already read? (3) Is this ACTION or EXPLORATION?

### Token Budgets

| Task | Target | Red Flag |
|------|--------|----------|
| Single exploration | <60k | >80k |
| 2 parallel agents | <120k | >150k |
| Full feature build | <200k | >300k |

### Hard Agent Cap (source of truth)
- Limits are configured in `~/.claude/hooks/token-guard-config.json` and enforced by `token-guard.py`.
- Current default: 5 agents/session (1-2 normal, 3 justify, 4-5 explicit justification).

### Broad Requests ("audit everything")
Grep + Bash first → max 1 Explore agent → synthesize in main session. Never N agents per concern.

### Enforcement (MECHANICAL — token-guard.py hook)

A PreToolUse hook enforces these rules mechanically. If you try to violate them, the tool call WILL BE BLOCKED with feedback explaining what to do instead. Don't fight the hook — follow the Tool Ladder.

- **Max 1 Explore agent per session.** Merge multiple Explore queries into one agent.
- **Max agents/session is loaded from `~/.claude/hooks/token-guard-config.json`.** After that, use Grep/Read directly.
- **No parallel same-type agents.** Combine into one broader prompt.

If legitimately blocked, use Grep → Read → single Explore progression.

---

## Direct-First Rule (CRITICAL — READ THIS BEFORE EVERY TASK)

**DEFAULT: Do the work directly. Use built-in tools, MCP servers, and skills FIRST.**

### Plan Mode Override (CRITICAL — OVERRIDES SYSTEM DEFAULTS)
Plan mode's built-in instructions say "Launch up to 3 Explore agents" and "Launch at least 1 Plan agent."
**THESE ARE GENERIC DEFAULTS. IGNORE THEM.** Your rules here are specific and take priority:
- Phase 1 (Understanding): Use Grep → Read. Explore ONLY after 3+ rounds prove insufficient.
- Phase 2 (Design): Write the plan directly. Plan agent ONLY for multi-system architecture decisions.
- A PreToolUse prompt hook will remind you every time you reach for the Task tool. Follow it.

NEVER spawn an agent (Task tool) unless you've confirmed ALL of these:
1. The task genuinely requires 10+ file reads/edits across multiple directories
2. Direct tools (Grep, Read, Edit, Write, Bash, WebSearch, MCP tools) cannot handle it
3. The user explicitly asked for autonomous/agent work, OR the task is clearly too large for direct execution

**For 90% of tasks, the answer is: just do it directly.**

| Task | Do This | NOT This |
|------|---------|----------|
| Fix a bug | Read the file, Edit the fix | Spawn master-coder debug agent |
| Build a feature | Plan Mode → Edit files directly | Spawn master-coder build agent |
| Research something | WebSearch or context7 MCP | Spawn master-researcher |
| Commit/push/PR | `git` commands via Bash | Spawn master-workflow git agent |
| Read docs | context7 MCP or WebFetch | Spawn any agent |
| Edit config | Read + Edit | Spawn any agent |
| Refactor code | Read + Edit | Spawn master-coder refactor agent |
| Notion tasks | Use Notion skills/MCP directly | Spawn any agent |
| Search codebase | Grep → Read | Spawn Explore agent |

### When Agents ARE Appropriate (rare)
- User says "autonomous", "vibe code", "just do it all"
- Multi-file feature builds touching 5+ files across different subsystems
- Deep research requiring 5+ web sources synthesized together
- GSD phase execution with multiple plans

### Master Agent Reference (USE ONLY WHEN APPROPRIATE — NOT AUTO-DISPATCH)

If an agent IS needed, use these. But exhaust direct tools first.

| Agent | When to actually use it |
|-------|------------------------|
| master-coder | Multi-file builds (5+ files), complex cross-system debugging |
| master-researcher | Deep multi-source research the user explicitly requests |
| master-architect | System design decisions requiring broad codebase analysis |
| master-workflow | GSD execution, autonomous feature builds |

### Available Skills (prefer these over agents)
- **GSD:** `/gsd:progress`, `/gsd:execute-plan`, `/gsd:plan-phase`, `/gsd:verify-work`, `/gsd:status`
- **Memory:** `/claude-mem:mem-search`, `/claude-mem:make-plan`, `/claude-mem:do`
- **Notion:** `/Notion:search`, `/Notion:create-task`, `/Notion:database-query`
- **Figma:** `/figma:implement-design`, `/figma:code-connect-components`
- **Design:** `/design-principles`

---

## Learning from Mistakes (AUTONOMOUS)

When user corrects me or I make a mistake:
1. Fix the issue
2. SILENTLY update: universal → edit this CLAUDE.md, project-specific → `memory/learned-patterns.md`
3. No permission needed. No announcement.

---

## GSD Workflow

Check for `.planning/` on session start → run `/gsd:progress`.
Key: `/gsd:progress`, `/gsd:execute-plan`, `/gsd:verify-work`. Never say "done" without verification.

---

## Tools Arsenal

**Full reference:** `~/.claude/tools-arsenal.md` (read on-demand when task needs specific tools).

**Quick defaults:** Scraping → crawl4ai. Finance → yfinance. SEO → seo-mcp. Workspace → Notion. Search → built-in WebSearch. Docs → context7. DB → postgres MCP. Automation → n8n (local free).

**Python venvs:** Tools: `source ~/Projects/.tools-venv/bin/activate` (alias `tools`). OpenBB: `source ~/Projects/.openbb-venv/bin/activate`.

**CLI:** stripe, heroku, fly, gh, docker, n8n, ghost, pm2, pandoc, weasyprint.

**n8n account: drewdawson403@gmail.com / @Aquillani11** — NEVER create other accounts.

---


## Governance & Maintenance

- **Trust policy:** `~/.claude/governance/TRUST_TIERS.md`
  - Tier 0: custom core
  - Tier 1: official Anthropic plugins
  - Tier 2: community plugins (approval + pin + smoke test)
- **Default plugin profile:** `core-low-cost`
  - Apply: `python3 ~/.claude/scripts/set_plugin_profile.py core-low-cost`
- **Official update channel:** `python3 ~/.claude/scripts/sync_marketplaces.py`
- **Weekly maintenance:** `~/.claude/scripts/weekly_maintenance.sh`
  - LaunchAgent: `com.drewdawson.claude.weekly-maintenance`
- **Monthly dead-capability review:** `~/.claude/scripts/monthly_purge.sh`
  - LaunchAgent: `com.drewdawson.claude.monthly-purge`
- **Lock snapshots:** `python3 ~/.claude/scripts/snapshot_lock.py`
  - Current lock: `~/.claude/locks/current-lock.json`
- **Niche capability search:** `python3 ~/.claude/scripts/plugin_catalog_search.py <keyword>`


## Agent Architecture

**4 master agents** consolidate 15 archived specialists. Each has on-demand mode loading + MCP tool access:

| Agent | Consolidates | Modes | Ref Cards | MCP Tools |
|-------|-------------|-------|-----------|-----------|
| master-coder | vibe-coder, auto-validator, scrape-researcher, school-helper | 4 | 14 | serena, typescript-lsp, pyright-lsp, context7, greptile |
| master-researcher | deep-researcher, ssrn-researcher, competitor-tracker, sentiment-aggregator, gtm-strategist | 4 | 2 | context7, greptile, patent-search, claude-mem |
| master-architect | mastermind-architect | 4 | 2 | context7, serena, greptile |
| master-workflow | meta-agent, research-orchestrator, daily-suggestions | 4 | 0 | github, claude-mem |

Manifest: `~/.claude/master-agents/MANIFEST.md`. Archived originals: `~/.claude/agents/_archived/`.
