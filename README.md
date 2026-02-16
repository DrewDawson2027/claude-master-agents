# Claude Master Agents

**Claude Code is powerful but unstructured. It treats every task the same — no project management, no specialized expertise, no memory of what approach works best for what kind of work.**

This framework fixes that with two things:

1. **4 master agents** that auto-detect what you're doing and load specialized instructions (coding, research, architecture, workflow)
2. **GSD (Get Shit Done)** — a 27-command project management system built for solo agentic development. No Jira. No tickets. Just phases, plans, and execution.

## GSD: Project Management for AI-Assisted Development

Nothing like this exists for Claude Code. GSD gives you structured project lifecycle management — from initial brief through phased execution to verification.

```
/gsd:new-project              # Interactive project setup → creates .planning/
/gsd:plan-phase 1             # Claude creates detailed execution plan
/gsd:execute-plan PLAN.md     # Claude executes the plan step by step
/gsd:progress                 # Progress bar, next steps, routing
/gsd:verify-work              # Guided acceptance testing
```

### What GSD Creates

```
your-project/
└── .planning/
    ├── PROJECT.md             # Brief, config, constraints
    ├── ROADMAP.md             # Milestone → phase breakdown
    ├── phases/
    │   ├── 01-foundation/
    │   │   ├── 01-01-PLAN.md  # Detailed execution plan
    │   │   └── 01-02-PLAN.md
    │   └── 02-features/
    │       └── 02-01-PLAN.md
    ├── todos/                 # Captured ideas and tasks
    └── issues/                # Deferred problems
```

### 27 Commands

**6 core** — the daily workflow:

| Command | What It Does |
|---------|-------------|
| `/gsd:new-project` | Initialize project with brief, config, `.planning/` structure |
| `/gsd:plan-phase` | Create detailed execution plan for a phase |
| `/gsd:execute-plan` | Execute a PLAN.md with sequential task completion |
| `/gsd:progress` | Check status, show progress, route to next action |
| `/gsd:verify-work` | Guide manual acceptance testing |
| `/gsd:help` | Full command reference |

**21 advanced** — roadmap management, debugging, context switching:

| Category | Commands |
|----------|---------|
| Roadmap | `create-roadmap`, `add-phase`, `remove-phase`, `insert-phase` |
| Milestones | `discuss-milestone`, `new-milestone`, `complete-milestone` |
| Phase work | `discuss-phase`, `research-phase`, `execute-phase`, `list-phase-assumptions` |
| Task management | `add-todo`, `check-todos`, `consider-issues` |
| Context | `pause-work`, `resume-work`, `resume-task`, `status` |
| Debugging | `debug`, `plan-fix` |
| Codebase | `map-codebase` |

## 4 Master Agents

Each agent auto-detects task type from your prompt and loads the right mode:

### master-coder
Detects: "build", "fix", "review", "refactor"

| Mode | What It Does | Reference Cards |
|------|-------------|-----------------|
| build | Autonomous feature development | modern-js, nodejs-backend, python-frameworks |
| debug | Systematic root cause analysis | error-handling, testing-py, testing-js |
| review | 7-dimension code review | auth-patterns, design-principles, e2e-testing |
| refactor | Code simplification | monorepo, typescript-types, git-advanced |

14 domain reference cards covering auth patterns, async Python, error handling, testing (JS + Python), TypeScript types, monorepo patterns, and more.

### master-researcher
Detects: "research", "competitor", "paper", "docs"

| Mode | What It Does |
|------|-------------|
| academic | Multi-source research with citation tracking |
| market | Competitor and market intelligence |
| technical | Documentation and API research |
| general | General-purpose research synthesis |

### master-architect
Detects: "design", "schema", "API", "system"

| Mode | What It Does |
|------|-------------|
| database | Schema design, normalization, query optimization |
| api | REST/GraphQL API design |
| system | Distributed systems architecture |
| frontend | Component architecture, state management |

### master-workflow
Detects: "/gsd:", "commit", "new feature", "autonomous"

| Mode | What It Does |
|------|-------------|
| gsd-exec | GSD plan execution with verification |
| feature | Spec-driven feature development |
| git | Commit, branch, PR workflows |
| autonomous | Vibe coding — minimal steering |

## QUICKSTART

### 1. Install (2 minutes)

```bash
# Clone the repository
git clone https://github.com/DrewDawson2027/claude-master-agents.git
cd claude-master-agents

# Copy to Claude Code config directory
cp -r master-agents/ ~/.claude/master-agents/
cp -r commands/ ~/.claude/commands/
cp -r agents/ ~/.claude/agents/

# Add dispatch rules to your Claude config
cat examples/CLAUDE.example.md >> ~/.claude/CLAUDE.md
```

### 2. Verify Installation

Open Claude Code and verify the setup:
```
/help
```

You should see the GSD commands listed. If not, restart Claude Code.

### 3. First Project (3 minutes)

Create a test project to see the system in action:

```
Let's build a simple todo API
```

Claude will detect "build" and automatically spawn `master-coder` in build mode. Expected output:

```
Spawning master-coder (build mode)
Estimated cost: ~40-60k tokens

[Agent analyzes requirements and creates implementation plan]
```

Or use GSD for structured project management:

```
/gsd:new-project
```

Expected output:
- Interactive questions about your project
- Creation of `.planning/PROJECT.md`
- Project config in `.planning/config.json`

Then:
```
/gsd:create-roadmap
/gsd:plan-phase 1
/gsd:execute-plan phases/01-foundation/01-01-PLAN.md
```

## 5-Minute Demo Walkthrough

### Scenario: Build a REST API for a Todo App

**Step 1: Initialize the project**

You: `/gsd:new-project`

Claude asks questions:
- "What do you want to build?" → "A REST API for a todo app with tasks and users"
- "If you could only nail one thing, what would it be?" → "Clean API design"
- "What's explicitly NOT in v1?" → "No mobile app, no real-time updates"
- Mode preference → "Interactive"
- Depth preference → "Standard"

**Result:** `.planning/` structure created:
```
.planning/
├── PROJECT.md          # Your requirements and constraints
└── config.json         # Workflow preferences
```

**Step 2: Create roadmap**

You: `/gsd:create-roadmap`

**Result:** Claude generates milestone-based roadmap:
```
.planning/
├── PROJECT.md
├── ROADMAP.md          # ← New: Milestones and phases
├── config.json
└── phases/
    ├── 01-foundation/
    ├── 02-api-core/
    └── 03-testing/
```

**Step 3: Plan first phase**

You: `/gsd:plan-phase 1`

**Result:** Detailed execution plan:
```
.planning/phases/01-foundation/
└── 01-01-PLAN.md       # ← Tasks: setup, dependencies, project structure
```

**Step 4: Execute the plan**

You: `/gsd:execute-plan phases/01-foundation/01-01-PLAN.md`

Claude executes each task:
- Creates project structure
- Installs dependencies
- Sets up basic configuration
- Commits each change

**Step 5: Check progress**

You: `/gsd:progress`

Output shows:
```
📊 Project: Todo API
Phase 1/3 (Foundation): ████████░░ 80% complete
Next: Continue with 01-02-PLAN.md
```

**Step 6: Verify work**

You: `/gsd:verify-work`

Claude guides you through testing:
- Run the dev server
- Test endpoints
- Check error handling

### What You Get

This structured approach creates an audit trail of decisions and a clear execution path. Every choice is documented in `.planning/`, and every phase builds on validated previous work.

## Installation

```bash
git clone https://github.com/DrewDawson2027/claude-master-agents.git
cd claude-master-agents

# Copy to Claude Code config
cp -r master-agents/ ~/.claude/master-agents/
cp -r commands/ ~/.claude/commands/
cp -r agents/ ~/.claude/agents/
```

Then add dispatch rules to your `~/.claude/CLAUDE.md`. See `examples/CLAUDE.example.md` for the full template.

## Create Your Own Mode

```markdown
# My Custom Mode

You are an expert at [domain]. Follow this protocol exactly.

## Protocol
### Phase 1: Understand
1. Read the task
2. Identify files to change
3. Check existing patterns

### Phase 2: Execute
1. Follow existing conventions
2. Write tests for new behavior
3. Verify everything works
```

See `examples/custom-mode.md` for an annotated template.

## Token Management

The framework includes a tool ladder to minimize token usage:

| Level | Tool | Cost | When |
|-------|------|------|------|
| 1 | Grep/Read | ~1-5k | Know what you're looking for |
| 2 | Single agent (Sonnet) | ~40-60k | Need architecture understanding |
| 3 | 2 agents parallel | ~80-120k | Truly separate areas (rare) |
| 4 | Plan agent | ~30-50k | Architecture decisions |

The companion [claude-code-toolkit](https://github.com/DrewDawson2027/claude-code-toolkit) enforces these limits mechanically via a PreToolUse hook. Together, the two projects give you structured workflows with automatic cost control.

## License

MIT
