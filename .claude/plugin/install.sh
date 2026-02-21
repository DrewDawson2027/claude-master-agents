#!/bin/bash
# Master Agent System — Plugin Installer
# Copies mode files and hook scripts to expected locations
# Usage: bash install.sh

set -e

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "Installing Master Agent System..."
echo "  Plugin: $PLUGIN_DIR"
echo "  Target: $CLAUDE_DIR"
echo ""

# Create directories
mkdir -p "$CLAUDE_DIR/agents"
mkdir -p "$CLAUDE_DIR/hooks/session-state"
mkdir -p "$CLAUDE_DIR/master-agents/coder/refs"
mkdir -p "$CLAUDE_DIR/master-agents/researcher/refs"
mkdir -p "$CLAUDE_DIR/master-agents/architect/refs"
mkdir -p "$CLAUDE_DIR/master-agents/workflow"
mkdir -p "$CLAUDE_DIR/session-cache"

# Copy agents
echo "  Installing agents..."
cp "$PLUGIN_DIR/agents/"*.md "$CLAUDE_DIR/agents/"

# Copy mode files
echo "  Installing mode files..."
cp "$PLUGIN_DIR/modes/coder/"*.md "$CLAUDE_DIR/master-agents/coder/"
cp "$PLUGIN_DIR/modes/researcher/"*.md "$CLAUDE_DIR/master-agents/researcher/"
cp "$PLUGIN_DIR/modes/architect/"*.md "$CLAUDE_DIR/master-agents/architect/"
cp "$PLUGIN_DIR/modes/workflow/"*.md "$CLAUDE_DIR/master-agents/workflow/"

# Copy reference cards
echo "  Installing reference cards..."
cp "$PLUGIN_DIR/modes/coder/refs/"*.md "$CLAUDE_DIR/master-agents/coder/refs/" 2>/dev/null || true
cp "$PLUGIN_DIR/modes/researcher/refs/"*.md "$CLAUDE_DIR/master-agents/researcher/refs/" 2>/dev/null || true
cp "$PLUGIN_DIR/modes/architect/refs/"*.md "$CLAUDE_DIR/master-agents/architect/refs/" 2>/dev/null || true

# Copy hook scripts
echo "  Installing hooks..."
cp "$PLUGIN_DIR/scripts/token-guard.py" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/read-efficiency-guard.py" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/hook_utils.py" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/self-heal.py" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/agent-metrics.py" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/agent-lifecycle.sh" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/pre-compact-save.sh" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/session-register.sh" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/health-check.sh" "$CLAUDE_DIR/hooks/"
cp "$PLUGIN_DIR/scripts/token-guard-config.json" "$CLAUDE_DIR/hooks/"

# Make scripts executable
chmod +x "$CLAUDE_DIR/hooks/"*.sh

# Copy MANIFEST
cp "$PLUGIN_DIR/MANIFEST.md" "$CLAUDE_DIR/master-agents/"

echo ""
echo "  Installed successfully."
echo "  Run: bash ~/.claude/hooks/health-check.sh"
echo "  to verify installation."
