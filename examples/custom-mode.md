# Custom Mode Template

Use this as a starting point to create your own mode file. Save it in any master agent directory (e.g., `master-agents/coder/my-mode.md`).

---

```markdown
# [Mode Name] — [One-Line Description]

You are an expert at [domain]. Follow this protocol exactly.

## Embedded Knowledge
<!-- List the skills and knowledge this mode combines.
     These tell Claude what expertise to draw on. -->
- skill-1: brief description of what it provides
- skill-2: brief description
<!-- Optional: reference cards that should be loaded for specific sub-tasks -->
- When doing [specific task]: load refs/my-reference-card.md

---

## Protocol

### Phase 1: Understand Scope
<!-- What should the agent do BEFORE making any changes? -->
1. Read the task description completely
2. Identify ALL files that need to change
3. Read existing code in those files (Grep → Read)
4. Identify the patterns used in adjacent code — follow them exactly

### Phase 2: Execute
<!-- The main work loop. Be specific about quality expectations. -->
1. Make changes following existing conventions
2. Write tests for new behavior
3. Verify everything works (run tests, build, etc.)

### Phase 3: Verify
<!-- How does the agent know it's done? -->
1. All tests pass
2. No regressions introduced
3. Changes match the original request — nothing more, nothing less

---

## Rules
<!-- Hard constraints the agent must follow. Keep these short and absolute. -->
- Never add features beyond what was requested
- Follow existing code style exactly
- If unsure about a decision, state assumptions clearly
- Run tests before declaring work complete
```

---

## How to Activate Your Mode

Add a trigger rule to your `CLAUDE.md`:

```markdown
## Auto-Trigger Rules

- **master-coder**: ..., "my-keyword/another-keyword" (my-mode)
```

When Claude detects the keyword in a user message, it loads your mode file and follows the protocol.

## Adding Reference Cards

Reference cards are domain-specific cheat sheets loaded on demand. Create them in a `refs/` subdirectory:

```
master-agents/coder/refs/my-domain.md
```

Then reference them in your mode file:

```markdown
## Embedded Knowledge
- When doing [specific thing]: load refs/my-domain.md
```

Reference cards should be concise (under 200 lines) and focused on patterns, not tutorials.
