# Release Process

This document outlines the process for creating a new release of claude-master-agents.

## Pre-Release Checklist

Before creating a release:

- [ ] All changes are committed and pushed
- [ ] CHANGELOG.md is updated with all changes
- [ ] Version number is chosen (following semantic versioning)
- [ ] All CI checks pass
- [ ] Documentation is up to date
- [ ] README.md reflects current features
- [ ] Examples are tested and working

## Semantic Versioning

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes (incompatible API changes)
- **MINOR** (x.Y.0): New features (backward compatible)
- **PATCH** (x.y.Z): Bug fixes (backward compatible)

### Version Decision Guide

**Choose MAJOR (v2.0.0) when:**
- Breaking changes to agent dispatch rules
- Removal of commands or modes
- Changes that require users to modify their CLAUDE.md
- Structural changes to .planning/ directory

**Choose MINOR (v1.Y.0) when:**
- New commands or modes added
- New reference cards added
- Enhanced documentation
- New optional features
- CI/CD improvements

**Choose PATCH (v1.0.Z) when:**
- Bug fixes
- Typo corrections
- Performance improvements
- Internal refactoring (no user impact)

## Current Release: v1.1.0 (Proposed)

This release is a **MINOR** version bump because:
- Additive documentation features (QUICKSTART, demo walkthrough)
- New CI workflows (infrastructure enhancement)
- Behavioral change to self-modification is a **safety improvement** (opt-in)
- No breaking changes to existing commands or modes
- All existing user setups continue to work

## Creating a Release

### 1. Update CHANGELOG.md

Move items from `[Unreleased]` to a new version section:

```markdown
## [1.1.0] - 2026-02-16

### Added
- QUICKSTART section in README.md
- 5-minute demo walkthrough
...

## [1.0.0] - 2025-02-16
...
```

Update the links at the bottom:

```markdown
[Unreleased]: https://github.com/DrewDawson2027/claude-master-agents/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/DrewDawson2027/claude-master-agents/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DrewDawson2027/claude-master-agents/releases/tag/v1.0.0
```

### 2. Commit the CHANGELOG

```bash
git add CHANGELOG.md
git commit -m "docs: prepare v1.1.0 release"
git push origin main
```

### 3. Create and Push the Tag

```bash
# Create an annotated tag
git tag -a v1.1.0 -m "Release v1.1.0

Repository polish and usability improvements:
- Added QUICKSTART guide and 5-minute demo walkthrough
- Implemented deterministic dispatch rules with tie-breakers
- Changed learning behavior to opt-in (was silent modification)
- Added CONTRIBUTING.md and improved documentation
- Added CI workflows for markdown link checking and smoke tests

See CHANGELOG.md for full details."

# Push the tag to GitHub
git push origin v1.1.0
```

### 4. Create GitHub Release

1. Go to: https://github.com/DrewDawson2027/claude-master-agents/releases/new
2. Select tag: `v1.1.0`
3. Release title: `v1.1.0 - Repository Polish & Usability`
4. Description: Copy from CHANGELOG.md release notes section
5. Check "Set as the latest release"
6. Click "Publish release"

### 5. Announce (Optional)

- Update any documentation that references the version
- Announce in relevant channels/communities
- Share examples and highlights

## Post-Release

After creating the release:

1. **Start new Unreleased section** in CHANGELOG.md:
   ```markdown
   ## [Unreleased]

   ### Added
   
   ### Changed
   
   ### Fixed
   ```

2. **Verify installation** works with the new tag:
   ```bash
   git clone --branch v1.1.0 https://github.com/DrewDawson2027/claude-master-agents.git
   cd claude-master-agents
   # Test installation
   ```

3. **Monitor issues** for any problems with the release

## Hotfix Process

If a critical bug is found after release:

1. Create a hotfix branch from the release tag:
   ```bash
   git checkout -b hotfix/v1.1.1 v1.1.0
   ```

2. Fix the bug and commit

3. Update CHANGELOG.md with the fix

4. Follow the release process for v1.1.1 (PATCH version)

## Version History

- **v1.1.0** (Proposed) - Repository polish, deterministic dispatch, opt-in learning
- **v1.0.0** (2025-02-16) - Initial public release

## Notes

- Always create **annotated tags** (`-a` flag) with meaningful messages
- Tag messages should summarize the key changes
- Keep CHANGELOG.md as the source of truth for changes
- Test releases in a clean environment before announcing
- Use GitHub Releases for distribution, not just tags
