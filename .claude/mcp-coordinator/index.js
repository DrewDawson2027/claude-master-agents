#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, unlinkSync, openSync, closeSync } from "fs";
import { join, basename } from "path";
import { homedir, platform } from "os";
import { execSync, execFileSync, spawn } from "child_process";

const TERMINALS_DIR = join(homedir(), ".claude", "terminals");
const INBOX_DIR = join(TERMINALS_DIR, "inbox");
const RESULTS_DIR = join(TERMINALS_DIR, "results");
const ACTIVITY_FILE = join(TERMINALS_DIR, "activity.jsonl");
const QUEUE_FILE = join(TERMINALS_DIR, "queue.jsonl");
const SESSION_CACHE_DIR = join(homedir(), ".claude", "session-cache");
const SETTINGS_FILE = join(homedir(), ".claude", "settings.local.json");
const TEAM_RUNTIME_SCRIPT = join(homedir(), ".claude", "scripts", "team_runtime.py");
const COST_RUNTIME_SCRIPT = join(homedir(), ".claude", "scripts", "cost_runtime.py");
const PLATFORM = platform(); // 'darwin', 'win32', 'linux'
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_CLI_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_TOKEN_LENGTH = 80;

// Ensure directories exist
mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });
mkdirSync(SESSION_CACHE_DIR, { recursive: true });

function failValidation(message) {
  const error = new Error(message);
  error.name = "ValidationError";
  throw error;
}

function validateSafeId(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    failValidation(`${label} must be a non-empty string.`);
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    failValidation(`${label} exceeds max length (${MAX_TOKEN_LENGTH}).`);
  }
  if (!SAFE_ID_RE.test(value) || value.includes("..") || value.includes("/") || value.includes("\\")) {
    failValidation(`${label} contains unsafe characters. Allowed: A-Z a-z 0-9 . _ -`);
  }
  return value;
}

function validateSafeCliToken(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") failValidation(`${label} must be a string.`);
  if (value.length > MAX_TOKEN_LENGTH) failValidation(`${label} exceeds max length (${MAX_TOKEN_LENGTH}).`);
  if (!SAFE_CLI_RE.test(value) || value.startsWith("-")) {
    failValidation(`${label} contains unsafe characters. Allowed: A-Z a-z 0-9 . _ : -`);
  }
  return value;
}

function sanitizeStepName(name, index) {
  if (typeof name !== "string" || name.length === 0) {
    failValidation(`Task at step ${index} must include a non-empty name.`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    failValidation(`Task name at step ${index} contains path separators or traversal.`);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || `step-${index}`;
}

function normalizePid(rawPid) {
  const pid = Number.parseInt(String(rawPid), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

function buildClaudeArgs(model, agent, settingsFile = SETTINGS_FILE) {
  const args = ["-p", "--model", model];
  if (agent) args.push("--agent", agent);
  if (existsSync(settingsFile)) args.push("--settings", settingsFile);
  return args;
}

function getChildEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function runClaudeDetached({ cwd, promptFile, outputFile, model, agent, onExit }) {
  const args = buildClaudeArgs(model, agent);
  const stdinFd = openSync(promptFile, "r");
  const stdoutFd = openSync(outputFile, "a");
  const stderrFd = openSync(outputFile, "a");

  const child = spawn("claude", args, {
    cwd,
    env: getChildEnv(),
    detached: true,
    stdio: [stdinFd, stdoutFd, stderrFd],
  });

  closeSync(stdinFd);
  closeSync(stdoutFd);
  closeSync(stderrFd);

  child.on("exit", (code, signal) => {
    if (typeof onExit === "function") onExit(code, signal);
  });
  child.on("error", () => {
    if (typeof onExit === "function") onExit(1, "spawn-error");
  });
  child.unref();
  return child;
}

function runClaudeStep({ cwd, promptFile, outputFile, model, agent }) {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(model, agent);
    const stdinFd = openSync(promptFile, "r");
    const stdoutFd = openSync(outputFile, "w");
    const stderrFd = openSync(outputFile, "a");

    const child = spawn("claude", args, {
      cwd,
      env: getChildEnv(),
      stdio: [stdinFd, stdoutFd, stderrFd],
    });

    closeSync(stdinFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);

    child.on("error", (err) => reject(err));
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`claude exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    });
  });
}

// ─────────────────────────────────────────────────────────
// CROSS-PLATFORM: Terminal detection & command execution
// ─────────────────────────────────────────────────────────

function getTerminalApp() {
  if (PLATFORM === "darwin") {
    try { execSync("pgrep -x iTerm2", { stdio: "ignore" }); return "iTerm2"; } catch {}
    try { execSync("pgrep -x Terminal", { stdio: "ignore" }); return "Terminal"; } catch {}
    return "none";
  } else if (PLATFORM === "win32") {
    // Windows Terminal > PowerShell > cmd
    try { execSync("tasklist /FI \"IMAGENAME eq WindowsTerminal.exe\" /NH | findstr WindowsTerminal", { stdio: "ignore" }); return "WindowsTerminal"; } catch {}
    try { execSync("tasklist /FI \"IMAGENAME eq powershell.exe\" /NH | findstr powershell", { stdio: "ignore" }); return "PowerShell"; } catch {}
    return "cmd";
  } else {
    // Linux: check common terminal emulators
    for (const app of ["gnome-terminal", "konsole", "alacritty", "kitty", "xterm"]) {
      try { execSync(`pgrep -x ${app}`, { stdio: "ignore" }); return app; } catch {}
    }
    return "none";
  }
}

// Open a new terminal pane/tab with a command. Cross-platform.
// layout: "tab" (default) or "split" (vertical split where supported)
function openTerminalWithCommand(command, layout = "tab") {
  const termApp = getTerminalApp();

  if (PLATFORM === "darwin") {
    const escapedCmd = command.replace(/"/g, '\\"');
    if (termApp === "iTerm2") {
      if (layout === "split") {
        execSync(
          `osascript -e 'tell application "iTerm2" to tell current session of current window to split vertically with default profile' -e 'tell application "iTerm2" to tell current session of current window to write text "${escapedCmd}"'`,
          { timeout: 5000 }
        );
      } else {
        execSync(
          `osascript -e 'tell application "iTerm2" to tell current window to create tab with default profile' -e 'tell application "iTerm2" to tell current session of current window to write text "${escapedCmd}"'`,
          { timeout: 5000 }
        );
      }
      return termApp;
    } else if (termApp === "Terminal") {
      execSync(
        `osascript -e 'tell application "Terminal" to do script "${escapedCmd}"'`,
        { timeout: 5000 }
      );
      return termApp;
    }
    // macOS fallback: nohup background
    execSync(`nohup bash -c '${command.replace(/'/g, "'\\''")}' &>/dev/null &`, { timeout: 5000 });
    return "background";

  } else if (PLATFORM === "win32") {
    // Windows: use 'start' to open a new window
    const escapedCmd = command.replace(/"/g, '""');
    if (termApp === "WindowsTerminal") {
      // Windows Terminal: new tab with 'wt' command
      if (layout === "split") {
        execSync(`wt -w 0 sp -V cmd /c "${escapedCmd}"`, { timeout: 5000, shell: true });
      } else {
        execSync(`wt -w 0 nt cmd /c "${escapedCmd}"`, { timeout: 5000, shell: true });
      }
      return "WindowsTerminal";
    } else {
      // PowerShell or cmd: open new window
      execSync(`start cmd /c "${escapedCmd}"`, { timeout: 5000, shell: true });
      return "cmd";
    }

  } else {
    // Linux: try terminal emulators, fall back to nohup
    if (termApp === "gnome-terminal") {
      execSync(`gnome-terminal -- bash -c '${command.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      return termApp;
    } else if (termApp === "konsole") {
      execSync(`konsole -e bash -c '${command.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      return termApp;
    } else if (termApp === "alacritty") {
      execSync(`alacritty -e bash -c '${command.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      return termApp;
    } else if (termApp === "kitty") {
      if (layout === "split") {
        execSync(`kitty @ launch --type=window bash -c '${command.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      } else {
        execSync(`kitty @ launch --type=tab bash -c '${command.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      }
      return termApp;
    }
    // Linux fallback: nohup background
    execSync(`nohup bash -c '${command.replace(/'/g, "'\\''")}' &>/dev/null &`, { timeout: 5000 });
    return "background";
  }
}

// Cross-platform process check
function isProcessAlive(pid) {
  const safePid = normalizePid(pid);
  if (!safePid) return false;
  try {
    if (PLATFORM === "win32") {
      execSync(`tasklist /FI "PID eq ${safePid}" /NH | findstr ${safePid}`, { stdio: "ignore" });
    } else {
      execSync(`kill -0 ${safePid} 2>/dev/null`);
    }
    return true;
  } catch {
    return false;
  }
}

// Cross-platform process kill
function killProcess(pid) {
  const safePid = normalizePid(pid);
  if (!safePid) failValidation("Invalid PID.");
  if (PLATFORM === "win32") {
    execSync(`taskkill /PID ${safePid} /T /F 2>nul`, { shell: true });
  } else {
    try { execSync(`kill -TERM -${safePid} 2>/dev/null`); } catch {
      execSync(`kill -TERM ${safePid} 2>/dev/null`);
    }
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function parseConcatenatedJsonObjects(raw) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function readJSONL(path) {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return [];

    const lines = raw.split("\n").filter(Boolean);
    const parsedLines = [];
    let allLinesValid = true;
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        allLinesValid = false;
        break;
      }
    }
    if (allLinesValid) return parsedLines;

    const chunks = parseConcatenatedJsonObjects(raw);
    return chunks
      .map((chunk) => {
        try { return JSON.parse(chunk); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function appendJSONLine(path, payload) {
  appendFileSync(path, `${JSON.stringify(payload)}\n`);
}

async function runPipelineInBackground({ pipelineId, pipelineDir, directory, tasks, metaFile }) {
  const logFile = join(pipelineDir, "pipeline.log");
  try {
    for (const task of tasks) {
      appendJSONLine(logFile, {
        step: task.step,
        slug: task.slug,
        name: task.name,
        status: "running",
        started: new Date().toISOString(),
      });

      const promptFile = join(pipelineDir, `${task.step}-${task.slug}.prompt`);
      const resultFile = join(pipelineDir, `${task.step}-${task.slug}.txt`);
      await runClaudeStep({
        cwd: directory,
        promptFile,
        outputFile: resultFile,
        model: task.model,
        agent: task.agent || null,
      });

      appendJSONLine(logFile, {
        step: task.step,
        slug: task.slug,
        name: task.name,
        status: "completed",
        finished: new Date().toISOString(),
      });
    }

    writeFileSync(join(pipelineDir, "pipeline.done"), JSON.stringify({
      status: "completed",
      finished: new Date().toISOString(),
      pipeline_id: pipelineId,
    }, null, 2));
    if (metaFile && existsSync(metaFile)) {
      const meta = readJSON(metaFile) || {};
      meta.status = "completed";
      meta.finished = new Date().toISOString();
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    }
  } catch (err) {
    writeFileSync(join(pipelineDir, "pipeline.done"), JSON.stringify({
      status: "failed",
      finished: new Date().toISOString(),
      pipeline_id: pipelineId,
      error: err?.message || String(err),
    }, null, 2));
    if (metaFile && existsSync(metaFile)) {
      const meta = readJSON(metaFile) || {};
      meta.status = "failed";
      meta.finished = new Date().toISOString();
      meta.error = err?.message || String(err);
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    }
  }
}

function getAllSessions() {
  try {
    return readdirSync(TERMINALS_DIR)
      .filter(f => f.startsWith("session-") && f.endsWith(".json"))
      .map(f => readJSON(join(TERMINALS_DIR, f)))
      .filter(Boolean);
  } catch { return []; }
}

function getSessionStatus(session) {
  if (session.status === "closed") return "closed";
  if (session.status === "stale") return "stale";
  if (!session.last_active) return "unknown";
  const age = (Date.now() - new Date(session.last_active).getTime()) / 1000;
  if (age < 180) return "active";
  if (age < 600) return "idle";
  return "stale";
}

function timeAgo(ts) {
  if (!ts) return "unknown";
  const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

function runTeamRuntime(argv) {
  if (!existsSync(TEAM_RUNTIME_SCRIPT)) {
    throw new Error(`Team runtime script not found: ${TEAM_RUNTIME_SCRIPT}`);
  }
  try {
    const out = execFileSync("python3", [TEAM_RUNTIME_SCRIPT, ...argv], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (out || "").trim() || "(no output)";
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const stdout = err?.stdout ? String(err.stdout).trim() : "";
    throw new Error(stderr || stdout || err?.message || "team runtime command failed");
  }
}

function runCostRuntime(argv) {
  if (!existsSync(COST_RUNTIME_SCRIPT)) {
    throw new Error(`Cost runtime script not found: ${COST_RUNTIME_SCRIPT}`);
  }
  try {
    const out = execFileSync("python3", [COST_RUNTIME_SCRIPT, ...argv], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (out || "").trim() || "(no output)";
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const stdout = err?.stdout ? String(err.stdout).trim() : "";
    throw new Error(stderr || stdout || err?.message || "cost runtime command failed");
  }
}

// ─────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "coordinator", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

// Tool definitions
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
      name: "coord_send_message",
      description: "Send a message to another session via inbox hook. Works on any platform.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender ID or label like 'lead'" },
          to: { type: "string", description: "Target session ID (first 8 chars)" },
          content: { type: "string", description: "Message content" },
          priority: { type: "string", enum: ["normal", "urgent"], description: "Priority (default: normal)" },
        },
        required: ["from", "to", "content"],
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
      name: "coord_register_work",
      description: "Declare what task and files this session is working on.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Your session ID (first 8 chars)" },
          task: { type: "string", description: "Task description" },
          files: { type: "array", items: { type: "string" }, description: "Files being modified" },
        },
        required: ["session_id", "task"],
      },
    },
    {
      name: "coord_assign_task",
      description: "Add a task to the shared queue.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description" },
          project: { type: "string", description: "Project directory path" },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          scope: { type: "array", items: { type: "string" }, description: "Relevant file paths" },
          brief: { type: "string", description: "Detailed context" },
        },
        required: ["task", "project"],
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
      description: "Spawn an autonomous worker (claude -p). Cross-platform. Returns task_id for coord_get_result.",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Working directory" },
          prompt: { type: "string", description: "Full task instructions (worker has no prior context)" },
          model: { type: "string", description: "Model (default: sonnet)" },
          agent: { type: "string", description: "Agent name (optional)" },
          task_id: { type: "string", description: "Custom task ID (auto-generated if not provided)" },
          files: { type: "array", items: { type: "string" }, description: "Files to edit (checked for conflicts)" },
          layout: { type: "string", enum: ["tab", "split"], description: "'tab' or 'split'" },
          team_id: { type: "string", description: "Optional team runtime ID for auto-registration" },
          team_task_id: { type: "string", description: "Optional team task ID to attach worker completion" },
          member_id: { type: "string", description: "Optional team member owner for this worker" },
          auto_complete: { type: "boolean", description: "Auto-complete team task on worker success (default: false)" },
        },
        required: ["directory", "prompt"],
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
      description: "Wake an idle session. macOS: AppleScript injection via iTerm2/Terminal.app. Windows/Linux: falls back to inbox message with notification.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID (first 8 chars)" },
          message: { type: "string", description: "Text to send to the session" },
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
    {
      name: "coord_team_list",
      description: "List local agent teams managed by the tmux-backed team runtime.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "coord_team_create",
      description: "Create a local agent team with lead member metadata.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "Stable team ID (slug). Optional; auto-derived from name." },
          name: { type: "string", description: "Team display name" },
          description: { type: "string", description: "Team description" },
          lead_session_id: { type: "string", description: "Optional existing lead session ID (first 8 chars)" },
          lead_member_id: { type: "string", description: "Lead member ID (default: lead)" },
          lead_name: { type: "string", description: "Lead display name" },
          cwd: { type: "string", description: "Working directory for lead/team tmux session" },
        },
        required: ["name"],
      },
    },
    {
      name: "coord_team_start",
      description: "Start team runtime and ensure tmux session exists for in-process teammates.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          cwd: { type: "string", description: "Override working directory for tmux session" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_stop",
      description: "Stop a team runtime and optionally kill its tmux panes/session.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          kill_panes: { type: "boolean", description: "Kill tmux session/panes (default false)" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_status",
      description: "Show team status, members, tmux session, and optional task summary.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          include_tasks: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_add_member",
      description: "Add a member to a local team (session/pane/worker metadata).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
          name: { type: "string" },
          role: { type: "string" },
          kind: { type: "string", enum: ["session", "pane", "worker"] },
          session_id: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_attach_session",
      description: "Attach an existing Claude session ID to a team member (manual fallback to auto-attach).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
          session_id: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["team_id", "member_id", "session_id"],
      },
    },
    {
      name: "coord_team_spawn_teammate",
      description: "Spawn an in-process teammate in a tmux split pane and auto-attach on session start.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
          cwd: { type: "string", description: "Working directory for teammate pane" },
          name: { type: "string" },
          role: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          initial_prompt: { type: "string" },
        },
        required: ["team_id", "member_id", "cwd"],
      },
    },
    {
      name: "coord_team_focus",
      description: "Focus/select a teammate pane (tmux) or return guidance for session-backed teammates.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
        },
        required: ["team_id", "member_id"],
      },
    },
    {
      name: "coord_team_interrupt",
      description: "Interrupt a teammate directly (tmux Ctrl-C or SIGINT/inbox fallback for session-backed members).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
          message: { type: "string", description: "Optional follow-up message after interrupt" },
        },
        required: ["team_id", "member_id"],
      },
    },
    {
      name: "coord_team_send_peer",
      description: "Peer-to-peer team message with automatic delivery to teammate inbox/mailbox.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          from_member: { type: "string" },
          to_member: { type: "string" },
          content: { type: "string" },
          priority: { type: "string", enum: ["normal", "urgent"] },
        },
        required: ["team_id", "from_member", "to_member", "content"],
      },
    },
    {
      name: "coord_team_add_task",
      description: "Add a team task with dependency list and file scope.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          assignee: { type: "string" },
          created_by: { type: "string" },
        },
        required: ["team_id", "title"],
      },
    },
    {
      name: "coord_team_list_tasks",
      description: "List team tasks and claim/dependency state.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          status: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_claim_task",
      description: "Claim a task (checks dependencies and file claim conflicts unless force=true).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["team_id", "task_id", "member_id"],
      },
    },
    {
      name: "coord_team_update_task",
      description: "Update task status and emit TaskCompleted events when completed.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          status: { type: "string", enum: ["pending", "blocked", "claimed", "in_progress", "completed", "cancelled"] },
          member_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["team_id", "task_id", "status"],
      },
    },
    {
      name: "coord_team_check_events",
      description: "Read team hook events (TeammateIdle, TaskCompleted, etc.) with optional consumer cursor.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          types: { type: "string", description: "Comma-separated event types filter" },
          since_id: { type: "number" },
          consumer: { type: "string", description: "Cursor name to read only new events (e.g., lead)" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_recover_hard",
      description: "Run resume + reconcile + doctor + dashboard + cost snapshot and write a recovery snapshot file.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          ensure_tmux: { type: "boolean" },
          keep_events: { type: "number" },
          include_workers: { type: "boolean" },
          snapshot_window: { type: "string", enum: ["today", "week", "month", "active_block"] },
          cost_timeout: { type: "number" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_recover",
      description: "Run team resume + reconcile + doctor in one command for recovery.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          ensure_tmux: { type: "boolean" },
          keep_events: { type: "number" },
          include_workers: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_resume",
      description: "Resume/reconcile a team runtime from existing tmux/session state.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          ensure_tmux: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_doctor",
      description: "Run consistency checks for team runtime (tmux, members, claims, cursors).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_dashboard",
      description: "Show a text dashboard of members, tasks, recent events, and cost (if available).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_bootstrap",
      description: "Create/start a team and optionally spawn standard tmux pane teammates.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          lead_session_id: { type: "string" },
          lead_member_id: { type: "string" },
          lead_name: { type: "string" },
          cwd: { type: "string" },
          preset: { type: "string", enum: ["lite", "standard", "heavy", "auto"] },
          teammates: { type: "array", items: { type: "string" }, description: "memberId[:role[:cwd]] entries" },
        },
        required: ["name"],
      },
    },
    {
      name: "coord_team_teardown",
      description: "Stop a team and write a teardown summary snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          kill_panes: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_ack_message",
      description: "Acknowledge a team peer message receipt.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          message_id: { type: "string" },
          member_id: { type: "string" },
        },
        required: ["team_id", "message_id", "member_id"],
      },
    },
    {
      name: "coord_team_release_claim",
      description: "Release a task file claim with audit event.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["team_id", "task_id"],
      },
    },
    {
      name: "coord_team_reconcile",
      description: "Reconcile stale claims, compact events, and optionally worker completions.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          keep_events: { type: "number" },
          include_workers: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_register_worker",
      description: "Register a detached worker task to a team/member/task mapping.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          worker_task_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          auto_complete: { type: "boolean" },
        },
        required: ["team_id", "worker_task_id"],
      },
    },
    {
      name: "coord_team_attach_worker_result",
      description: "Attach a worker result to an existing team worker mapping.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          worker_task_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
        },
        required: ["team_id", "worker_task_id"],
      },
    },
    {
      name: "coord_cost_summary",
      description: "Cost summary (/cost-equivalent) using ccusage + local log fallback.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["today", "week", "month", "active_block", "custom"] },
          since: { type: "string" },
          until: { type: "string" },
          team_id: { type: "string" },
          session_id: { type: "string" },
          project: { type: "string" },
          breakdown: { type: "boolean" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_session",
      description: "Cost summary for a specific Claude session.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          window: { type: "string", enum: ["today", "week", "month", "active_block", "custom"] },
          since: { type: "string" },
          until: { type: "string" },
          json: { type: "boolean" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "coord_cost_team",
      description: "Cost rollup for a team with local member/session breakdown.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          window: { type: "string", enum: ["today", "week", "month", "active_block", "custom"] },
          since: { type: "string" },
          until: { type: "string" },
          include_members: { type: "boolean" },
          json: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_cost_active_block",
      description: "Active block (5h) cost/tokens summary.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          project: { type: "string" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_statusline",
      description: "Return compact live spend statusline string (ccusage-backed with local fallback).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          session_id: { type: "string" },
          project: { type: "string" },
          cost_source: { type: "string", enum: ["auto", "ccusage", "cc", "both"] },
        },
      },
    },
    {
      name: "coord_cost_budget_status",
      description: "Budget status for global/team/project spend.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["daily", "weekly", "monthly"] },
          team_id: { type: "string" },
          project: { type: "string" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_set_budget",
      description: "Set budget thresholds for global/team/project scope.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "team", "project"] },
          period: { type: "string", enum: ["daily", "weekly", "monthly"] },
          amount_usd: { type: "number" },
          team_id: { type: "string" },
          project: { type: "string" },
        },
        required: ["scope", "period", "amount_usd"],
      },
    },
    {
      name: "coord_cost_export",
      description: "Export cost summary/report as json/csv/md.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["json", "csv", "md"] },
          window: { type: "string", enum: ["today", "week", "month", "active_block", "custom"] },
          since: { type: "string" },
          until: { type: "string" },
          team_id: { type: "string" },
          session_id: { type: "string" },
          project: { type: "string" },
        },
        required: ["format"],
      },
    },
  ],
}));

// ─────────────────────────────────────────────────────────
// TOOL EXECUTION
// ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
  switch (name) {

    // ─── LIST SESSIONS (enriched) ───
    case "coord_list_sessions": {
      const sessions = getAllSessions();
      const includeClosed = args?.include_closed ?? false;
      const projectFilter = args?.project;

      let filtered = sessions;
      if (!includeClosed) filtered = filtered.filter(s => s.status !== "closed");
      if (projectFilter) filtered = filtered.filter(s => s.project?.toLowerCase().includes(projectFilter.toLowerCase()));

      if (filtered.length === 0) return text("No active sessions found.");

      const rows = filtered.map(s => {
        const status = getSessionStatus(s);
        const lastActive = timeAgo(s.last_active);
        const tc = s.tool_counts || {};
        const tools = `${tc.Write || 0}/${tc.Edit || 0}/${tc.Bash || 0}/${tc.Read || 0}`;
        const recentFiles = (s.files_touched || []).slice(-3).map(f => basename(f)).join(", ") || "—";
        const lastOp = s.recent_ops?.length ? `${s.recent_ops[s.recent_ops.length - 1].tool} ${basename(s.recent_ops[s.recent_ops.length - 1].file || "")}` : "—";
        return `| ${s.session} | ${s.tty || "?"} | ${s.project || "?"} | ${status} | ${lastActive} | ${tools} | ${recentFiles} | ${lastOp} |`;
      });

      const table = `| Session | TTY | Project | Status | Last Active | W/E/B/R | Recent Files | Last Op |\n|---------|-----|---------|--------|-------------|---------|--------------|---------|` + "\n" + rows.join("\n");
      return text(`## Sessions (${filtered.length}) — Platform: ${PLATFORM}\n\n${table}`);
    }

    // ─── GET SESSION DETAIL (enriched) ───
    case "coord_get_session": {
      const sid = validateSafeId(args.session_id, "session_id");
      const session = readJSON(join(TERMINALS_DIR, `session-${sid}.json`));
      if (!session) return text(`Session ${sid} not found.`);

      let output = `## Session ${sid}\n\n`;
      output += `- **Project:** ${session.project}\n`;
      output += `- **Branch:** ${session.branch}\n- **CWD:** ${session.cwd}\n`;
      output += `- **Status:** ${getSessionStatus(session)}\n`;
      output += `- **TTY:** ${session.tty || "unknown"}\n`;
      output += `- **Started:** ${session.started}\n- **Last Active:** ${timeAgo(session.last_active)}\n`;
      output += `- **Task:** ${session.current_task || "not declared"}\n`;

      // Enriched data
      if (session.tool_counts) {
        const tc = session.tool_counts;
        output += `\n### Tool Usage\nWrite: ${tc.Write || 0} | Edit: ${tc.Edit || 0} | Bash: ${tc.Bash || 0} | Read: ${tc.Read || 0}\n`;
      }
      if (session.files_touched?.length) {
        output += `\n### Files Touched (${session.files_touched.length})\n`;
        session.files_touched.forEach(f => { output += `- ${f}\n`; });
      }
      if (session.recent_ops?.length) {
        output += `\n### Recent Operations\n`;
        session.recent_ops.forEach(op => { output += `- ${op.t} ${op.tool} ${op.file || ""}\n`; });
      }

      // Plan file
      if (session.plan_file && existsSync(session.plan_file)) {
        try {
          const first20 = readFileSync(session.plan_file, "utf-8").split("\n").slice(0, 20).join("\n");
          output += `\n### Active Plan\n\`\`\`\n${first20}\n\`\`\`\n`;
        } catch {}
      }

      // Inbox
      const messages = readJSONL(join(INBOX_DIR, `${sid}.jsonl`));
      output += `\n### Inbox: ${messages.length} pending message(s)\n`;

      return text(output);
    }

    // ─── SEND MESSAGE ───
    case "coord_send_message": {
      const from = typeof args.from === "string" && args.from.length ? args.from : "unknown";
      const to = validateSafeId(args.to, "to");
      const content = String(args.content ?? "");
      const priority = args.priority;
      const inboxFile = join(INBOX_DIR, `${to}.jsonl`);
      appendFileSync(inboxFile, JSON.stringify({
        ts: new Date().toISOString(), from,
        priority: priority || "normal", content,
      }) + "\n");

      const sessionFile = join(TERMINALS_DIR, `session-${to}.json`);
      if (existsSync(sessionFile)) {
        try {
          const s = readJSON(sessionFile);
          if (s) { s.has_messages = true; writeFileSync(sessionFile, JSON.stringify(s, null, 2)); }
        } catch {}
      }

      return text(`Message sent to ${to}.\nContent: "${content}"\nPriority: ${priority || "normal"}`);
    }

    // ─── CHECK INBOX ───
    case "coord_check_inbox": {
      const sid = validateSafeId(args.session_id, "session_id");
      const inboxFile = join(INBOX_DIR, `${sid}.jsonl`);
      const messages = readJSONL(inboxFile);
      if (messages.length === 0) return text("No pending messages.");

      writeFileSync(inboxFile, "");
      const sessionFile = join(TERMINALS_DIR, `session-${sid}.json`);
      if (existsSync(sessionFile)) {
        try { const s = readJSON(sessionFile); if (s) { s.has_messages = false; writeFileSync(sessionFile, JSON.stringify(s, null, 2)); } } catch {}
      }

      let output = `## ${messages.length} Message(s)\n\n`;
      messages.forEach((m, i) => {
        output += `### Message ${i + 1}${m.priority === "urgent" ? " **[URGENT]**" : ""}\n`;
        output += `- **From:** ${m.from}\n- **Time:** ${m.ts}\n- **Content:** ${m.content}\n\n`;
      });
      return text(output);
    }

    // ─── DETECT CONFLICTS (uses enriched files_touched + current_files) ───
    case "coord_detect_conflicts": {
      const session_id = args?.session_id ? validateSafeId(args.session_id, "session_id") : "unknown";
      const files = Array.isArray(args?.files) ? args.files.map(String) : [];
      if (!files?.length) return text("No files specified.");

      const sessions = getAllSessions().filter(s => s.session !== session_id && getSessionStatus(s) !== "closed");
      const conflicts = [];

      for (const s of sessions) {
        // Check both current_files (registered) and files_touched (from heartbeat)
        const theirFiles = [...(s.current_files || []), ...(s.files_touched || [])];
        if (!theirFiles.length) continue;
        const overlap = files.filter(f => theirFiles.some(sf => sf === f || basename(sf) === basename(f)));
        if (overlap.length > 0) {
          conflicts.push({ session: s.session, project: s.project, task: s.current_task || "unknown", overlapping_files: overlap });
        }
      }

      // Also check recent activity
      const recentActivity = readJSONL(ACTIVITY_FILE).slice(-100);
      const fiveMinAgo = Date.now() - 300000;
      const recentEdits = recentActivity.filter(a =>
        a.session !== session_id && new Date(a.ts).getTime() > fiveMinAgo &&
        (a.tool === "Edit" || a.tool === "Write") &&
        files.some(f => a.path === f || basename(a.path || "") === basename(f))
      );

      if (conflicts.length === 0 && recentEdits.length === 0) return text("No conflicts detected. Safe to proceed.");

      let output = "## CONFLICTS DETECTED\n\n";
      if (conflicts.length > 0) {
        output += "### Session Overlaps\n";
        conflicts.forEach(c => { output += `- **${c.session}** (${c.project}): ${c.overlapping_files.join(", ")} — "${c.task}"\n`; });
      }
      if (recentEdits.length > 0) {
        output += "\n### Recent Edits (last 5 min)\n";
        recentEdits.forEach(e => { output += `- ${e.ts} ${e.session}: ${e.tool} ${e.file}\n`; });
      }
      output += "\n**Recommendation:** Coordinate before editing these files.";

      appendJSONLine(join(TERMINALS_DIR, "conflicts.jsonl"), {
        ts: new Date().toISOString(),
        detector: session_id,
        files,
        conflicts: conflicts.map(c => c.session),
      });
      return text(output);
    }

    // ─── REGISTER WORK ───
    case "coord_register_work": {
      const session_id = validateSafeId(args.session_id, "session_id");
      const task = String(args.task ?? "");
      const files = args.files;
      const sessionFile = join(TERMINALS_DIR, `session-${session_id}.json`);
      if (!existsSync(sessionFile)) return text(`Session ${session_id} not found.`);
      const session = readJSON(sessionFile);
      if (!session) return text(`Could not read session ${session_id}.`);

      session.current_task = task;
      if (files) session.current_files = files;
      session.work_registered = new Date().toISOString();
      writeFileSync(sessionFile, JSON.stringify(session, null, 2));
      return text(`Work registered: "${task}"\nFiles: ${files?.join(", ") || "none"}`);
    }

    // ─── ASSIGN TASK ───
    case "coord_assign_task": {
      const { task, project, priority, scope, brief } = args;
      const entry = {
        id: `T${Date.now()}`, ts: new Date().toISOString(), task, project,
        priority: priority || "normal", scope: scope || [], brief: brief || "",
        status: "pending", assigned_to: null,
      };
      appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n");

      const sessions = getAllSessions().filter(s =>
        getSessionStatus(s) === "active" && s.project?.toLowerCase() === basename(project).toLowerCase()
      );
      for (const s of sessions) {
        appendFileSync(join(INBOX_DIR, `${s.session}.jsonl`),
          JSON.stringify({ ts: new Date().toISOString(), from: "coordinator", priority: priority === "critical" ? "urgent" : "normal",
            content: `New task: "${task}" (${priority || "normal"}).` }) + "\n");
      }
      return text(`Task queued: "${task}" (${entry.id})\nNotified ${sessions.length} session(s).`);
    }

    // ─── SPAWN TERMINAL (cross-platform) ───
    case "coord_spawn_terminal": {
      const { directory, initial_prompt, layout } = args;
      if (!existsSync(directory)) return text(`Directory not found: ${directory}`);

      try {
        const dir = PLATFORM === "win32" ? directory : directory.replace(/'/g, "'\\''");
        const claudeCmd = initial_prompt
          ? `claude --prompt ${PLATFORM === "win32" ? `"${initial_prompt.replace(/"/g, '""')}"` : `'${initial_prompt.replace(/'/g, "'\\''")}'`}`
          : "claude";
        const fullCmd = PLATFORM === "win32"
          ? `cd /d "${dir}" && ${claudeCmd}`
          : `cd '${dir}' && ${claudeCmd}`;

        const usedApp = openTerminalWithCommand(fullCmd, layout || "tab");
        return text(`Terminal spawned in ${directory} via ${usedApp}${layout === "split" ? " (split)" : ""}.\nWill auto-register via hooks.`);
      } catch (err) {
        return text(`Failed to spawn terminal: ${err.message}`);
      }
    }

    // ─── SPAWN WORKER (cross-platform) ───
    case "coord_spawn_worker": {
      const directory = String(args?.directory ?? "");
      const prompt = String(args?.prompt ?? "");
      const model = validateSafeCliToken(args?.model || "sonnet", "model") || "sonnet";
      const agent = validateSafeCliToken(args?.agent || null, "agent");
      const taskId = args?.task_id ? validateSafeId(args.task_id, "task_id") : `W${Date.now()}`;
      const files = Array.isArray(args?.files) ? args.files.map(String) : [];
      const layout = args?.layout || "tab";
      const teamId = args?.team_id ? validateSafeId(args.team_id, "team_id") : null;
      const teamTaskId = args?.team_task_id ? validateSafeId(args.team_task_id, "team_task_id") : null;
      const memberId = args?.member_id ? validateSafeId(args.member_id, "member_id") : null;
      const autoComplete = Boolean(args?.auto_complete);
      if (!existsSync(directory)) return text(`Directory not found: ${directory}`);
      if (!prompt.trim()) return text("Prompt is required.");

      // Conflict check
      if (files?.length) {
        const running = readdirSync(RESULTS_DIR)
          .filter(f => f.endsWith(".meta.json") && !f.includes(".done"))
          .map(f => readJSON(join(RESULTS_DIR, f)))
          .filter(m => m?.status === "running" && m.files?.length);
        for (const w of running) {
          const pidFile = join(RESULTS_DIR, `${w.task_id}.pid`);
          if (!existsSync(pidFile)) continue;
          const pid = readFileSync(pidFile, "utf-8").trim();
          if (!isProcessAlive(pid)) continue;
          const overlap = files.filter(f => w.files.includes(f));
          if (overlap.length > 0) return text(`CONFLICT: Worker ${w.task_id} editing: ${overlap.join(", ")}. Kill it first or wait.`);
        }
      }

      const resultFile = join(RESULTS_DIR, `${taskId}.txt`);
      const pidFile = join(RESULTS_DIR, `${taskId}.pid`);
      const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);

      let meta = {
        task_id: taskId, directory, prompt: prompt.slice(0, 500),
        model, agent: agent || null,
        files: files || [], spawned: new Date().toISOString(), status: "running",
      };
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));

      try {
        // Context preamble
        const cacheFile = join(SESSION_CACHE_DIR, "coder-context.md");
        let contextPreamble = "";
        if (existsSync(cacheFile)) {
          contextPreamble = `## Prior Context\n${readFileSync(cacheFile, "utf-8").slice(0, 3000)}\n\n---\n\n`;
        }
        const contextSuffix = "\n\nWhen done, write key findings to ~/.claude/session-cache/coder-context.md.";
        const promptFile = join(RESULTS_DIR, `${taskId}.prompt`);
        writeFileSync(promptFile, contextPreamble + prompt + contextSuffix);
        appendFileSync(resultFile, `Worker ${taskId} starting at ${new Date().toISOString()}\n`);

        const child = runClaudeDetached({
          cwd: directory,
          promptFile,
          outputFile: resultFile,
          model,
          agent,
          onExit: (code, signal) => {
            const finished = new Date().toISOString();
            const status = code === 0 ? "completed" : "failed";
            const donePayload = { status, finished, task_id: taskId, exit_code: code, signal };
            writeFileSync(`${metaFile}.done`, JSON.stringify(donePayload, null, 2));
            try { unlinkSync(pidFile); } catch {}
            meta = { ...meta, status, finished, exit_code: code, signal: signal || null };
            if (status === "failed") {
              meta.error = `claude exited with code ${code ?? "null"} signal ${signal ?? "none"}`;
            }
            writeFileSync(metaFile, JSON.stringify(meta, null, 2));
          },
        });
        if (!child.pid) throw new Error("Failed to spawn worker process.");
        writeFileSync(pidFile, String(child.pid));

        if (teamId) {
          const regArgs = [
            "worker", "register",
            "--team-id", teamId,
            "--worker-task-id", taskId,
          ];
          if (teamTaskId) regArgs.push("--task-id", teamTaskId);
          if (memberId) regArgs.push("--member-id", memberId);
          if (autoComplete) regArgs.push("--auto-complete");
          try {
            runTeamRuntime(regArgs);
          } catch (regErr) {
            appendFileSync(resultFile, `\\n[team-register-warning] ${regErr.message}\\n`);
          }
        }

        return text(
          `Worker spawned: **${taskId}**\n` +
          `- Directory: ${directory}\n- Model: ${model}\n- Agent: ${agent || "default"}\n` +
          `- Layout hint: ${layout} (runs detached via spawn)\n- Platform: ${PLATFORM}\n` +
          `- PID: ${child.pid}\n` +
          `- Files: ${files?.join(", ") || "none"}\n- Results: ${resultFile}\n` +
          `${teamId ? `- Team: ${teamId} task=${teamTaskId || "—"} member=${memberId || "—"} auto_complete=${autoComplete}\n` : ""}\n` +
          `Check: \`coord_get_result task_id="${taskId}"\``
        );
      } catch (err) {
        meta.status = "failed"; meta.error = err.message;
        writeFileSync(metaFile, JSON.stringify(meta, null, 2));
        return text(`Failed to spawn worker: ${err.message}`);
      }
    }

    // ─── GET RESULT ───
    case "coord_get_result": {
      const task_id = validateSafeId(args.task_id, "task_id");
      const tail_lines = args.tail_lines;
      const resultFile = join(RESULTS_DIR, `${task_id}.txt`);
      const pidFile = join(RESULTS_DIR, `${task_id}.pid`);
      const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);
      const doneFile = `${metaFile}.done`;

      const meta = readJSON(metaFile);
      if (!meta) return text(`Task ${task_id} not found.`);

      const isDone = existsSync(doneFile);
      let isRunning = false;
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf-8").trim();
        isRunning = isProcessAlive(pid);
      }

      let output = "";
      if (existsSync(resultFile)) {
        const full = readFileSync(resultFile, "utf-8");
        const lines = full.split("\n");
        const limit = Number.isInteger(tail_lines) && tail_lines > 0 ? tail_lines : 100;
        output = lines.length > limit
          ? `[...truncated ${lines.length - limit} lines...]\n` + lines.slice(-limit).join("\n")
          : full;
      }

      let result = `## Worker ${task_id}\n\n`;
      result += `- **Status:** ${isDone ? "completed" : isRunning ? "running" : "unknown"}\n`;
      result += `- **Directory:** ${meta.directory}\n- **Model:** ${meta.model}\n- **Spawned:** ${meta.spawned}\n`;
      if (isDone) { const d = readJSON(doneFile); result += `- **Finished:** ${d?.finished || "unknown"}\n`; }
      result += `\n### Output\n\`\`\`\n${output || "(no output yet)"}\n\`\`\`\n`;
      return text(result);
    }

    // ─── WAKE SESSION (cross-platform) ───
    case "coord_wake_session": {
      const session_id = validateSafeId(args.session_id, "session_id");
      const message = String(args.message ?? "");
      const sessionFile = join(TERMINALS_DIR, `session-${session_id}.json`);
      if (!existsSync(sessionFile)) return text(`Session ${session_id} not found.`);
      const sessionData = readJSON(sessionFile);
      const targetTTY = sessionData?.tty;

      // On non-macOS, fall back to inbox messaging (universal)
      if (PLATFORM !== "darwin") {
        const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
        appendFileSync(inboxFile, JSON.stringify({
          ts: new Date().toISOString(), from: "lead", priority: "urgent",
          content: `[WAKE] ${message}`,
        }) + "\n");
        return text(
          `Platform: ${PLATFORM} — AppleScript not available.\n` +
          `Sent URGENT inbox message instead. Session will receive it on next tool call.\n` +
          `Message: "${message}"\n\n` +
          `If the session is idle (not making tool calls), use coord_spawn_worker to dispatch autonomous work instead.`
        );
      }

      // macOS: AppleScript injection
      try {
        const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
        const termApp = getTerminalApp();
        let appleScript;

        if (termApp === "iTerm2" && targetTTY) {
          appleScript = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${targetTTY}" then
          select t
          tell s to write text "${escapedMessage}" newline NO
          delay 0.3
          tell s to write text ""
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found then exit repeat
  end repeat
  return found
end tell`.trim();
        } else if (termApp === "iTerm2") {
          appleScript = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s contains "claude-${session_id}" then
          select t
          tell s to write text "${escapedMessage}" newline NO
          delay 0.3
          tell s to write text ""
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found then exit repeat
  end repeat
  return found
end tell`.trim();
        } else {
          appleScript = `
tell application "Terminal"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      if name of t contains "claude-${session_id}" then
        set selected of t to true
        set frontmost of w to true
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
end tell
delay 0.5
if found then
  tell application "System Events"
    keystroke "${escapedMessage}"
    keystroke return
  end tell
end if
return found`.trim();
        }

        const result = execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { timeout: 10000, encoding: "utf-8" }).trim();

        if (result === "true") {
          return text(`Woke ${session_id} via ${termApp}${targetTTY ? ` (${targetTTY})` : ""}.\nMessage: "${message}"`);
        }

        // AppleScript couldn't find it — fall back to inbox
        const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
        appendFileSync(inboxFile, JSON.stringify({
          ts: new Date().toISOString(), from: "lead", priority: "urgent",
          content: `[WAKE] ${message}`,
        }) + "\n");
        return text(`Could not find session in ${termApp}. Sent inbox message as fallback.\nUse coord_spawn_worker if session is truly dead.`);

      } catch (err) {
        // Error — fall back to inbox
        const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
        appendFileSync(inboxFile, JSON.stringify({
          ts: new Date().toISOString(), from: "lead", priority: "urgent",
          content: `[WAKE] ${message}`,
        }) + "\n");
        return text(`AppleScript failed: ${err.message}\nSent inbox message as fallback.`);
      }
    }

    // ─── KILL WORKER (cross-platform) ───
    case "coord_kill_worker": {
      const task_id = validateSafeId(args.task_id, "task_id");
      const pidFile = join(RESULTS_DIR, `${task_id}.pid`);
      const metaFile = join(RESULTS_DIR, `${task_id}.meta.json`);

      if (!existsSync(pidFile)) {
        if (existsSync(`${metaFile}.done`)) return text(`Worker ${task_id} already completed.`);
        return text(`Worker ${task_id} has no PID file.`);
      }

      const pid = normalizePid(readFileSync(pidFile, "utf-8").trim());
      if (!pid) return text(`Worker ${task_id} has invalid PID metadata.`);
      try {
        killProcess(pid);
        writeFileSync(`${metaFile}.done`, JSON.stringify({ status: "cancelled", finished: new Date().toISOString(), task_id }));
        try { unlinkSync(pidFile); } catch {}
        return text(`Worker ${task_id} (PID ${pid}) killed.`);
      } catch (err) {
        return text(`Could not kill ${task_id} (PID ${pid}): ${err.message}`);
      }
    }

    // ─── RUN PIPELINE ───
    case "coord_run_pipeline": {
      const directory = String(args?.directory ?? "");
      const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const pipeline_id = args?.pipeline_id;
      if (!existsSync(directory)) return text(`Directory not found: ${directory}`);
      if (!tasks?.length) return text("No tasks provided.");

      const pipelineId = pipeline_id ? validateSafeId(pipeline_id, "pipeline_id") : `P${Date.now()}`;
      const pipelineDir = join(RESULTS_DIR, pipelineId);
      mkdirSync(pipelineDir, { recursive: true });

      // Context
      const cacheFile = join(SESSION_CACHE_DIR, "coder-context.md");
      let preamble = "";
      if (existsSync(cacheFile)) preamble = `## Prior Context\n${readFileSync(cacheFile, "utf-8").slice(0, 3000)}\n\n---\n\n`;
      const suffix = "\n\nWhen done, write key findings to ~/.claude/session-cache/coder-context.md.";

      try {
        const normalizedTasks = tasks.map((task, i) => {
          if (!task || typeof task !== "object") {
            failValidation(`Task at index ${i} must be an object.`);
          }
          const name = String(task.name ?? "").trim();
          const prompt = String(task.prompt ?? "");
          if (!name) failValidation(`Task at index ${i} is missing name.`);
          if (!prompt.trim()) failValidation(`Task "${name}" is missing prompt.`);
          const slug = sanitizeStepName(name, i);
          const model = validateSafeCliToken(task.model || "sonnet", `task[${i}].model`) || "sonnet";
          const agent = validateSafeCliToken(task.agent || null, `task[${i}].agent`);
          writeFileSync(join(pipelineDir, `${i}-${slug}.prompt`), preamble + prompt + suffix);
          return { step: i, name, slug, model, agent };
        });

        const metaFile = join(pipelineDir, "pipeline.meta.json");
        writeFileSync(metaFile, JSON.stringify({
          pipeline_id: pipelineId, directory, total_steps: tasks.length,
          tasks: normalizedTasks.map((t) => ({ step: t.step, name: t.name, slug: t.slug, model: t.model, agent: t.agent || null })),
          started: new Date().toISOString(), status: "running",
        }, null, 2));

        void runPipelineInBackground({
          pipelineId,
          pipelineDir,
          directory,
          tasks: normalizedTasks,
          metaFile,
        });

        return text(
          `Pipeline: **${pipelineId}**\n- Steps: ${normalizedTasks.length}\n` +
          normalizedTasks.map((t, i) => `  ${i}. ${t.name} (${t.model})`).join("\n") +
          `\n- Execution: detached background process (spawn args, no shell script interpolation)` +
          `\n\nCheck: \`coord_get_pipeline pipeline_id="${pipelineId}"\``
        );
      } catch (err) {
        return text(`Failed to launch pipeline: ${err.message}`);
      }
    }

    // ─── GET PIPELINE ───
    case "coord_get_pipeline": {
      const pipeline_id = validateSafeId(args.pipeline_id, "pipeline_id");
      const pipelineDir = join(RESULTS_DIR, pipeline_id);
      if (!existsSync(pipelineDir)) return text(`Pipeline ${pipeline_id} not found.`);

      const meta = readJSON(join(pipelineDir, "pipeline.meta.json"));
      const isDone = existsSync(join(pipelineDir, "pipeline.done"));
      const doneData = isDone ? readJSON(join(pipelineDir, "pipeline.done")) : null;

      const logFile = join(pipelineDir, "pipeline.log");
      const logEntries = readJSONL(logFile);

      const completed = logEntries.filter(e => e.status === "completed");
      const current = logEntries.filter(e => e.status === "running").pop();

      let output = `## Pipeline ${pipeline_id}\n\n`;
      output += `- **Status:** ${isDone ? "completed" : current ? "running" : "starting"}\n`;
      output += `- **Steps:** ${completed.length}/${meta?.total_steps || "?"}\n`;
      if (meta?.started) output += `- **Started:** ${meta.started}\n`;
      if (doneData?.finished) output += `- **Finished:** ${doneData.finished}\n`;

      output += "\n### Steps\n";
      (meta?.tasks || []).forEach((task, i) => {
        const done = completed.find(e => e.step === i);
        const running = current?.step === i;
        output += `- [${done ? "done" : running ? "RUNNING" : "pending"}] ${i}: ${task.name}\n`;
      });

      const show = current || completed[completed.length - 1];
      if (show) {
        const slug = show.slug || sanitizeStepName(show.name || `step-${show.step}`, show.step || 0);
        const sf = join(pipelineDir, `${show.step}-${slug}.txt`);
        if (existsSync(sf)) {
          output += `\n### Output (Step ${show.step})\n\`\`\`\n${readFileSync(sf, "utf-8").split("\n").slice(-15).join("\n")}\n\`\`\`\n`;
        }
      }
      return text(output);
    }

    // ─── TEAM RUNTIME WRAPPERS ───
    case "coord_team_list": {
      return text(runTeamRuntime(["team", "list"]));
    }

    case "coord_team_create": {
      const argv = ["team", "create", "--name", String(args?.name ?? "")];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.description) argv.push("--description", String(args.description));
      if (args?.lead_session_id) argv.push("--lead-session-id", validateSafeId(args.lead_session_id, "lead_session_id"));
      if (args?.lead_member_id) argv.push("--lead-member-id", validateSafeId(args.lead_member_id, "lead_member_id"));
      if (args?.lead_name) argv.push("--lead-name", String(args.lead_name));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_start": {
      const argv = ["team", "start", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_stop": {
      const argv = ["team", "stop", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.kill_panes) argv.push("--kill-panes");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_status": {
      const argv = ["team", "status", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.include_tasks) argv.push("--include-tasks");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_add_member": {
      const argv = ["member", "add", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.name) argv.push("--name", String(args.name));
      if (args?.role) argv.push("--role", String(args.role));
      if (args?.kind) argv.push("--kind", String(args.kind));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_attach_session": {
      const argv = [
        "member", "attach-session",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
        "--session-id", validateSafeId(args.session_id, "session_id"),
      ];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_spawn_teammate": {
      const argv = [
        "teammate", "spawn-pane",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
        "--cwd", String(args.cwd ?? ""),
      ];
      if (args?.name) argv.push("--name", String(args.name));
      if (args?.role) argv.push("--role", String(args.role));
      if (args?.agent) argv.push("--agent", validateSafeCliToken(args.agent, "agent"));
      if (args?.model) argv.push("--model", validateSafeCliToken(args.model, "model"));
      if (args?.initial_prompt) argv.push("--initial-prompt", String(args.initial_prompt));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_focus": {
      return text(runTeamRuntime([
        "teammate", "focus",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ]));
    }

    case "coord_team_interrupt": {
      const argv = [
        "teammate", "interrupt",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ];
      if (args?.message) argv.push("--message", String(args.message));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_send_peer": {
      const argv = [
        "message", "send",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--from-member", validateSafeId(args.from_member, "from_member"),
        "--to-member", validateSafeId(args.to_member, "to_member"),
        "--content", String(args.content ?? ""),
      ];
      if (args?.priority) argv.push("--priority", String(args.priority));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_add_task": {
      const argv = [
        "task", "add",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--title", String(args.title ?? ""),
      ];
      if (args?.task_id) argv.push("--task-id", validateSafeId(args.task_id, "task_id"));
      if (args?.description) argv.push("--description", String(args.description));
      if (args?.assignee) argv.push("--assignee", validateSafeId(args.assignee, "assignee"));
      if (args?.created_by) argv.push("--created-by", validateSafeId(args.created_by, "created_by"));
      if (Array.isArray(args?.depends_on)) {
        for (const dep of args.depends_on) argv.push("--depends-on", validateSafeId(dep, "depends_on"));
      }
      if (Array.isArray(args?.files)) {
        for (const file of args.files) argv.push("--file", String(file));
      }
      return text(runTeamRuntime(argv));
    }

    case "coord_team_list_tasks": {
      const argv = ["task", "list", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.status) argv.push("--status", String(args.status));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_claim_task": {
      const argv = [
        "task", "claim",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--task-id", validateSafeId(args.task_id, "task_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ];
      if (args?.force) argv.push("--force");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_update_task": {
      const argv = [
        "task", "update",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--task-id", validateSafeId(args.task_id, "task_id"),
        "--status", String(args.status ?? ""),
      ];
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.note) argv.push("--note", String(args.note));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_check_events": {
      const argv = ["event", "check", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.types) argv.push("--types", String(args.types));
      if (args?.since_id != null) argv.push("--since-id", String(Math.trunc(Number(args.since_id))));
      if (args?.consumer) argv.push("--consumer", validateSafeId(args.consumer, "consumer"));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_recover_hard": {
      const argv = ["team", "recover-hard", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (typeof args?.keep_events === "number") argv.push("--keep-events", String(Math.max(1, Math.floor(args.keep_events))));
      if (args?.include_workers === false) argv.push("--no-include-workers");
      else argv.push("--include-workers");
      if (args?.snapshot_window) argv.push("--snapshot-window", String(args.snapshot_window));
      if (typeof args?.cost_timeout === "number") argv.push("--cost-timeout", String(Math.max(3, Math.floor(args.cost_timeout))));
      return text(runTeamRuntime(argv));
    }

    case "coord_team_recover": {
      const argv = ["team", "recover", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (typeof args?.keep_events === "number") argv.push("--keep-events", String(Math.max(1, Math.floor(args.keep_events))));
      if (args?.include_workers === false) argv.push("--no-include-workers");
      else argv.push("--include-workers");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_resume": {
      const argv = ["team", "resume", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_doctor": {
      return text(runTeamRuntime(["team", "doctor", "--team-id", validateSafeId(args.team_id, "team_id")]));
    }

    case "coord_team_dashboard": {
      return text(runTeamRuntime(["team", "dashboard", "--team-id", validateSafeId(args.team_id, "team_id")]));
    }

    case "coord_team_bootstrap": {
      const argv = ["team", "bootstrap", "--name", String(args?.name ?? "")];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.description) argv.push("--description", String(args.description));
      if (args?.lead_session_id) argv.push("--lead-session-id", validateSafeId(args.lead_session_id, "lead_session_id"));
      if (args?.lead_member_id) argv.push("--lead-member-id", validateSafeId(args.lead_member_id, "lead_member_id"));
      if (args?.lead_name) argv.push("--lead-name", String(args.lead_name));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      if (args?.preset) argv.push("--preset", String(args.preset));
      if (Array.isArray(args?.teammates)) {
        for (const spec of args.teammates) argv.push("--teammate", String(spec));
      }
      return text(runTeamRuntime(argv));
    }

    case "coord_team_teardown": {
      const argv = ["team", "teardown", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.kill_panes) argv.push("--kill-panes");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_ack_message": {
      return text(runTeamRuntime([
        "message", "ack",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--message-id", validateSafeId(args.message_id, "message_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ]));
    }

    case "coord_team_release_claim": {
      const argv = [
        "task", "release-claim",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--task-id", validateSafeId(args.task_id, "task_id"),
      ];
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.force) argv.push("--force");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_reconcile": {
      const argv = ["team", "reconcile", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.keep_events != null) argv.push("--keep-events", String(Math.trunc(Number(args.keep_events))));
      if (args?.include_workers) argv.push("--include-workers");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_register_worker": {
      const argv = [
        "worker", "register",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--worker-task-id", validateSafeId(args.worker_task_id, "worker_task_id"),
      ];
      if (args?.task_id) argv.push("--task-id", validateSafeId(args.task_id, "task_id"));
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.auto_complete) argv.push("--auto-complete");
      return text(runTeamRuntime(argv));
    }

    case "coord_team_attach_worker_result": {
      const argv = [
        "worker", "attach-result",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--worker-task-id", validateSafeId(args.worker_task_id, "worker_task_id"),
      ];
      if (args?.task_id) argv.push("--task-id", validateSafeId(args.task_id, "task_id"));
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      return text(runTeamRuntime(argv));
    }

    // ─── COST RUNTIME WRAPPERS ───
    case "coord_cost_summary": {
      const argv = ["summary"];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.breakdown) argv.push("--breakdown");
      if (args?.json) argv.push("--json");
      return text(runCostRuntime(argv));
    }

    case "coord_cost_session": {
      const argv = ["session", "--session-id", validateSafeId(args.session_id, "session_id")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.json) argv.push("--json");
      return text(runCostRuntime(argv));
    }

    case "coord_cost_team": {
      const argv = ["team", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.include_members) argv.push("--include-members");
      if (args?.json) argv.push("--json");
      return text(runCostRuntime(argv));
    }

    case "coord_cost_active_block": {
      const argv = ["active-block"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return text(runCostRuntime(argv));
    }

    case "coord_cost_statusline": {
      const argv = ["statusline"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.cost_source) argv.push("--cost-source", String(args.cost_source));
      return text(runCostRuntime(argv));
    }

    case "coord_cost_budget_status": {
      const argv = ["budget-status"];
      if (args?.period) argv.push("--period", String(args.period));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return text(runCostRuntime(argv));
    }

    case "coord_cost_set_budget": {
      const argv = [
        "set-budget",
        "--scope", String(args.scope ?? ""),
        "--period", String(args.period ?? ""),
        "--amount-usd", String(Number(args.amount_usd)),
      ];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      return text(runCostRuntime(argv));
    }

    case "coord_cost_export": {
      const argv = ["export", "--format", String(args.format ?? "")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      return text(runCostRuntime(argv));
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
  } catch (err) {
    const message = err?.message || String(err);
    const prefix = err?.name === "ValidationError" ? "Validation error" : "Coordinator error";
    return text(`${prefix}: ${message}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => { console.error("Coordinator error:", err); process.exit(1); });
