# Compatibility Matrix

## Claude Code Versions

| Feature Set | Min Version | Tested On | Notes |
|-------------|-------------|-----------|-------|
| Core runtime (team_runtime.py) | 1.0.0 | 1.0.x | Requires `-p` flag support |
| MCP Coordinator | 1.0.0 | 1.0.x | Requires MCP server support |
| Hook system | 1.0.0 | 1.0.x | PreToolUse, SessionStart, SubagentStart/Stop |
| Cost tracking | 1.0.0 | 1.0.x | Requires ccusage or JSONL usage logs |
| Agent system | 1.0.0 | 1.0.x | Requires custom agent support |

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS (darwin) | Full | Primary development platform. tmux + iTerm2/Terminal.app |
| Linux | Partial | tmux support. No AppleScript session wake. |
| Windows (WSL) | Untested | Should work under WSL with tmux. Native Windows unsupported. |

## Dependencies

| Dependency | Min Version | Purpose |
|------------|-------------|---------|
| Python | 3.10+ | Runtime scripts (team_runtime, cost_runtime, observability, policy) |
| Node.js | 18.0+ | MCP coordinator server |
| tmux | 3.0+ | Team pane management |
| claude CLI | 1.0+ | Agent spawning (`claude -p`) |
| ccusage (optional) | any | Cost data extraction |

## Component Dependencies

```
claude-stack bootstrap
  -> set_plugin_profile.py
  -> trust_audit.py
  -> snapshot_lock.py
  -> cost_doctor.py
  -> policy_engine.py lint
  -> parity_audit.py
  -> team_runtime.py (smoke test)
```
