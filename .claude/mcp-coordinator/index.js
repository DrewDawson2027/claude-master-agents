#!/usr/bin/env node

/**
 * MCP Coordinator Server — thin routing layer.
 * All logic lives in lib/ modules. This file wires up the MCP server,
 * defines tool schemas, and dispatches calls.
 * @module index
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { join } from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

import { cfg } from "./lib/constants.js";
import {
  sanitizeId, sanitizeShortSessionId, sanitizeName,
  sanitizeModel, sanitizeAgent, requireDirectoryPath, normalizeFilePath,
  ensureSecureDirectory, sleepMs, acquireExclusiveFileLock, enforceMessageRateLimit,
} from "./lib/security.js";
import { readJSONLLimited, batQuote, text } from "./lib/helpers.js";
import { handleListSessions, handleGetSession, getSessionStatus } from "./lib/sessions.js";
import { handleCheckInbox, handleSendMessage, handleBroadcast, handleSendDirective } from "./lib/messaging.js";
import { handleDetectConflicts } from "./lib/conflicts.js";
import {
  handleSpawnWorker, handleSpawnWorkers, handleGetResult, handleKillWorker,
  handleSpawnTerminal, handleResumeWorker, handleUpgradeWorker,
} from "./lib/workers.js";
import { handleRunPipeline, handleGetPipeline } from "./lib/pipelines.js";
import { handleCreateTask, handleUpdateTask, handleListTasks, handleGetTask, handleReassignTask, handleGetTaskAudit, handleCheckQualityGates } from "./lib/tasks.js";
import { handleApprovePlan, handleRejectPlan } from "./lib/approval.js";
import { handleShutdownRequest, handleShutdownResponse } from "./lib/shutdown.js";
import { handleWriteContext, handleReadContext, handleExportContext } from "./lib/context-store.js";
import { handleCreateTeam, handleGetTeam, handleListTeams } from "./lib/teams.js";
import { handleTeamDispatch } from "./lib/team-dispatch.js";
import {
  handleTeamStatusCompact,
  handleTeamQueueTask,
  handleTeamAssignNext,
  handleTeamRebalance,
  handleSidecarStatus,
} from "./lib/team-tasking.js";
import { runGC } from "./lib/gc.js";
import { handleWakeSession } from "./lib/platform/wake.js";
import { selectWakeText } from "./lib/platform/wake.js";
import {
  buildPlatformLaunchCommand, isProcessAlive, killProcess,
  isSafeTTYPath, buildWorkerScript, buildInteractiveWorkerScript,
  buildCodexWorkerScript, buildCodexInteractiveWorkerScript,
} from "./lib/platform/common.js";

// Legacy cost MCP deprecation metadata (compat helpers for tests and envelope wrappers)
const LEGACY_COST_DEPRECATIONS = {
  coord_cost_summary: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost overview" },
  coord_cost_statusline: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost overview --format statusline" },
  coord_cost_budget_status: { canonical_tool: "coord_cost_budget", canonical_command: "claude-token-guard cost budget status" },
  coord_cost_set_budget: { canonical_tool: "coord_cost_budget", canonical_command: "claude-token-guard cost budget set" },
  coord_cost_session: { canonical_tool: "coord_cost_sessions", canonical_command: "claude-token-guard cost sessions show" },
  coord_cost_team: { canonical_tool: "coord_cost_teams", canonical_command: "claude-token-guard cost teams show" },
  coord_cost_spend_leaderboard: { canonical_tool: "coord_cost_teams", canonical_command: "claude-token-guard cost teams leaderboard" },
  coord_cost_trends: { canonical_tool: "coord_ops_trends", canonical_command: "claude-token-guard ops trends" },
  coord_cost_anomaly_check: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind anomaly" },
  coord_cost_burn_rate_check: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind burn-rate" },
  coord_cost_burn_projection: { canonical_tool: "coord_ops_trends", canonical_command: "claude-token-guard ops trends" },
  coord_cost_anomalies: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts status" },
  coord_cost_daily_report_generate: { canonical_tool: "coord_ops_today", canonical_command: "claude-token-guard ops today --markdown" },
};

function applyLegacyDeprecationToOutput(toolName, data) {
  if (!(toolName in LEGACY_COST_DEPRECATIONS)) return data;
  const raw = typeof data === "string" ? data : String(data ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.deprecated = true;
      parsed.canonical_tool = LEGACY_COST_DEPRECATIONS[toolName].canonical_tool;
      parsed.canonical_command = LEGACY_COST_DEPRECATIONS[toolName].canonical_command;
      return JSON.stringify(parsed, null, 2);
    }
  } catch {}
  return `${raw}\n\n[DEPRECATED]\ncanonical_tool=${LEGACY_COST_DEPRECATIONS[toolName].canonical_tool}\ncanonical_command=${LEGACY_COST_DEPRECATIONS[toolName].canonical_command}\n`;
}

function withEnvelope(tool, startedAt, requestId, producer) {
  const envelopeEnabled = process.env.CLAUDE_COORDINATOR_RESULT_ENVELOPE === "1";
  const warnings = [];
  const data = applyLegacyDeprecationToOutput(tool, producer());
  if (!envelopeEnabled) return text(data);
  return text(JSON.stringify({
    ok: true,
    data: { text: data },
    error: null,
    meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings },
  }, null, 2));
}

function runPythonScriptTool(toolName, scriptName, argv = [], timeoutMs = 30000) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  return withEnvelope(toolName, startedAt, requestId, () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const scriptPath = join(home, ".claude", "scripts", scriptName);
    return execFileSync("python3", [scriptPath, ...argv], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  });
}

// ─────────────────────────────────────────────────────────
// SERVER SETUP
// ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "coordinator", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─────────────────────────────────────────────────────────
// TOOL DEFINITIONS (declarative schemas — no logic to test)
// ─────────────────────────────────────────────────────────

/* c8 ignore start — tool schemas are declarative data, tested via dispatch */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "coord_list_sessions",
      description: "List all Claude Code sessions. Shows enriched data: tool_counts, files_touched, recent_ops. Cross-platform.",
      inputSchema: {
        type: "object",
        properties: {
          include_closed: { type: "boolean", description: "Include closed sessions (default: false)" },
          project: { type: "string", description: "Filter by project name" },
        },
      },
    },
    {
      name: "coord_get_session",
      description: "Get detailed info about a session including enriched metadata, plan file, and recent prompts.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "First 8 chars of the session ID" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "coord_check_inbox",
      description: "Check and retrieve pending messages for a session.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID (first 8 chars)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "coord_detect_conflicts",
      description: "Detect file conflicts across sessions using both current_files and files_touched from enriched session data.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Your session ID" },
          files: { type: "array", items: { type: "string" }, description: "File paths to check" },
        },
        required: ["session_id", "files"],
      },
    },
    {
      name: "coord_spawn_terminal",
      description: "Open a new interactive Claude Code terminal. Cross-platform: macOS (iTerm2/Terminal.app), Windows (Windows Terminal/cmd), Linux (gnome-terminal/konsole/kitty/etc).",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory to open in" },
          initial_prompt: { type: "string", description: "Optional initial prompt for the new terminal" },
          layout: { type: "string", enum: ["tab", "split"], description: "'tab' (default) or 'split' (side-by-side where supported: iTerm2, Windows Terminal, kitty)" },
        },
        required: ["directory"],
      },
    },
    {
      name: "coord_spawn_worker",
      description: "Spawn a worker in pipe mode (fire-and-forget) or interactive mode (lead can message mid-execution). Returns task_id.",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Working directory" },
          prompt: { type: "string", description: "Full task instructions (worker has no prior context)" },
          model: { type: "string", description: "Model (default: sonnet)" },
          agent: { type: "string", description: "Agent name (optional)" },
          task_id: { type: "string", description: "Custom task ID (auto-generated if not provided)" },
          mode: { type: "string", enum: ["pipe", "interactive"], description: "pipe (fire-and-forget, cheapest) or interactive (lead can message mid-execution via inbox hooks, 3-5x more tokens). Default: pipe" },
          runtime: { type: "string", enum: ["claude", "codex"], description: "claude (Claude Code CLI, default) or codex (OpenAI Codex CLI — uses ChatGPT Plus plan). Default: claude" },
          notify_session_id: { type: "string", description: "Session ID (first 8 chars) to receive worker completion inbox notifications." },
          session_id: { type: "string", description: "Alias for notify_session_id (first 8 chars)." },
          files: { type: "array", items: { type: "string" }, description: "Files to edit (checked for conflicts)" },
          layout: { type: "string", enum: ["tab", "split", "background"], description: "'tab', 'split', or 'background' (no terminal, fastest spawn)" },
          isolate: { type: "boolean", description: "Create git worktree for isolated execution (default: false)" },
          role: { type: "string", enum: ["researcher", "implementer", "reviewer", "planner"], description: "Role preset. Applies default model/agent/permission/isolation unless explicitly overridden." },
          require_plan: { type: "boolean", description: "Require worker to submit plan for approval before editing files. ENFORCED by hook — Edit/Write/Bash physically blocked until approved. (default: false). Alias: use permission_mode='planOnly'." },
          permission_mode: { type: "string", enum: ["acceptEdits", "planOnly", "readOnly", "editOnly"], description: "Worker permission mode. acceptEdits (default, full access), planOnly (plan approval required before edits), readOnly (Read/Grep/Glob only — for research workers), editOnly (Read/Edit/Write only, no Bash — safe editing). ENFORCED by hook." },
          context_level: { type: "string", enum: ["minimal", "standard", "full"], description: "How much prior context to include: minimal (3KB), standard (10KB + lead files), full (30KB + plan + lead context). Default: minimal" },
          budget_policy: { type: "string", enum: ["off", "warn", "enforce"], description: "Budget behavior for estimated token spend. off=ignore, warn=annotate, enforce=reject over-budget spawns. Default: warn" },
          budget_tokens: { type: "integer", description: "Estimated token budget cap for this worker (default from COORDINATOR_WORKER_BUDGET_TOKENS or 60000)." },
          global_budget_policy: { type: "string", enum: ["off", "warn", "enforce"], description: "Global fleet budget policy for active workers. enforce blocks spawn when global limits are exceeded. Default from COORDINATOR_GLOBAL_BUDGET_POLICY or warn." },
          global_budget_tokens: { type: "integer", description: "Global estimated token cap across active workers (default from COORDINATOR_GLOBAL_BUDGET_TOKENS or 240000)." },
          max_active_workers: { type: "integer", description: "Global max concurrent running workers (default from COORDINATOR_MAX_ACTIVE_WORKERS or 8)." },
          team_name: { type: "string", description: "Team name — enables peer messaging and shared context" },
          worker_name: { type: "string", description: "Human-readable worker name for name-based messaging (e.g., 'alpha', 'reviewer'). Workers can be messaged by name instead of session ID." },
          max_turns: { type: "integer", description: "Maximum tool calls before auto-termination. Worker is killed when limit reached." },
          context_summary: { type: "string", description: "Lead's conversation context summary. Injected into worker prompt so worker inherits lead's knowledge. Use this to share decisions, requirements, and findings." },
        },
        required: ["directory", "prompt"],
      },
    },
    {
      name: "coord_spawn_workers",
      description: "Spawn multiple workers in parallel from a single call. Fastest way to launch N workers. Each entry uses same params as coord_spawn_worker.",
      inputSchema: {
        type: "object",
        properties: {
          workers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                directory: { type: "string" },
                prompt: { type: "string" },
                model: { type: "string" },
                agent: { type: "string" },
                task_id: { type: "string" },
                mode: { type: "string", enum: ["pipe", "interactive"] },
                runtime: { type: "string", enum: ["claude", "codex"] },
                notify_session_id: { type: "string" },
                worker_name: { type: "string" },
                max_turns: { type: "integer" },
                context_summary: { type: "string" },
                layout: { type: "string", enum: ["tab", "split", "background"] },
                isolate: { type: "boolean" },
                role: { type: "string", enum: ["researcher", "implementer", "reviewer", "planner"] },
                require_plan: { type: "boolean" },
                context_level: { type: "string", enum: ["minimal", "standard", "full"] },
                budget_policy: { type: "string", enum: ["off", "warn", "enforce"] },
                budget_tokens: { type: "integer" },
                global_budget_policy: { type: "string", enum: ["off", "warn", "enforce"] },
                global_budget_tokens: { type: "integer" },
                max_active_workers: { type: "integer" },
                team_name: { type: "string" },
              },
              required: ["directory", "prompt"],
            },
            description: "Array of worker configurations (max 10)",
          },
        },
        required: ["workers"],
      },
    },
    {
      name: "coord_get_result",
      description: "Check worker output and completion status.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID from coord_spawn_worker" },
          tail_lines: { type: "number", description: "Lines from end to return (default: 100)" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_wake_session",
      description: "Wake an idle session. macOS: AppleScript by tty/title. Linux: direct safe TTY write when available. Windows: AppActivate+SendKeys best effort. All platforms fallback to urgent inbox message.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID (first 8 chars)" },
          message: { type: "string", description: "Text to send to the session (delivered via inbox; terminal gets Enter keystroke only)" },
        },
        required: ["session_id", "message"],
      },
    },
    {
      name: "coord_kill_worker",
      description: "Kill a running worker. Cross-platform (kill on Unix, taskkill on Windows).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the worker to kill" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_resume_worker",
      description: "Resume a dead/failed worker. Reads its prior output and original prompt, spawns a new worker with continuation context.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the dead worker to resume" },
          mode: { type: "string", enum: ["pipe", "interactive"], description: "Mode for the resumed worker (default: same as original)" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_upgrade_worker",
      description: "Upgrade a pipe (deaf) worker to interactive mode. Kills the pipe worker and respawns with message-receiving capability, carrying over progress.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the pipe worker to upgrade" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_run_pipeline",
      description: "Run a sequence of tasks as a pipeline. Each step runs after the previous completes.",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Working directory" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                prompt: { type: "string" },
                model: { type: "string" },
                agent: { type: "string" },
              },
              required: ["name", "prompt"],
            },
          },
          pipeline_id: { type: "string" },
        },
        required: ["directory", "tasks"],
      },
    },
    {
      name: "coord_get_pipeline",
      description: "Check pipeline status and read step outputs.",
      inputSchema: {
        type: "object",
        properties: {
          pipeline_id: { type: "string", description: "Pipeline ID" },
        },
        required: ["pipeline_id"],
      },
    },
    // ── Task Board ──
    {
      name: "coord_create_task",
      description: "Create a task on the shared task board with subject, description, assignee, and dependency tracking.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Task title (required)" },
          description: { type: "string", description: "Detailed task description" },
          task_id: { type: "string", description: "Custom task ID (auto-generated if omitted)" },
          assignee: { type: "string", description: "Worker/session name to assign to" },
          priority: { type: "string", enum: ["low", "normal", "high"], description: "Priority (default: normal)" },
          files: { type: "array", items: { type: "string" }, description: "Files this task will touch" },
          blocked_by: { type: "array", items: { type: "string" }, description: "Task IDs that must complete first" },
          team_name: { type: "string", description: "Team this task belongs to (optional, enables team task views)" },
          metadata: { type: "object", description: "Arbitrary key-value metadata (any JSON object)" },
        },
        required: ["subject"],
      },
    },
    {
      name: "coord_update_task",
      description: "Update a task: change status, assignee, add dependencies, merge metadata.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "New status" },
          assignee: { type: "string", description: "New assignee (empty string to unassign)" },
          subject: { type: "string", description: "New subject" },
          description: { type: "string", description: "New description" },
          team_name: { type: "string", description: "Team name (set empty string to clear)" },
          priority: { type: "string", enum: ["low", "normal", "high"], description: "New priority" },
          add_blocked_by: { type: "array", items: { type: "string" }, description: "Add dependency on these task IDs" },
          add_blocks: { type: "array", items: { type: "string" }, description: "This task blocks these task IDs" },
          metadata: { type: "object", description: "Merge key-value metadata. Set key to null to delete it." },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_list_tasks",
      description: "List all tasks on the task board, with dependency and blocker info.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status" },
          assignee: { type: "string", description: "Filter by assignee" },
          team_name: { type: "string", description: "Filter by team_name" },
        },
      },
    },
    {
      name: "coord_get_task",
      description: "Get full details of a task including description, files, and dependencies.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    // ── C1: Task Reassignment ──
    {
      name: "coord_reassign_task",
      description: "Reassign an in-progress task to a different team member. Creates a handoff snapshot and audit trail entry.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to reassign" },
          new_assignee: { type: "string", description: "Name of the new assignee" },
          reason: { type: "string", description: "Reason for reassignment" },
          progress_context: { type: "string", description: "Summary of progress so far for handoff" },
        },
        required: ["task_id", "new_assignee"],
      },
    },
    // ── C2: Audit Trail ──
    {
      name: "coord_get_task_audit",
      description: "Get the full audit trail for a task — all state changes, assignments, reassignments, and handoffs.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    // ── C3: Quality Gates ──
    {
      name: "coord_check_quality_gates",
      description: "Check quality gates and acceptance criteria status for a task.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to check" },
        },
        required: ["task_id"],
      },
    },
    // ── Teams ──
    {
      name: "coord_create_team",
      description: "Create or update a team with members, roles, and project info. Persists across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Team name (required)" },
          project: { type: "string", description: "Project name" },
          description: { type: "string", description: "Team purpose" },
          preset: { type: "string", enum: ["simple", "strict", "native-first"], description: "Apply a team preset for lower setup (simple/native-first) or strict controlled execution." },
          execution_path: { type: "string", enum: ["native", "coordinator", "hybrid"], description: "Preferred execution path for this team." },
          low_overhead_mode: { type: "string", enum: ["simple", "advanced"], description: "simple reduces setup/controls; advanced enables full coordinator policy surface." },
          policy: {
            type: "object",
            description: "Team-level defaults/enforcement for worker spawns. Supported keys: permission_mode, require_plan, default_mode, default_runtime, default_context_level, budget_policy, budget_tokens, global_budget_policy, global_budget_tokens, max_active_workers, default_isolate",
          },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" },
                session_id: { type: "string" },
                task_id: { type: "string" },
              },
              required: ["name"],
            },
            description: "Team members to add/update",
          },
        },
        required: ["team_name"],
      },
    },
    {
      name: "coord_get_team",
      description: "Get team composition, members, and their assigned work.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Team name" },
        },
        required: ["team_name"],
      },
    },
    {
      name: "coord_list_teams",
      description: "List all teams.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "coord_team_dispatch",
      description: "Create a team-scoped task and dispatch a worker using team policy defaults in one call.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Existing team name" },
          subject: { type: "string", description: "Task title for the team task board" },
          prompt: { type: "string", description: "Worker prompt" },
          directory: { type: "string", description: "Worker working directory" },
          description: { type: "string" },
          assignee: { type: "string", description: "Preferred team member name (auto-picked if omitted)" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          files: { type: "array", items: { type: "string" } },
          blocked_by: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
          create_task: { type: "boolean", description: "Create a task board record (default true)" },
          task_id: { type: "string", description: "Optional explicit task board ID" },
          worker_task_id: { type: "string", description: "Optional explicit worker task ID" },
          model: { type: "string" },
          agent: { type: "string" },
          role: { type: "string", enum: ["researcher", "implementer", "reviewer", "planner"] },
          mode: { type: "string", enum: ["pipe", "interactive"] },
          runtime: { type: "string", enum: ["claude", "codex"] },
          layout: { type: "string", enum: ["tab", "split", "background"] },
          isolate: { type: "boolean" },
          worker_name: { type: "string" },
          notify_session_id: { type: "string" },
          require_plan: { type: "boolean" },
          permission_mode: { type: "string", enum: ["acceptEdits", "planOnly", "readOnly", "editOnly"] },
          context_level: { type: "string", enum: ["minimal", "standard", "full"] },
          budget_policy: { type: "string", enum: ["off", "warn", "enforce"] },
          budget_tokens: { type: "integer" },
          global_budget_policy: { type: "string", enum: ["off", "warn", "enforce"] },
          global_budget_tokens: { type: "integer" },
          max_active_workers: { type: "integer" },
          max_turns: { type: "integer" },
          context_summary: { type: "string" },
        },
        required: ["team_name", "subject", "prompt", "directory"],
      },
    },
    {
      name: "coord_team_status_compact",
      description: "High-signal operational team summary for action panels: members, presence/load, queued tasks, blockers, policy state.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Existing team name" },
        },
        required: ["team_name"],
      },
    },
    {
      name: "coord_team_queue_task",
      description: "Queue a team task without dispatching a worker yet. Stores dispatch prompt and affinity metadata for later assignment.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          subject: { type: "string" },
          prompt: { type: "string", description: "Dispatch prompt to use later when assigning" },
          description: { type: "string" },
          task_id: { type: "string" },
          assignee: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          files: { type: "array", items: { type: "string" } },
          blocked_by: { type: "array", items: { type: "string" } },
          role_hint: { type: "string", description: "Preferred role for assignment (e.g. reviewer)" },
          load_affinity: { type: "string", enum: ["research", "implement", "review", "plan"] },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
        },
        required: ["team_name", "subject", "prompt"],
      },
    },
    {
      name: "coord_team_assign_next",
      description: "Select the best teammate for the next queued team task using deterministic load-aware scoring, then dispatch it.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          assignee: { type: "string", description: "Force a specific assignee instead of auto-scoring" },
          directory: { type: "string", description: "Default working directory for queued tasks missing dispatch.directory" },
          worker_task_id: { type: "string" },
          model: { type: "string" },
          agent: { type: "string" },
          role: { type: "string", enum: ["researcher", "implementer", "reviewer", "planner"] },
          mode: { type: "string", enum: ["pipe", "interactive"] },
          runtime: { type: "string", enum: ["claude", "codex"] },
          layout: { type: "string", enum: ["tab", "split", "background"] },
          isolate: { type: "boolean" },
          notify_session_id: { type: "string" },
          context_summary: { type: "string" },
        },
        required: ["team_name"],
      },
    },
    {
      name: "coord_team_rebalance",
      description: "Re-score queued team tasks and reassign them to the best teammates. Optional dry-run and optional dispatch-next.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          limit: { type: "integer", description: "Max queued tasks to evaluate (default: all, max 50)" },
          apply: { type: "boolean", description: "Apply reassignments (default: true). Set false for dry-run." },
          dispatch_next: { type: "boolean", description: "After rebalance, dispatch the best queued task." },
          include_in_progress: { type: "boolean", description: "Include guidance for in-progress handoffs (no automatic reassignment in v1)." },
          directory: { type: "string", description: "Default working directory if dispatch_next=true" },
          worker_task_id: { type: "string" },
          mode: { type: "string", enum: ["pipe", "interactive"] },
          runtime: { type: "string", enum: ["claude", "codex"] },
          layout: { type: "string", enum: ["tab", "split", "background"] },
          isolate: { type: "boolean" },
        },
        required: ["team_name"],
      },
    },
    {
      name: "coord_sidecar_status",
      description: "Check local sidecar installation/runtime status and latest generated snapshot metadata.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    // ── Plan Approval ──
    {
      name: "coord_approve_plan",
      description: "Approve a worker's plan, allowing it to proceed with implementation.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the worker whose plan to approve" },
          message: { type: "string", description: "Optional approval note" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "coord_reject_plan",
      description: "Reject a worker's plan with feedback, requesting revision.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the worker whose plan to reject" },
          feedback: { type: "string", description: "What needs to change (required)" },
        },
        required: ["task_id", "feedback"],
      },
    },
    // ── Shutdown Protocol ──
    {
      name: "coord_shutdown_request",
      description: "Request a worker to shut down gracefully. Worker receives the request and can approve or reject. If no response within timeout, force kills. Matches Claude's shutdown_request/shutdown_response pattern.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID of the worker to shut down" },
          target_name: { type: "string", description: "Worker name (alternative to task_id)" },
          target_session: { type: "string", description: "Session ID (alternative to task_id)" },
          message: { type: "string", description: "Shutdown reason/message (default: 'Task complete, wrapping up the session.')" },
          force_timeout_seconds: { type: "integer", description: "Seconds before force kill if no response (default: 60, max: 300)" },
        },
      },
    },
    {
      name: "coord_shutdown_response",
      description: "Worker responds to a shutdown request — approve (will terminate) or reject (will continue working).",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "Shutdown request ID from the [SHUTDOWN_REQUEST:...] message" },
          approve: { type: "boolean", description: "true to approve shutdown, false to reject" },
          reason: { type: "string", description: "Reason for rejection (required if approve=false)" },
        },
        required: ["request_id", "approve"],
      },
    },
    // ── Context Store ──
    {
      name: "coord_write_context",
      description: "Store shared context (decisions, file summaries, architecture notes) that workers can read on boot.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Team name (default: 'default')" },
          key: { type: "string", description: "Context key (e.g., 'architecture', 'decisions', 'file-index')" },
          value: { type: "string", description: "Context content" },
          append: { type: "boolean", description: "Append to existing key instead of replacing (default: false)" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "coord_read_context",
      description: "Read shared context for a team. Workers use this to get lead's analysis without re-doing exploration. Set include_lead=true to also get lead's exported conversation context.",
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string", description: "Team name (default: 'default')" },
          key: { type: "string", description: "Optional: specific key to read (returns all if omitted)" },
          include_lead: { type: "boolean", description: "Include lead's exported conversation context (from coord_export_context). Default: false" },
        },
      },
    },
    {
      name: "coord_export_context",
      description: "Export lead's conversation context so ALL spawned workers automatically inherit it. Call this to share your current knowledge: decisions made, files analyzed, user requirements, current state. Workers receive this context in their prompt at spawn time.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Your session ID (first 8 chars)" },
          summary: { type: "string", description: "Rich summary of your conversation context: decisions made, files analyzed, user requirements, architecture notes, current state" },
        },
        required: ["session_id", "summary"],
      },
    },
    // ── Broadcast ──
    {
      name: "coord_broadcast",
      description: "Send a message to ALL active sessions via their inboxes. Zero API tokens — file writes only.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender identifier" },
          content: { type: "string", description: "Message content" },
          priority: { type: "string", enum: ["normal", "urgent"], description: "Priority (default: normal)" },
        },
        required: ["from", "content"],
      },
    },
    // ── Send Directive (send + auto-wake) ──
    {
      name: "coord_send_directive",
      description: "Send an instruction to a worker/session mid-execution. Writes to inbox AND auto-wakes if session is idle. The lead's primary control tool for interactive workers.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender identifier" },
          to: { type: "string", description: "Target session ID (first 8 chars)" },
          content: { type: "string", description: "Instruction/directive content" },
          priority: { type: "string", enum: ["normal", "urgent"], description: "Priority (default: normal)" },
        },
        required: ["from", "to", "content"],
      },
    },
    // ── Send Message (MCP tool version) ──
    {
      name: "coord_send_message",
      description: "Send a message to a specific session's inbox. Zero API tokens — file write only. Target reads it on next tool call. Supports name-based targeting.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender identifier" },
          to: { type: "string", description: "Target session ID (first 8 chars). Use this OR target_name." },
          target_name: { type: "string", description: "Worker name to message (resolves to session ID). Use this OR to." },
          content: { type: "string", description: "Message content" },
          priority: { type: "string", enum: ["normal", "urgent"], description: "Priority (default: normal)" },
        },
        required: ["from", "content"],
      },
    },
  ],
}));
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────
// TOOL DISPATCH
// ─────────────────────────────────────────────────────────

/**
 * Route a tool call to the appropriate handler module.
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {object} MCP text response
 */
const _initializedDirs = new Set();
let _gcRan = false;
function ensureDirsOnce() {
  const { TERMINALS_DIR, INBOX_DIR, RESULTS_DIR, SESSION_CACHE_DIR } = cfg();
  const TASKS_DIR = join(TERMINALS_DIR, "tasks");
  const TEAMS_DIR = join(TERMINALS_DIR, "teams");
  const CONTEXT_DIR = join(TERMINALS_DIR, "context");
  for (const dir of [TERMINALS_DIR, INBOX_DIR, RESULTS_DIR, SESSION_CACHE_DIR, TASKS_DIR, TEAMS_DIR, CONTEXT_DIR]) {
    if (!_initializedDirs.has(dir)) {
      ensureSecureDirectory(dir);
      _initializedDirs.add(dir);
    }
  }
  // Auto-GC once per server boot
  if (!_gcRan) {
    _gcRan = true;
    try { runGC(); } catch { /* GC is best-effort */ }
  }
}

function handleToolCall(name, args = {}) {
  ensureDirsOnce();

  try {
    switch (name) {
    case "coord_list_sessions":    return handleListSessions(args);
    case "coord_get_session":      return handleGetSession(args);
    case "coord_check_inbox":      return handleCheckInbox(args);
    case "coord_detect_conflicts": return handleDetectConflicts(args);
    case "coord_spawn_terminal":   return handleSpawnTerminal(args);
    case "coord_spawn_worker":     return handleSpawnWorker(args);
    case "coord_spawn_workers":    return handleSpawnWorkers(args);
    case "coord_get_result":       return handleGetResult(args);
    case "coord_wake_session":     return handleWakeSession(args);
    case "coord_kill_worker":      return handleKillWorker(args);
    case "coord_resume_worker":    return handleResumeWorker(args);
    case "coord_upgrade_worker":   return handleUpgradeWorker(args);
    case "coord_run_pipeline":     return handleRunPipeline(args);
    case "coord_get_pipeline":     return handleGetPipeline(args);
    case "coord_create_task":      return handleCreateTask(args);
    case "coord_update_task":      return handleUpdateTask(args);
    case "coord_list_tasks":       return handleListTasks(args);
    case "coord_get_task":         return handleGetTask(args);
    case "coord_reassign_task":    return handleReassignTask(args);
    case "coord_get_task_audit":   return handleGetTaskAudit(args);
    case "coord_check_quality_gates": return handleCheckQualityGates(args);
    case "coord_create_team":      return handleCreateTeam(args);
    case "coord_get_team":         return handleGetTeam(args);
    case "coord_list_teams":       return handleListTeams(args);
    case "coord_team_dispatch":    return handleTeamDispatch(args);
    case "coord_team_status_compact": return handleTeamStatusCompact(args);
    case "coord_team_queue_task":  return handleTeamQueueTask(args);
    case "coord_team_assign_next": return handleTeamAssignNext(args);
    case "coord_team_rebalance":   return handleTeamRebalance(args);
    case "coord_sidecar_status":   return handleSidecarStatus(args);
    case "coord_approve_plan":     return handleApprovePlan(args);
    case "coord_reject_plan":      return handleRejectPlan(args);
    case "coord_shutdown_request": return handleShutdownRequest(args);
    case "coord_shutdown_response":return handleShutdownResponse(args);
    case "coord_write_context":    return handleWriteContext(args);
    case "coord_read_context":     return handleReadContext(args);
    case "coord_export_context":   return handleExportContext(args);
    case "coord_broadcast":        return handleBroadcast(args);
    case "coord_send_message":     return handleSendMessage(args);
    case "coord_send_directive":   return handleSendDirective(args);
    case "coord_team_health_report": {
      const argv = ["health-report"];
      if (args?.json) argv.push("--json");
      return runPythonScriptTool(name, "observability.py", argv, 90000);
    }
    case "coord_team_timeline_report": {
      const teamId = sanitizeName(String(args?.team_id || args?.team_name || ""));
      const argv = ["timeline", "--team", teamId];
      if (args?.hours != null) argv.push("--hours", String(args.hours));
      if (args?.json) argv.push("--json");
      return runPythonScriptTool(name, "observability.py", argv, 60000);
    }
    case "coord_ops_slo_status": {
      const argv = ["slo", "--report"];
      if (args?.json) argv.push("--json");
      return runPythonScriptTool(name, "observability.py", argv, 60000);
    }
    case "coord_ops_alerts": {
      const action = String(args?.action || "status");
      const argv = ["alerts", action];
      if (args?.json) argv.push("--json");
      if (args?.no_deliver) argv.push("--no-deliver");
      return runPythonScriptTool(name, "observability.py", argv, 60000);
    }
    case "coord_policy_validate": {
      const argv = ["validate"];
      if (args?.json) argv.push("--json");
      return runPythonScriptTool(name, "policy_engine.py", argv, 30000);
    }
    case "coord_policy_explain_gate": {
      const teamId = sanitizeName(String(args?.team_id || ""));
      const argv = ["explain-gate", "--team", teamId];
      if (args?.action) argv.push("--action", String(args.action));
      else if (args?.tool) argv.push("--tool", String(args.tool));
      else throw new Error("Provide action or tool");
      return runPythonScriptTool(name, "policy_engine.py", argv, 30000);
    }
    case "coord_report_redact": {
      const argv = ["redact", "--input", String(args?.input || "")];
      if (args?.output) argv.push("--output", String(args.output));
      if (args?.mode) argv.push("--mode", String(args.mode));
      return runPythonScriptTool(name, "policy_engine.py", argv, 30000);
    }
    default:                       return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return text(`Invalid arguments for ${name}: ${err.message}`);
  }
}

/* c8 ignore start — MCP server wiring, tested via __test__.handleToolCall */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────

/* c8 ignore start — server startup, not unit-testable */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(err => { console.error("Coordinator error:", err); process.exit(1); });
}
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────
// TEST INTERFACE (backward-compatible re-exports)
// ─────────────────────────────────────────────────────────

export const __test__ = {
  get PLATFORM() { return cfg().PLATFORM; },
  get CLAUDE_BIN() { return cfg().CLAUDE_BIN; },
  ensureDirsOnce,
  handleToolCall,
  buildWorkerScript,
  buildPlatformLaunchCommand,
  isProcessAlive,
  killProcess,
  sanitizeId,
  sanitizeShortSessionId,
  sanitizeName,
  sanitizeModel,
  sanitizeAgent,
  requireDirectoryPath,
  normalizeFilePath,
  readJSONLLimited,
  batQuote,
  runGC,
  isSafeTTYPath,
  selectWakeText,
  applyLegacyDeprecationToOutput,
  LEGACY_COST_DEPRECATIONS,
  withEnvelope,
  sleepMs,
  getSessionStatus,
  acquireExclusiveFileLock,
  enforceMessageRateLimit,
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetTask,
  handleReassignTask,
  handleGetTaskAudit,
  handleCheckQualityGates,
  handleCreateTeam,
  handleGetTeam,
  handleListTeams,
  handleTeamDispatch,
  handleTeamStatusCompact,
  handleTeamQueueTask,
  handleTeamAssignNext,
  handleTeamRebalance,
  handleSidecarStatus,
  handleSendMessage,
  handleBroadcast,
  handleSendDirective,
  buildInteractiveWorkerScript,
  buildCodexWorkerScript,
  buildCodexInteractiveWorkerScript,
  handleResumeWorker,
  handleUpgradeWorker,
  handleSpawnWorkers,
  handleApprovePlan,
  handleRejectPlan,
  handleShutdownRequest,
  handleShutdownResponse,
  handleWriteContext,
  handleReadContext,
  handleExportContext,
};
