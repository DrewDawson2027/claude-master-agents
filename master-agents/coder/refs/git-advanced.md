# Git Advanced Workflows

## Interactive Rebase
```bash
git rebase -i HEAD~5              # Edit last 5 commits
# pick / reword / squash / fixup / drop
git rebase -i main                # Rebase all commits on branch
```
- `squash`: combine with previous, keep both messages
- `fixup`: combine with previous, discard this message
- NEVER rebase published/shared commits

## Cherry-Pick
```bash
git cherry-pick abc1234           # Apply specific commit to current branch
git cherry-pick abc..def          # Apply range
git cherry-pick -n abc1234        # Stage without committing (for modifications)
```

## Git Bisect (find bug-introducing commit)
```bash
git bisect start
git bisect bad                    # Current is broken
git bisect good v1.0              # This version was working
# Git checks out middle. Test, then:
git bisect good   # or   git bisect bad
# Repeat until found. Then:
git bisect reset
```

## Worktrees (multiple branches simultaneously)
```bash
git worktree add ../feature-branch feature-branch
# Work in ../feature-branch/ without switching
git worktree remove ../feature-branch
```

## Recovery
```bash
git reflog                        # See ALL recent HEAD movements
git reset --hard HEAD@{3}         # Restore to 3 moves ago
git stash list                    # Find stashed changes
git stash pop stash@{2}           # Restore specific stash
```

## Rules
- Rebase for clean history on feature branches
- Merge for main/shared branches (preserve history)
- Never force-push main/master
- Commit messages: imperative ("Add feature" not "Added feature")
- One logical change per commit
