# Git Workflow Mode

Capabilities (from: commit, commit-push-pr, clean_gone commands)

## Commit Protocol

### Standard Commit
1. Check status: `git status` (never `-uall`)
2. Review changes: `git diff` (staged + unstaged)
3. Check recent commits: `git log --oneline -10` (follow style)
4. Stage specific files: `git add src/file1.ts src/file2.ts` (NEVER `git add .` or `-A`)
5. Commit with conventional message:

```bash
git commit -m "$(cat <<'EOF'
feat(scope): add user authentication endpoint

Implements JWT-based auth with refresh token rotation.
Closes #123.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

### Conventional Commit Types
| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `test` | Adding/updating tests |
| `refactor` | Code change that's neither fix nor feature |
| `perf` | Performance improvement |
| `chore` | Build, deps, config changes |
| `docs` | Documentation only |
| `style` | Formatting, semicolons, etc. |

### Commit Message Rules
- Focus on "why" not "what" (the diff shows the "what")
- 50 char limit for subject line
- Imperative mood: "add" not "added" or "adds"
- Body for context when non-obvious
- Reference issues: `Closes #N`, `Fixes #N`
- Always include Co-Authored-By for Claude

## Commit-Push-PR Flow

### Full Workflow
1. **Stage + Commit** (using protocol above)
2. **Push**: `git push -u origin HEAD`
3. **Create PR**:

```bash
gh pr create --title "feat: add user auth" --body "$(cat <<'EOF'
## Summary
- Added JWT authentication endpoint
- Implemented refresh token rotation
- Added rate limiting for auth routes

## Test plan
- [ ] Unit tests pass for auth service
- [ ] Integration test for login flow
- [ ] Manual test: login → refresh → logout

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### PR Title Rules
- Under 70 characters
- Use conventional prefix: `feat:`, `fix:`, `refactor:`
- Details go in body, not title

### PR Body Structure
```markdown
## Summary
<1-3 bullet points of what changed>

## Test plan
[Bulleted checklist of verification steps]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Branch Management

### Clean Gone Branches
Remove local branches deleted on remote:

```bash
# Prune remote tracking branches
git fetch --prune

# Find and delete local branches where remote is gone
git branch -vv | grep ': gone]' | awk '{print $1}' | xargs git branch -D
```

### Branch Naming Convention
```
feat/{issue-number}-{short-description}
fix/{issue-number}-{short-description}
refactor/{short-description}
```

## Safety Rules (NEVER violate)

- **NEVER** `git push --force` to main/master
- **NEVER** `git reset --hard` without user confirmation
- **NEVER** `git checkout .` or `git restore .` (destroys uncommitted work)
- **NEVER** `--no-verify` to skip hooks unless user explicitly requests
- **NEVER** amend published commits without user confirmation
- **NEVER** commit `.env`, credentials, or secrets — warn user if they ask
- **ALWAYS** create NEW commits after pre-commit hook failures (don't amend)
- **ALWAYS** stage files individually (not directories)
- **ALWAYS** confirm before destructive operations

## Common Operations

### View PR comments
```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

### Check CI status
```bash
gh pr checks
```

### Interactive rebase (when user requests)
```bash
# NOT -i (interactive not supported in Claude)
# Instead, use non-interactive rebase
git rebase main
```

### Cherry-pick
```bash
git cherry-pick {commit-hash}
# If conflicts: resolve, then git cherry-pick --continue
```

### Stash
```bash
git stash push -m "description of changes"
git stash list
git stash pop  # or git stash apply stash@{N}
```
