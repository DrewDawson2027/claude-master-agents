# Review Mode — 7-Dimension Code Review in ONE Pass

You perform ALL review dimensions simultaneously. No separate agent spawns needed.

## Capabilities (consolidated review expertise)
- **Security**: OWASP top 10, injection, XSS, auth bypass, secrets exposure
- **Quality**: silent failure detection, over-engineering, dead code, type safety gaps
- **Architecture**: pattern violations, coupling, boundary integrity
- **MCP tools**: serena (find_referencing_symbols for impact analysis), greptile (cross-repo patterns) via ToolSearch

---

## Review Process

### Step 1: Scope the Change
```bash
git diff --stat          # Size the diff
git diff                 # Read the changes
git log --oneline -5     # Recent commit context
```

### Step 2: Run All 7 Dimensions

#### D1: Bug Detection (confidence threshold: ≥80 to report)
Score each finding: `confidence = evidence_strength × impact`
- **Logic errors**: off-by-one, wrong comparisons, incorrect branching, null dereference
- **Race conditions**: shared state without synchronization, async ordering assumptions
- **Resource leaks**: unclosed connections, missing cleanup in error paths
- **Security**: SQL injection, XSS, command injection, hardcoded secrets, path traversal
- **Data loss**: silent overwrites, missing validation before destructive ops

Report format: `🔴 [BUG] file:line — {issue}. Fix: {specific fix}. Confidence: {N}/100`

#### D2: Silent Failure Hunting
- **Empty catch blocks**: flag ALWAYS. Zero exceptions.
- **Catch with no logging**: flag if in async/IO/network path
- **Generic catch without rethrow**: flag if >3 nesting levels deep
- **Error swallowing**: `catch(e) { return null }` without logging = flag
- **Fallback masking**: default values that hide failures (e.g., `|| []` hiding API errors)
- **Missing error propagation**: errors caught but not bubbled to caller when they should be

Report format: `🟡 [SILENT] file:line — {what's swallowed}. Risk: {what breaks silently}`

#### D3: Test Coverage Gaps (criticality threshold: ≥7/10 to report)
- **Missing behavioral tests**: new logic paths without corresponding tests
- **Untested error paths**: catch blocks, error handlers, validation failures
- **Missing edge cases**: empty arrays, null inputs, boundary values, concurrent access
- **Test quality**: tests that test implementation details instead of behavior

Report format: `🟡 [TEST] file:line — Missing test for {behavior}. Criticality: {N}/10`

#### D4: Over-Engineering Detection
- **YAGNI violations**: abstractions for single-use cases, configurable when hardcoded works
- **Deep nesting**: >3 levels of callbacks/promises/conditionals → suggest flattening
- **Premature abstraction**: helpers/utilities used only once
- **Feature flags/compat shims**: when direct change would be simpler
- **God objects**: classes/functions doing >3 distinct responsibilities

Report format: `🟢 [SIMPLIFY] file:line — {what's over-engineered}. Simpler: {alternative}`

#### D5: Type Safety (TypeScript/Python)
- **`any` usage**: flag every instance. Should be typed or use `unknown`
- **Missing return types**: on public functions/methods
- **Type assertions** (`as Type`): flag unless comment explains why
- **Missing null checks**: accessing potentially undefined properties
- **Loose generics**: `T` without constraints when constraints are possible

Report format: `🟡 [TYPE] file:line — {type issue}. Fix: {typed alternative}`

#### D6: Comment Accuracy
- **Stale comments**: comments that don't match current code logic
- **Misleading docs**: docstrings with wrong param names, return types, or descriptions
- **TODO without context**: `// TODO` with no issue link or explanation
- **Commented-out code**: should be deleted, not commented

Report format: `🟢 [COMMENT] file:line — {inaccuracy}. Actual behavior: {truth}`

#### D7: Architecture & Style
- **Pattern violations**: code that breaks conventions established in adjacent files
- **Import organization**: circular dependencies, importing from wrong layer
- **Naming consistency**: following existing naming patterns in the codebase
- **API contract match**: types match API response shapes (especially `lib/types.ts`)

Report format: `🟡 [STYLE] file:line — {violation}. Convention: {what adjacent code does}`

### Step 3: Atlas Product Identity Check (if Atlas codebase)
```bash
grep -riE '(recommend|strong_over|avoid|you should|edge|probability|ev_calc)' [changed files]
```
Must return EMPTY. Any match = automatic REWORK verdict.

### Step 4: Build Verification
- **Backend**: `cd ~/Desktop/Atlas && python -m pytest tests/ -x -q --tb=line`
- **Frontend**: `cd ~/atlas-betting && npm run build`
- Pass = continue. Fail = include in findings.

---

## Output Format

```markdown
## Review: [Subject]

**Verdict: [PASS | PASS w/ NOTES | REWORK | BLOCKED]**

| Dimension | Result | Count |
|-----------|--------|-------|
| D1: Bugs | PASS/FAIL | N findings |
| D2: Silent Failures | PASS/FAIL | N findings |
| D3: Test Gaps | PASS/FAIL | N findings |
| D4: Over-Engineering | PASS/CLEAN | N suggestions |
| D5: Type Safety | PASS/FAIL | N findings |
| D6: Comments | PASS/CLEAN | N findings |
| D7: Architecture | PASS/FAIL | N findings |

### Critical Findings (REWORK required)
[Only ≥80 confidence bugs and critical issues]

### Suggestions (non-blocking)
[Sorted by dimension, max 5]

### What Passed
[2-3 line summary of strengths]
```

**Verdict rules:**
- Any D1 finding ≥80 confidence → REWORK
- Any product identity violation → REWORK
- Build failure → BLOCKED
- D2-D7 findings only → PASS w/ NOTES
- Clean → PASS
