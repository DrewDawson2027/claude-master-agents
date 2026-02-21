# Master Agent System

Production-grade multi-agent orchestration for Claude Code. 4 master agents consolidate 17 archived specialists, with mechanical token enforcement, lifecycle observability, and real per-invocation cost metering.

## What It Does

| Component | Purpose |
|-----------|---------|
| **4 Master Agents** | `master-coder`, `master-researcher`, `master-architect`, `master-workflow` — each with on-demand mode loading |
| **Token Guard** | PreToolUse hook enforces Tool Ladder: Grep → Read → Explore progression. Blocks wasteful agent spawns. |
| **Agent Lifecycle** | SubagentStart/SubagentStop hooks track spawn, duration, and completion |
| **Real Token Metering** | Parses subagent transcript JSONL to extract actual input/output/cache token counts and calculate real costs |
| **Context Recovery** | PreCompact hook saves session state before context compaction |
| **Read Efficiency Guard** | Prevents redundant file reads (blocks 4th read of same file) |
| **17 Mode Files** | Loaded on-demand via Read tool — doesn't break prompt cache prefix |
| **18 Reference Cards** | Quick-reference cheat sheets loaded only when needed |

## Architecture

```
~/.claude/
  agents/
    master-coder.md          # 5 modes: build, debug, refactor, scrape, school
    master-researcher.md     # 4 modes: deep, academic, competitor, market
    master-architect.md      # 4 modes: system, api, database, frontend
    master-workflow.md       # 4 modes: gsd, feature, git, autonomous
  hooks/
    token-guard.py           # Mechanical token enforcement
    agent-metrics.py         # Real token metering via transcript parsing
    agent-lifecycle.sh       # Spawn/stop duration tracking
    pre-compact-save.sh      # Context recovery state saves
    read-efficiency-guard.py # Redundant read prevention
  master-agents/
    coder/                   # Mode files + reference cards
    researcher/
    architect/
    workflow/
    MANIFEST.md              # System registry
```

## Install

### As Claude Code Plugin
```bash
claude plugin add DrewDawson2027/master-agent-plugin
```

### Manual Install
```bash
git clone https://github.com/DrewDawson2027/master-agent-plugin.git
cd master-agent-plugin
bash scripts/install.sh
```

Then add hooks to your `~/.claude/settings.json` — see `hooks/hooks.json` for the configuration.

## Token Enforcement Rules

The token guard enforces a strict Tool Ladder:

| Level | Tool | Cost | When |
|-------|------|------|------|
| 1 | Grep | ~1-2k | Know what you're looking for |
| 2 | Grep + Read | ~5-15k | Need context around matches |
| 3 | Single Explore | ~40-60k | Need architecture understanding |
| 4 | 2 Explores | ~80-120k | Truly separate areas (rare) |

Hard rules:
- Max agents per session: configurable via `token-guard-config.json` (default: 5)
- No parallel same-type agents
- Blocks agent spawns when Grep/Read suffice

## Real Token Metering

`agent-metrics.py` solves Claude Code's lack of per-invocation token reporting by parsing the transcript JSONL that Claude Code already writes. On every SubagentStop event, it:

1. Reads the agent's transcript file (provided via `agent_transcript_path`)
2. Sums `input_tokens`, `output_tokens`, `cache_read_input_tokens` from each API call
3. Calculates real cost using current pricing
4. Logs to `~/.claude/hooks/session-state/agent-metrics.jsonl`

The token guard's report function displays both heuristic estimates and real metered data.

## License

MIT
