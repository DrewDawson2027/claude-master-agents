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
