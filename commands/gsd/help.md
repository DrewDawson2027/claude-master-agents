---
name: gsd:help
description: Show available GSD commands and usage guide
---

<objective>
Display the GSD command reference.

Output ONLY the reference content below. Do NOT add:

- Project-specific analysis
- Git status or file context
- Next-step suggestions
- Any commentary beyond the reference
  </objective>

<reference>
# GSD Command Reference

**GSD** (Get Shit Done) creates hierarchical project plans optimized for solo agentic development with Claude Code.

## Quick Start

1. `/gsd:new-project` - Initialize project with brief
2. `/gsd:plan-phase <number>` - Create detailed plan for first phase
3. `/gsd:execute-plan <path>` - Execute the plan
4. `/gsd:progress` - Check status and get next steps

## Core Commands

**`/gsd:new-project`**
Initialize new project with brief and configuration.

- Creates `.planning/PROJECT.md` (vision and requirements)
- Creates `.planning/config.json` (workflow mode)
- Asks for workflow mode (interactive/yolo) upfront

Usage: `/gsd:new-project`

**`/gsd:plan-phase <number>`**
Create detailed execution plan for a specific phase.

- Generates `.planning/phases/XX-phase-name/XX-YY-PLAN.md`
- Breaks phase into concrete, actionable tasks
- Includes verification criteria and success measures

Usage: `/gsd:plan-phase 1`

**`/gsd:execute-plan <path>`**
Execute a single PLAN.md file.

- Runs plan tasks sequentially
- Creates SUMMARY.md after completion
- Updates STATE.md with accumulated context

Usage: `/gsd:execute-plan .planning/phases/01-foundation/01-01-PLAN.md`

**`/gsd:progress`**
Check project status and intelligently route to next action.

- Shows visual progress bar and completion percentage
- Summarizes recent work from SUMMARY files
- Offers to execute next plan or create it if missing

Usage: `/gsd:progress`

**`/gsd:verify-work`**
Guide manual acceptance testing of recently built features.

- Reviews what was built in the latest phase
- Creates a structured test checklist
- Confirms everything works before moving on

Usage: `/gsd:verify-work`

**`/gsd:help`**
Show this command reference.

## Common Workflow

```
/gsd:new-project          # Set up project brief
/gsd:plan-phase 1         # Plan first phase
/gsd:execute-plan .planning/phases/01-foundation/01-01-PLAN.md
/gsd:progress             # Check status, continue
```

## Advanced Commands

22 additional commands are available in `commands/gsd/extras/` for:
- **Roadmap management:** create-roadmap, add-phase, insert-phase, remove-phase
- **Milestone tracking:** discuss-milestone, new-milestone, complete-milestone
- **Phase planning:** discuss-phase, research-phase, list-phase-assumptions, execute-phase
- **Session management:** resume-work, pause-work, status
- **Issue management:** consider-issues, debug, plan-fix
- **Todo management:** add-todo, check-todos
- **Codebase mapping:** map-codebase

## Files & Structure

```
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Phase breakdown
├── STATE.md              # Project memory & context
├── config.json           # Workflow mode
└── phases/
    ├── 01-foundation/
    │   ├── 01-01-PLAN.md
    │   └── 01-01-SUMMARY.md
    └── 02-core-features/
        └── 02-01-PLAN.md
```
  </reference>
