# Contributing to Claude Master Agents

Thank you for your interest in contributing! This guide will help you understand how to contribute effectively.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Types of Contributions](#types-of-contributions)
- [Development Workflow](#development-workflow)
- [Style Guide](#style-guide)
- [Testing Your Changes](#testing-your-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)

## Code of Conduct

Be respectful, constructive, and collaborative. We're building tools to make AI-assisted development better for everyone.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/claude-master-agents.git
   cd claude-master-agents
   ```
3. **Set up your development environment**:
   ```bash
   # Install to your Claude config for testing
   cp -r master-agents/ ~/.claude/master-agents/
   cp -r commands/ ~/.claude/commands/
   cp -r agents/ ~/.claude/agents/
   ```

## Types of Contributions

### 1. Bug Fixes

If you find a bug:
- Check if it's already reported in [Issues](https://github.com/DrewDawson2027/claude-master-agents/issues)
- Create a new issue if it doesn't exist
- Reference the issue number in your PR

### 2. New Features

Before adding major features:
- Open an issue to discuss the feature
- Get feedback from maintainers
- Ensure it aligns with the project's goals

### 3. Documentation Improvements

Documentation is always welcome! This includes:
- README updates
- Command documentation
- Mode file improvements
- Example additions
- Typo fixes

### 4. New Modes or Reference Cards

To add a new mode:
1. Create the mode file in the appropriate `master-agents/` subdirectory
2. Follow the mode template structure (see `examples/custom-mode.md`)
3. Add dispatch rules to `examples/CLAUDE.example.md`
4. Update the README with the new mode
5. Include examples of when to use it

To add a reference card:
1. Create the card in `master-agents/[agent]/refs/`
2. Keep it under 200 lines and focused
3. Reference it in the appropriate mode file
4. Follow existing card structure

### 5. New GSD Commands

To add a new GSD command:
1. Create the command file in `commands/gsd/` (core) or `commands/gsd/extras/` (advanced)
2. Follow the command template structure:
   ```markdown
   ---
   name: gsd:command-name
   description: Brief description
   allowed-tools:
     - Tool1
     - Tool2
   ---
   
   <objective>
   What this command accomplishes
   </objective>
   
   <process>
   Step-by-step execution
   </process>
   
   <output>
   What gets created/modified
   </output>
   
   <success_criteria>
   - [ ] Checklist of completion criteria
   </success_criteria>
   ```
3. Update `commands/gsd/help.md` with the new command
4. Update README.md command count if needed

## Development Workflow

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**:
   - Keep changes focused and atomic
   - Follow the style guide
   - Test your changes thoroughly

3. **Commit your changes**:
   ```bash
   git add [specific-files]
   git commit -m "type: brief description
   
   Longer explanation if needed
   
   Fixes #123"
   ```
   
   Commit types:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation only
   - `style:` Formatting, no code change
   - `refactor:` Code restructuring
   - `test:` Adding tests
   - `chore:` Maintenance tasks

4. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request** on GitHub

## Style Guide

### Markdown Files

- Use ATX-style headers (`#` syntax)
- Use fenced code blocks with language hints
- Keep line length reasonable (80-120 chars preferred, not enforced)
- Use lists for steps and options
- Include examples where helpful

### Mode Files

- Start with clear objective and embedded knowledge
- Use structured protocol sections (Phase 1, Phase 2, etc.)
- Include specific tool usage guidance
- Provide concrete examples
- Keep token budget visible
- Reference other modes/cards only when needed

### Command Files

- Use YAML frontmatter for metadata
- Structure with `<objective>`, `<process>`, `<output>`, `<success_criteria>`
- Be explicit about prerequisites
- Include error handling steps
- Show example outputs

### Agent Dispatch Files

- Maintain consistent detection rules
- Keep cost estimates realistic
- Update dispatch priority when adding agents
- Include examples for ambiguous cases

## Testing Your Changes

### Local Testing

1. **Install locally**:
   ```bash
   cp -r master-agents/ ~/.claude/master-agents/
   cp -r commands/ ~/.claude/commands/
   cp -r agents/ ~/.claude/agents/
   ```

2. **Test in Claude Code**:
   - Start a new session
   - Test the command/mode you changed
   - Verify behavior matches documentation
   - Check for errors or unexpected behavior

3. **Test dispatch rules** (if applicable):
   - Try various prompts that should trigger your mode
   - Verify the correct mode is selected
   - Check token estimates are reasonable

### Documentation Testing

- Run markdown link checker (CI will do this automatically)
- Verify all internal links work
- Check code blocks for syntax errors
- Ensure examples are accurate

## Submitting a Pull Request

### PR Checklist

- [ ] Code follows the style guide
- [ ] Documentation is updated
- [ ] Examples are included (if applicable)
- [ ] Changes are tested locally
- [ ] Commit messages are clear
- [ ] PR description explains the change

### PR Description Template

```markdown
## Description
Brief summary of what changed and why.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Breaking change

## Testing
How you tested this change:
- Test scenario 1
- Test scenario 2

## Related Issues
Fixes #123
Related to #456

## Screenshots (if applicable)
```

### Review Process

1. Maintainers will review your PR
2. Address any feedback or requested changes
3. Once approved, your PR will be merged
4. Your contribution will be included in the next release

## Questions?

- Open an [issue](https://github.com/DrewDawson2027/claude-master-agents/issues) for questions
- Check existing issues and discussions first
- Be specific about your question or problem

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
