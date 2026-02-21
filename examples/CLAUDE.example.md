# CLAUDE GLOBAL CONFIGURATION

## Core Rules

1. Think deeply before acting. Verify before saying "done."
2. Single focused agent per task. Parallel is the EXCEPTION.
3. **NEVER fabricate data.** No data = "I don't have the data."
4. **WebSearch FIRST** for anything time-sensitive. Training cutoff may be months stale.

---

## Web Search (CRITICAL)

**MANDATORY: WebSearch FIRST, answer SECOND** for versions, prices, news, docs, APIs, stats, or anything with "current/latest/recent."
- Any version number → SEARCH to verify.
- Always use the current year in searches.

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

### Hard Agent Cap: 5/session
- 1-2: Normal. 3: Justify to user. 4-5: Explicit justification. 6+: PROHIBITED.

### Broad Requests ("audit everything")
Grep + Bash first → max 1 Explore agent → synthesize in main session. Never N agents per concern.

### Enforcement (MECHANICAL — token-guard.py hook)

A PreToolUse hook enforces these rules mechanically. If you try to violate them, the tool call WILL BE BLOCKED with feedback explaining what to do instead. Don't fight the hook — follow the Tool Ladder.

- **Max 1 Explore agent per session.** Merge multiple Explore queries into one agent.
- **Max 5 agents per session.** After that, use Grep/Read directly.
- **No parallel same-type agents.** Combine into one broader prompt.

If legitimately blocked, use Grep → Read → single Explore progression.

---

## Master Agent Dispatch (AUTOMATIC — 4 agents cover everything)

All specialist skills are embedded into 4 master agents. Claude auto-detects task type and spawns the right one via Task tool (subagent_type: general-purpose).

| Task | Agent | Mode | Est. Cost |
|------|-------|------|-----------|
| Code review / audit / PR | master-coder | review | 25-60k |
| Build / implement / feature | master-coder | build | 40-80k |
| Debug / fix / error | master-coder | debug | 15-40k |
| Simplify / refactor | master-coder | refactor | 10-25k |
| Academic / paper research | master-researcher | academic | 20-40k |
| Market / competitor intel | master-researcher | market | 25-50k |
| Technical docs / how-to | master-researcher | technical | 15-35k |
| General research | master-researcher | general | 10-30k |
| Database / schema design | master-architect | database | 20-40k |
| API / microservices design | master-architect | api | 15-35k |
| System architecture / ADR | master-architect | system | 25-50k |
| Dashboard / frontend arch | master-architect | frontend | 15-30k |
| GSD plan execution | master-workflow | gsd-exec | 50-200k |
| New feature (spec-driven) | master-workflow | feature | 40-150k |
| Commit / push / PR | master-workflow | git | 5-10k |
| Autonomous build loop | master-workflow | autonomous | 50-200k |

### Code Review Sub-Rules (handled by master-coder review mode)

**Dispatch when:** new architecture, cross-system integration, security-adjacent, error handling refactor, complex business logic, pre-PR/ship.

**Handle myself:** pattern-following code, CRUD, config, deps, formatting, simple features.

**THE TEST:** "If this code has a bug, what breaks?" → "one endpoint" = self-review. "Data corruption/security/cascade" = dispatch master-coder review mode.

Run in background, Sonnet, max 2 per change. Summarize HIGH-priority only.

---

## Autonomous Tool Recommendation (AFTER EVERY PLANNING STEP)

**After outlining next steps for ANY task, ALWAYS append a recommendation block:**

> **Recommended:** [tool/agent/skill] — [1-2 sentence justification with token cost estimate]
> **Alternatives:** [what else could work and why recommendation is better]

**NEVER recommend without cost context. Always mention estimated token cost.**

---

## Auto-Trigger Rules (Master Agent Dispatch)

When the user asks you to do something, CHECK these triggers BEFORE responding. If a trigger matches, spawn the master agent as a Task tool subagent (subagent_type: general-purpose, model: sonnet).

### Dispatch Priority (Deterministic Tie-Breaking)

When multiple agents could match, use this priority order:

1. **Exact command match** (e.g., `/gsd:*`) → master-workflow
2. **Explicit skill keyword** (e.g., "review", "research", "design") → matching master agent
3. **Project context** (`.planning/` exists) → master-workflow
4. **Implicit action** (e.g., "build", "fix") → master-coder (default for coding tasks)
5. **Ambiguous request** → Ask user which approach they prefer

**Tie-breaker examples:**
- "Review the database design" → master-coder (review beats database; explicit > implicit)
- "Fix the API schema" → master-coder (fix > API; explicit coding action)
- "Design and implement an API" → Ask user: "Focus on design first (master-architect) or jump to implementation (master-coder)?"

### Agent Triggers

- **master-coder**: "build/create/implement/add/feature" (build), "fix/broken/error/debug/failing/bug" (debug), "review/check/audit/PR" (review), "simplify/refactor/clean" (refactor). After writing significant code → auto-review in background.
- **master-researcher**: "research/find out/what is/how does X work" (auto-detect domain), "competitor/market/landscape" (market), "paper/study/academic/SSRN" (academic), "docs/documentation/how to use" (technical).
- **master-architect**: "design/architect/schema/data model" (auto-detect type), "database/table/migration/SQL" (database), "API/endpoint/REST/GraphQL" (api), "system design/infrastructure/scale" (system).
- **master-workflow**: "/gsd:" or ".planning/" (gsd-exec), "commit/push/PR" (git), "new feature" with spec-driven intent (feature), "autonomous/vibe code/just do it" (autonomous).

**Still direct (no agent needed):**
- Simple single-file edits → Direct coding
- Important decisions → Store in memory

### Dispatch Reporting (MANDATORY)

When spawning a master agent, ALWAYS report using this format:

```
🎯 Dispatching: master-[agent] ([mode])
Why: [One-sentence rationale]
Est. cost: [token range from table above]
Model: sonnet

[Agent output follows below]
---
```

**Example:**
```
🎯 Dispatching: master-coder (review)
Why: Code review requested for authentication implementation
Est. cost: 25-60k tokens
Model: sonnet

[Agent performs review...]
---
```

---

## GSD Workflow

Check for `.planning/` on session start → run `/gsd:progress`.
Key: `/gsd:progress`, `/gsd:execute-plan`, `/gsd:verify-work`. Never say "done" without verification.

---

## Learning from Mistakes (OPT-IN ONLY)

**DISABLED BY DEFAULT.** Self-modification is OFF unless explicitly enabled.

### To Enable Learning Mode

Add this section to your `~/.claude/CLAUDE.md`:

```markdown
## Learning Mode: ENABLED

When I correct you or you make a mistake:
1. Fix the issue
2. SILENTLY update: universal → edit CLAUDE.md, project-specific → `memory/learned-patterns.md`
3. No permission needed. No announcement.
```

### Default Behavior (Learning DISABLED)

When user corrects you or you make a mistake:
1. Fix the issue immediately
2. **STOP.** Do not modify CLAUDE.md or any configuration files
3. Ask user: "Should I remember this pattern? I can update my configuration if you'd like."

**Why opt-in?** Self-modifying configuration can lead to drift from documented behavior and make debugging harder. Explicit opt-in gives users control over when and how the system learns.
