<div align="center">
<h1>🤖 Claude Master Agents</h1>
<h3>The structured intelligence layer Claude Code was missing.</h3>
<p><strong>4 specialist agents. 27 workflow commands. Zero Jira.</strong></p>
<p>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/DrewDawson2027/claude-master-agents/stargazers"><img src="https://img.shields.io/github/stars/DrewDawson2027/claude-master-agents?style=social" alt="Stars"></a>
  <a href="https://github.com/DrewDawson2027/claude-master-agents/network/members"><img src="https://img.shields.io/github/forks/DrewDawson2027/claude-master-agents?style=social" alt="Forks"></a>
  <a href="https://github.com/DrewDawson2027/claude-master-agents/commits"><img src="https://img.shields.io/github/last-commit/DrewDawson2027/claude-master-agents" alt="Last Commit"></a>
</p>
</div>

---

## 🔥 The Problem

Claude Code is powerful — but completely flat.

> Every task gets the same treatment. No project memory. No specialized expertise. No structured lifecycle.  
> You end up re-explaining context every session, burning tokens on exploration, and stitching together your own workflow from scratch.

**Claude Master Agents fixes all of that.**

---

## ⚡ What You Get

Two things, working together:

| | What | Why |
|--|------|-----|
| 🧠 | **4 Master Agents** | Auto-detect task type → load specialized instructions (code, research, architecture, workflow) |
| 📋 | **GSD System** | 27-command project lifecycle manager — from brief to shipped, no tickets required |

---

## 🧠 The 4 Master Agents

Each agent reads your prompt, detects the right mode, and loads specialist instructions automatically. No manual switching.

<details>
<summary><b>🛠️ master-coder</b> — Build · Debug · Review · Refactor</summary>

**Auto-detects from:** `build`, `fix`, `review`, `refactor`

| Mode | What It Does | Reference Cards |
|------|-------------|-----------------|
| `build` | Autonomous feature development | modern-js, nodejs-backend, python-frameworks |
| `debug` | Systematic root cause analysis | error-handling, testing-py, testing-js |
| `review` | 7-dimension code review | auth-patterns, design-principles, e2e-testing |
| `refactor` | Code simplification & cleanup | monorepo, typescript-types, git-advanced |

> Ships with **14 domain reference cards** — auth patterns, async Python, error handling, testing (JS + Python), TypeScript types, monorepo patterns, and more.

</details>

<details>
<summary><b>🔬 master-researcher</b> — Academic · Market · Technical · General</summary>

**Auto-detects from:** `research`, `competitor`, `paper`, `docs`

| Mode | What It Does |
|------|-------------|
| `academic` | Multi-source research with citation tracking |
| `market` | Competitor and market intelligence |
| `technical` | Documentation and API research |
| `general` | General-purpose research synthesis |

</details>

<details>
<summary><b>🏗️ master-architect</b> — Database · API · System · Frontend</summary>

**Auto-detects from:** `design`, `schema`, `API`, `system`

| Mode | What It Does |
|------|-------------|
| `database` | Schema design, normalization, query optimization |
| `api` | REST/GraphQL API design |
| `system` | Distributed systems architecture |
| `frontend` | Component architecture, state management |

> Always produces **ADRs + Mermaid diagrams + trade-off tables**. Never single-option recommendations.

</details>

<details>
<summary><b>🔄 master-workflow</b> — GSD · Feature · Git · Autonomous</summary>

**Auto-detects from:** `/gsd:`, `commit`, `new feature`, `autonomous`

| Mode | What It Does |
|------|-------------|
| `gsd-exec` | GSD plan execution with verification |
| `feature` | Spec-driven feature development |
| `git` | Commit, branch, PR workflows |
| `autonomous` | Vibe coding — minimal steering |

</details>

---

## 📋 GSD: Project Management for AI-Assisted Development

> Nothing like this exists for Claude Code.

GSD gives you a full project lifecycle — from brief to verified ship — in a single `.planning/` folder. No external tools. No dashboards. Just structured phases Claude executes.

### The 5 Core Commands

```bash
/gsd:new-project              # Interactive setup → creates .planning/ structure
/gsd:plan-phase 1             # Claude writes a detailed execution plan
/gsd:execute-plan PLAN.md     # Claude executes the plan, task by task
/gsd:progress                 # Progress bar, status, next action routing
/gsd:verify-work              # Guided acceptance testing before "done"
```

### What Lives in `.planning/`

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

### All 27 Commands

<details>
<summary>View full command reference</summary>

**6 core — the daily workflow:**

| Command | What It Does |
|---------|-------------|
| `/gsd:new-project` | Initialize project with brief, config, `.planning/` structure |
| `/gsd:plan-phase` | Create detailed execution plan for a phase |
| `/gsd:execute-plan` | Execute a PLAN.md with sequential task completion |
| `/gsd:progress` | Check status, show progress, route to next action |
| `/gsd:verify-work` | Guide manual acceptance testing |
| `/gsd:help` | Full command reference |

**21 advanced — roadmap management, debugging, context switching:**

| Category | Commands |
|----------|---------|
| Roadmap | `create-roadmap`, `add-phase`, `remove-phase`, `insert-phase` |
| Milestones | `discuss-milestone`, `new-milestone`, `complete-milestone` |
| Phase work | `discuss-phase`, `research-phase`, `execute-phase`, `list-phase-assumptions` |
| Task management | `add-todo`, `check-todos`, `consider-issues` |
| Context | `pause-work`, `resume-work`, `resume-task`, `status` |
| Debugging | `debug`, `plan-fix` |
| Codebase | `map-codebase` |

</details>

---

## 🚀 Installation

```bash
git clone https://github.com/DrewDawson2027/claude-master-agents.git
cd claude-master-agents

# Drop into your Claude Code config
cp -r master-agents/ ~/.claude/master-agents/
cp -r commands/      ~/.claude/commands/
cp -r agents/        ~/.claude/agents/
```

Then add the dispatch rules to your `~/.claude/CLAUDE.md`. See [`examples/CLAUDE.example.md`](examples/CLAUDE.example.md) for the ready-to-paste template.

### ⚠️ Prerequisite: GSD Workflow Assets

GSD commands reference template files under `~/.claude/get-shit-done/`. Install the companion toolkit first:

👉 **[claude-code-toolkit](https://github.com/DrewDawson2027/claude-code-toolkit)**

```bash
# Verify it's installed
test -d ~/.claude/get-shit-done && echo "✅ get-shit-done installed" || echo "❌ Missing — install claude-code-toolkit first"
```

---

## 🧩 Build Your Own Mode

Drop a custom mode into any agent in under 5 minutes:

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

See [`examples/custom-mode.md`](examples/custom-mode.md) for a fully annotated template.

---

## 💰 Token Management

The framework enforces a **Tool Ladder** to minimize wasted tokens:

| Level | Tool | Est. Cost | When to Use |
|-------|------|-----------|-------------|
| 1 | Grep / Read | ~1–5k | Know exactly what you're looking for |
| 2 | Single agent (Sonnet) | ~40–60k | Need architecture understanding |
| 3 | Plan agent | ~30–50k | Architecture decisions |
| 4 | 2 agents parallel | ~80–120k | Truly separate areas (rare) |

The companion **[claude-code-toolkit](https://github.com/DrewDawson2027/claude-code-toolkit)** enforces these limits mechanically via a `PreToolUse` hook — automatic cost control, no willpower required.

---

## 🤝 Contributing

Contributions welcome! If you've built a useful mode or reference card, open a PR. New modes should follow the template in [`examples/custom-mode.md`](examples/custom-mode.md).

---

## 📄 License

MIT — use it, fork it, ship it.

---

<div align="center">
<p><strong>If this saved you time, a ⭐ star helps others find it.</strong></p>
</div>
