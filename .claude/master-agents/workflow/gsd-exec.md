# GSD Execution Mode

Capabilities (from: 28 GSD commands + workflow infrastructure)

## GSD System Overview

The GSD (Get Shit Done) system is a structured project execution framework stored in `.planning/` directories. It manages project state through phases, plans, and milestones.

### Directory Structure
```
.planning/
  PROJECT.md          # What the project is, core value, requirements
  ROADMAP.md          # Phase structure with objectives
  STATE.md            # Living memory: position, decisions, issues, session context
  config.json         # Workflow config (mode: interactive/yolo)
  phases/
    {phase-dir}/
      {plan}-PLAN.md     # Execution plan for a specific task
      {plan}-SUMMARY.md  # Results after execution
      {plan}-ISSUES.md   # UAT issues found
      {plan}-FIX.md      # Fix plan for issues
      {plan}-CONTEXT.md  # Pre-planning context
  todos/
    pending/*.md       # Captured tasks
  debug/
    *.md               # Active debug sessions
```

### Key File Purposes
- **STATE.md**: Current position, decisions made, issues logged, session context. READ THIS FIRST always.
- **ROADMAP.md**: Phase numbers, names, goals, plan counts. The navigation map.
- **PLAN.md**: Specific tasks to execute with checkpoints, deviation rules, and success criteria.
- **SUMMARY.md**: What was accomplished, key decisions, commit hashes, issues found.

## Command Reference (all 28 GSD commands)

### Project Setup
| Command | Purpose |
|---------|---------|
| `/gsd:new-project` | Initialize with deep context gathering → PROJECT.md |
| `/gsd:create-roadmap` | Create ROADMAP.md with phases |
| `/gsd:new-milestone` | Create new milestone with phases for existing project |

### Phase Management
| Command | Purpose |
|---------|---------|
| `/gsd:discuss-phase {N}` | Gather context through adaptive questioning before planning |
| `/gsd:research-phase {N}` | Investigate unknowns before planning |
| `/gsd:list-phase-assumptions {N}` | Surface Claude's assumptions about approach |
| `/gsd:plan-phase {N}` | Create detailed PLAN.md files for phase |
| `/gsd:add-phase` | Add phase to end of current milestone |
| `/gsd:insert-phase` | Insert urgent work as decimal phase (e.g., 72.1) |
| `/gsd:remove-phase` | Remove future phase and renumber |

### Execution
| Command | Purpose |
|---------|---------|
| `/gsd:execute-plan [path]` | Execute a PLAN.md with per-task atomic commits |
| `/gsd:execute-phase` | Execute all plans in phase with wave-based parallelization |

### Monitoring & Navigation
| Command | Purpose |
|---------|---------|
| `/gsd:progress` | Check progress, show context, route to next action |
| `/gsd:status` | Check status of background agents |
| `/gsd:verify-work` | Guide manual user acceptance testing |
| `/gsd:check-todos` | List pending todos, select one to work on |
| `/gsd:consider-issues` | Review deferred issues with codebase context |

### Session Management
| Command | Purpose |
|---------|---------|
| `/gsd:pause-work` | Create context handoff for pausing mid-phase |
| `/gsd:resume-work` | Resume from previous session with full context restoration |
| `/gsd:resume-task` | Resume interrupted subagent execution |

### Completion & Fixes
| Command | Purpose |
|---------|---------|
| `/gsd:plan-fix` | Plan fixes for UAT issues |
| `/gsd:complete-milestone` | Archive completed milestone, prepare for next |

### Utilities
| Command | Purpose |
|---------|---------|
| `/gsd:discuss-milestone` | Gather context for next milestone |
| `/gsd:map-codebase` | Analyze codebase with parallel Explore agents |
| `/gsd:debug` | Systematic debugging with persistent state |
| `/gsd:add-todo` | Capture idea/task as todo |
| `/gsd:help` | Show available commands |

## Execute-Plan Protocol (most common operation)

### Step 1: Pre-Flight
1. Verify `.planning/` exists (error if not → suggest `/gsd:new-project`)
2. Verify plan file exists at given path
3. Check if SUMMARY.md already exists (already executed?)
4. Load `STATE.md` for current position
5. Load `config.json` for mode (interactive/yolo)

### Step 2: Determine Execution Strategy

| Strategy | Condition | Approach |
|----------|-----------|----------|
| **A: Fully Autonomous** | No checkpoints in plan | Spawn subagent for full execution |
| **B: Segmented** | Has verify-only checkpoints | Subagent for segments, main for checkpoints |
| **C: Decision-Dependent** | Has decision checkpoints | Execute in main context (decisions affect later tasks) |

### Step 3: Execute Tasks
- Execute each task in plan order
- After each task: stage only that task's files, commit with `{type}({phase}-{plan}): {task-name}`
- Types: `feat`, `fix`, `test`, `refactor`, `perf`, `chore`
- Record commit hash for SUMMARY.md
- NEVER use `git add .` or `git add -A` — always stage files individually

### Step 4: Handle Deviations
| Discovery | Action |
|-----------|--------|
| Bug found | Auto-fix immediately, document in Summary |
| Security/correctness gap | Auto-add critical fix, document |
| Blocker | Auto-fix to unblock, document |
| Architectural change needed | STOP — ask user |
| Enhancement idea | Log to ISSUES.md, continue |

### Step 5: Complete
1. Create SUMMARY.md with: what was accomplished, decisions made, commit hashes, issues found
2. Update STATE.md (position, decisions, issues, session)
3. Update ROADMAP.md (plan count, phase status)
4. Commit planning artifacts: `docs({phase}-{plan}): complete [plan-name] plan`
5. Inform user of next steps

## Progress Check Protocol

### 5-Step Process
1. **Verify**: `.planning/` exists with STATE.md and ROADMAP.md
2. **Load**: STATE.md (position, decisions, issues) + ROADMAP.md (phases) + PROJECT.md (context)
3. **Recent**: Find 2-3 most recent SUMMARY.md files for recent work context
4. **Position**: Current phase/plan, total/completed/remaining, blockers, pending todos
5. **Report + Route**: Rich status with progress bar, then smart routing:

### Routing Logic
| Condition | Route |
|-----------|-------|
| FIX.md exists without FIX-SUMMARY.md | Execute fix plan |
| ISSUES.md exists without FIX.md | `/gsd:plan-fix` |
| Unexecuted PLAN.md exists | `/gsd:execute-plan [path]` |
| Phase complete, more phases remain | `/gsd:plan-phase {next}` |
| All phases complete | `/gsd:complete-milestone` |
| No plans yet | `/gsd:plan-phase {current}` |

## Commit Rules (enforced)

### Per-Task Commits
```bash
# Stage only files modified by this task
git add src/specific-file.ts src/another-file.ts
# Commit with conventional format
git commit -m "feat(phase1-plan2): add user authentication endpoint

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Plan Metadata Commit
```bash
# Stage ONLY planning artifacts
git add .planning/phases/*/PLAN.md .planning/phases/*/SUMMARY.md .planning/STATE.md .planning/ROADMAP.md
git commit -m "docs(phase1-plan2): complete authentication plan"
```

### NEVER
- `git add .` or `git add -A` or `git add src/`
- Skip individual file staging
- Combine code + planning in one commit

## Success Criteria (every GSD execution)

- [ ] All tasks executed
- [ ] Each task committed individually
- [ ] SUMMARY.md created with substantive content + commit hashes
- [ ] STATE.md updated
- [ ] ROADMAP updated
- [ ] Metadata committed separately
- [ ] User informed of next steps
