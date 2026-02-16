# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- QUICKSTART section in README.md with minimal install steps and first command guide
- 5-minute demo walkthrough in README.md showing complete GSD workflow
- Deterministic dispatch tie-breaker rules in CLAUDE.example.md
- Explicit dispatch reporting format with token cost estimates
- CONTRIBUTING.md with comprehensive contribution guidelines
- CHANGELOG.md for tracking version history
- GitHub Actions CI workflows for markdown link checking and smoke tests

### Changed
- Learning from Mistakes behavior changed to opt-in only (was silent auto-modification)
- Dispatch rules now include priority ordering for ambiguous cases
- Master agent dispatch requires explicit cost reporting

### Fixed
- Clarified installation paths and command locations
- Improved consistency between documentation and actual command names

## [1.0.0] - 2025-02-16

### Added
- Initial public release
- 4 master agents (coder, researcher, architect, workflow)
- GSD project management system with 27 commands
- 6 core GSD commands: new-project, plan-phase, execute-plan, progress, verify-work, help
- 21 advanced GSD commands for roadmap management, debugging, and context switching
- Master-coder with 4 modes (build, debug, review, refactor) and 14 reference cards
- Master-researcher with 4 modes (academic, market, technical, general)
- Master-architect with 4 modes (database, api, system, frontend)
- Master-workflow with 4 modes (gsd-exec, feature, git, autonomous)
- Token management framework with tool ladder and budget guidelines
- Comprehensive README with agent detection patterns and command reference

### Documentation
- Installation instructions
- Master agent overview with mode detection tables
- Token management guidelines
- Command reference for all 27 GSD commands
- Example CLAUDE.md configuration file
- Custom mode template
- License (MIT)

## Release Notes - v1.1.0 (Proposed)

This release focuses on repository polish, user experience improvements, and establishing clear contribution pathways. The changes are primarily additive (documentation and CI) with important behavioral changes to self-modification (now opt-in).

### Breaking Changes
- **Learning from Mistakes** is now **opt-in** instead of automatic silent modification. Users must explicitly enable it in their CLAUDE.md. This prevents unexpected configuration drift and gives users control over when the system learns from corrections.

### Semantic Version Rationale

We recommend **v1.1.0** for this release because:
- **Minor version bump** appropriate for additive features (new documentation, CI)
- No breaking changes to existing APIs or commands
- Behavioral change to self-modification is a safety improvement (opt-in vs silent)
- New features: QUICKSTART guide, demo walkthrough, CI infrastructure
- Maintains backward compatibility with v1.0.0 setups

If the opt-in change for "Learning from Mistakes" is considered breaking for users who depended on silent modification, consider v2.0.0 instead.

### Upgrade Guide (v1.0.0 → v1.1.0)

**For existing users:**

1. **Update your installation**:
   ```bash
   cd claude-master-agents
   git pull origin main
   cp -r master-agents/ ~/.claude/master-agents/
   cp -r commands/ ~/.claude/commands/
   cp -r agents/ ~/.claude/agents/
   ```

2. **Review dispatch changes**:
   - Open `examples/CLAUDE.example.md`
   - Review new deterministic dispatch rules
   - Update your `~/.claude/CLAUDE.md` if you want the new dispatch reporting format

3. **Learning mode (IMPORTANT)**:
   - Silent self-modification is now **opt-in**
   - If you want the old behavior, add to your `~/.claude/CLAUDE.md`:
     ```markdown
     ## Learning Mode: ENABLED
     
     When I correct you or you make a mistake:
     1. Fix the issue
     2. SILENTLY update: universal → edit CLAUDE.md, project-specific → `memory/learned-patterns.md`
     3. No permission needed. No announcement.
     ```
   - Without this, Claude will ask before modifying configuration

4. **No other changes required** - all commands and modes work as before

### Migration from Silent Learning to Opt-In

If you had been relying on automatic learning behavior:
- Your existing `~/.claude/CLAUDE.md` may contain learned patterns
- These are preserved and continue to work
- Future learning requires the opt-in configuration above
- You can review and clean up learned patterns at any time

### Known Issues
- Some GSD commands reference `~/.claude/get-shit-done/` external files that are not included in this repository. Commands work without these files, but some advanced features may require manual setup.

[Unreleased]: https://github.com/DrewDawson2027/claude-master-agents/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/DrewDawson2027/claude-master-agents/releases/tag/v1.0.0
