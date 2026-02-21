# Feature Workflow Mode

Capabilities (from: new-feature spec-driven workflow)

## Purpose

Spec-driven development: gather requirements → write specs → get approval → implement. Never jump to code without a spec.

## Spec-Driven Development Process

### Step 1: Create Spec Directory
```bash
mkdir -p .claude/specs/{feature-slug}
```

### Step 2: Requirements Gathering

Interview the user systematically:
1. **Problem**: What problem does this solve? Why now?
2. **User**: Who is the primary user? What's their context?
3. **Scope**: What's in scope? What's explicitly OUT of scope?
4. **Success**: What does success look like? How will we measure it?
5. **Constraints**: Technical constraints? Timeline? Dependencies?
6. **Edge cases**: What could go wrong? What are the boundary conditions?

Use AskUserQuestion for structured multi-choice questions when possible.

### Step 3: Write requirements.md

```markdown
# Requirements: {Feature Name}

## Problem Statement
[What problem are we solving and why it matters]

## User Stories
- As a [user], I want to [action] so that [benefit]

## Acceptance Criteria
- [ ] Criterion 1 (specific, testable)
- [ ] Criterion 2

## Out of Scope
- [What we're NOT doing — prevents scope creep]

## Success Metrics
- [How we'll know it worked — quantifiable]

## Constraints
- [Technical, timeline, dependency constraints]
```

### Step 4: Write design.md

```markdown
# Design: {Feature Name}

## Architecture Decisions
- [Decision and rationale — why this approach over alternatives]

## API Endpoints (if applicable)
| Method | Path | Description | Auth |
|--------|------|-------------|------|

## Data Models
[Schema changes needed — link to database-design mode if complex]

## File Changes
| File | Change Type | Description |
|------|-------------|-------------|
| src/... | Create | New component for... |
| src/... | Modify | Add endpoint for... |

## Dependencies
- [New dependencies needed with rationale]

## Testing Strategy
- Unit: [what to unit test]
- Integration: [what to integration test]
- E2E: [critical user flows to verify]
```

### Step 5: Write tasks.md

```markdown
# Tasks: {Feature Name}

## Implementation Tasks (ordered by dependency)
- [ ] Task 1: [Specific step with clear done condition]
- [ ] Task 2: [Next step — depends on Task 1]
- [ ] Task 3: [Independent — can parallelize with Task 2]

## Testing Tasks
- [ ] Write unit tests for [specific module]
- [ ] Write integration tests for [specific flow]

## Documentation Tasks
- [ ] Update API docs
- [ ] Add inline code documentation where non-obvious
```

### Step 6: Get Approval

Present the complete spec to the user:
1. Summary of requirements
2. Architecture approach (with alternatives considered)
3. File changes overview
4. Task breakdown with estimated complexity
5. Ask: "Should I proceed with implementation?"

### Step 7: Implementation

If approved, execute tasks from tasks.md:
- Follow task order (respects dependencies)
- Commit after each logical task completion
- Run tests after each change
- Update tasks.md checkboxes as completed
- If deviation needed, update spec first

## Integration with GSD

When a feature is large enough for GSD:
1. Run requirements gathering (Steps 2-3)
2. Convert design.md into `.planning/` PLAN.md files
3. Use `/gsd:execute-plan` for structured execution
4. Use `/gsd:verify-work` for UAT

## Quick Features (< 30 min implementation)

For simple features, streamline the process:
1. Write a brief requirements + design in one file
2. Get verbal approval
3. Implement directly
4. Commit with descriptive message

Skip full spec process when: single-file change, clear requirements, no architectural decisions needed.

## Anti-Patterns

- Jumping to code without understanding requirements
- Skipping the "out of scope" section (leads to scope creep)
- Not getting approval before implementing
- Implementing everything in one mega-commit
- Not writing tests as part of the feature
