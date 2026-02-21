# Autonomous Execution Mode

Capabilities (from: ralph-loop, autonomous-loop, cancel-ralph)

## Purpose

Run autonomously until the goal is FULLY achieved. No asking for permission mid-task. No stopping early. Verify everything before claiming done.

## Autonomous Execution Protocol

### Phase 1: Analyze
1. Break down the goal into concrete, ordered steps
2. Identify dependencies between steps
3. Estimate complexity (quick sanity check — not time estimates)
4. Create mental checklist of all deliverables

### Phase 2: Execute
1. Work through each step methodically
2. After each step, verify it worked correctly
3. If something breaks, fix it and continue
4. Log progress internally (what's done, what's next)

### Phase 3: Verify
1. Run all relevant tests
2. Manually verify the feature works as expected
3. Check for regressions in related functionality
4. Verify code quality (no lint errors, no type errors)

### Phase 4: Complete
Only when EVERYTHING works, produce completion output.

## Rules of Engagement

### NEVER claim done until:
- All code is written and saved
- All tests pass
- The feature actually works (verified by running it)
- No obvious regressions introduced
- Code is committed (if requested)

### When blocked:
1. Try alternative approaches (at least 2-3)
2. Search for solutions (WebSearch, docs, existing code patterns)
3. Simplify the approach if full solution is blocked
4. Only ask for help as absolute last resort

### Deviation handling:
- **Bug discovered**: Fix it immediately, note in summary
- **Missing dependency**: Install it, continue
- **Design flaw discovered**: Fix the design, note the change
- **Out of scope discovery**: Note it, don't implement it
- **Security issue**: Fix immediately, never skip

## Ralph Loop Pattern

The Ralph Loop runs until a promise is fulfilled:

```
<promise>GOAL_ACHIEVED</promise>
```

### Loop Structure
```
while (goal not achieved):
    1. Assess current state
    2. Identify next action
    3. Execute action
    4. Verify result
    5. If blocked → try alternative
    6. If goal achieved → verify thoroughly → emit promise
```

### Promise Rules
- `<promise>GOAL_ACHIEVED</promise>` is the ONLY valid completion signal
- NEVER emit the promise prematurely
- The promise means: "I have verified this works end-to-end"

### Cancel Ralph
User can cancel at any time. When cancelled:
1. Stop current work immediately
2. Summarize what was accomplished
3. List what remains undone
4. Note any in-progress state that needs cleanup

## Completion Output Format

```markdown
<promise>GOAL_ACHIEVED</promise>

## Summary
- **Goal**: [original goal statement]
- **Accomplished**: [what was built/changed]
- **Files changed**: [list of modified files]
- **Tests**: [pass/fail status]
- **How to verify**: [steps user can take to confirm]

## Decisions Made
- [Any design decisions made autonomously]

## Issues Discovered (if any)
- [Non-blocking issues noticed but not in scope]
```

## Integration with GSD

For large autonomous tasks:
1. Check if `.planning/` exists → use GSD structure
2. If no planning structure → work autonomously without it
3. For multi-phase work → suggest GSD after completion: "This was complex enough that future similar work should use `/gsd:new-project`"

## Safety Guardrails

Even in autonomous mode:
- **Never** push to remote without explicit prior authorization
- **Never** delete branches or data without confirmation
- **Never** modify production configs
- **Never** install global packages
- **Always** commit changes (can be reverted)
- **Always** run tests before claiming done
