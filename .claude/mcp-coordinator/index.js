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
import { execSync, execFileSync, execFile, spawn } from "child_process";
import { randomUUID } from "crypto";

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
const ASYNC_COORDINATOR_HANDLERS = process.env.CLAUDE_ASYNC_COORDINATOR_HANDLERS === "1";
const RESULT_ENVELOPE_ENABLED = process.env.CLAUDE_COORDINATOR_RESULT_ENVELOPE === "1";
const ASYNC_MAX_PARALLEL = Math.max(1, Number.parseInt(process.env.CLAUDE_ASYNC_MAX_PARALLEL || "4", 10) || 4);
let asyncInFlight = 0;
const asyncQueue = [];

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

// ─── FORCE-WAKE HELPERS ─────────────────────────────────────────────────────

/** Inject text into a TTY via AppleScript (iTerm2). Returns true if sent. */
async function injectViaAppleScript(tty, message) {
  if (!tty || PLATFORM !== "darwin") return false;
  const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const termApp = getTerminalApp();
  let appleScript;
  if (termApp === "iTerm2") {
    appleScript = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select t
          tell s to write text "${escapedMessage}"
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
    // Terminal.app — inject via System Events keystroke
    appleScript = `
tell application "Terminal"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      try
        if tty of t is "${tty}" then
          set selected of t to true
          set frontmost of w to true
          set found to true
          exit repeat
        end if
      end try
    end repeat
    if found then exit repeat
  end repeat
end tell
delay 0.3
if found then
  tell application "System Events"
    keystroke "${escapedMessage}"
    keystroke return
  end tell
end if
return found`.trim();
  }
  try {
    const result = execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { timeout: 8000, encoding: "utf-8" }).trim();
    if (result !== "true") return false;
    // Claude Code TUI requires an actual Return keystroke (not just a PTY newline) to submit
    await new Promise(r => setTimeout(r, 300));
    const returnKey = `
tell application "iTerm2" to activate
delay 0.2
tell application "System Events"
  key code 36
end tell`.trim();
    try { execSync(`osascript -e '${returnKey.replace(/'/g, "'\\''")}'`, { timeout: 5000 }); } catch {}
    return true;
  } catch { return false; }
}

/** Build a rich resume prompt from a frozen session's state. */
function buildResumePrompt(session, instruction) {
  let prompt = `RESUME TASK — previous session was frozen and killed.\n\n`;
  prompt += `Tab: ${session.tab_name || "unknown"} | Branch: ${session.branch || "unknown"}\n`;
  if (session.plan_file && existsSync(session.plan_file)) {
    try {
      const planLines = readFileSync(session.plan_file, "utf-8").split("\n").slice(0, 60).join("\n");
      prompt += `\nPlan file (${session.plan_file}):\n${planLines}\n`;
    } catch {}
  }
  if (session.files_touched?.length) {
    prompt += `\nFiles already touched:\n${session.files_touched.join("\n")}\n`;
  }
  if (session.recent_ops?.length) {
    const last = session.recent_ops.slice(-5);
    prompt += `\nLast operations:\n${last.map(o => `  ${o.t || ""} ${o.tool || ""} ${o.file || ""}`).join("\n")}\n`;
  }
  prompt += `\nInstruction: ${instruction}\n`;
  prompt += `\nContinue from where the previous session stopped. Check the plan file and files already touched to understand progress, then proceed.`;
  return prompt;
}

/** Stage 3: SIGTERM the frozen session and spawn a fresh worker with context. */
async function forceKillAndResume(session, sid, message, results) {
  const pid = session.host_pid;
  const resumePrompt = buildResumePrompt(session, message);

  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    results.push(`  SIGTERMed pid ${pid}`);
  }

  // Mark session as closed
  const sf = join(TERMINALS_DIR, `session-${sid}.json`);
  const s = readJSON(sf) || {};
  writeFileSync(sf, JSON.stringify({
    ...s, status: "closed",
    closed_at: new Date().toISOString(),
    killed_by: "coord_force_wake",
  }, null, 2));

  await new Promise(r => setTimeout(r, 1000));

  const cwd = session.cwd || process.env.HOME;
  const tty = session.tty;

  // Primary: inject `claude --resume` back into the SAME pane.
  // The pane now has a shell prompt (process died) so write text works immediately.
  let reinjected = false;
  if (tty && PLATFORM === "darwin") {
    const escapedCwd = cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const as = `
tell application "iTerm2"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select t
          tell s to write text "cd \\"${escapedCwd}\\" && claude --resume"
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
    try {
      const r = execSync(`osascript -e '${as.replace(/'/g, "'\\''")}'`, { timeout: 8000, encoding: "utf-8" }).trim();
      reinjected = r === "true";
    } catch {}
  }

  if (reinjected) {
    results.push(`  ✓ injected 'claude' into same pane (${tty})`);
    // Wait for Claude to boot (~8-10s), then submit the resume task via System Events Return
    await new Promise(r => setTimeout(r, 10000));
    const taskSubmitted = await injectViaAppleScript(tty, resumePrompt.slice(0, 600));
    results.push(`  task submitted: ${taskSubmitted ? "yes — running autonomously" : "failed (will see inbox on first tool call)"}`);
    return (
      `Session ${sid} (${session.tab_name || sid}) restarted in-place.\n\n` +
      `${results.join("\n")}`
    );
  }

  // Fallback: background worker (TTY gone or AppleScript failed)
  results.push(`  pane reinject failed — falling back to background worker`);
  const taskId = `FW${Date.now()}`;
  const resultFile = join(RESULTS_DIR, `${taskId}.txt`);
  const pidFile = join(RESULTS_DIR, `${taskId}.pid`);
  const metaFile = join(RESULTS_DIR, `${taskId}.meta.json`);
  const promptFile = join(RESULTS_DIR, `${taskId}.prompt`);
  const meta = { task_id: taskId, directory: cwd, prompt: resumePrompt.slice(0, 500), model: "sonnet", spawned: new Date().toISOString(), status: "running", resumed_from: sid };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  writeFileSync(promptFile, resumePrompt);
  appendFileSync(resultFile, `Force-wake worker ${taskId} starting at ${new Date().toISOString()}\n`);
  try {
    const child = runClaudeDetached({ cwd, promptFile, outputFile: resultFile, model: "sonnet", agent: null,
      onExit: (code) => {
        const status = code === 0 ? "completed" : "failed";
        writeFileSync(`${metaFile}.done`, JSON.stringify({ status, task_id: taskId, exit_code: code, finished: new Date().toISOString() }, null, 2));
        try { unlinkSync(pidFile); } catch {}
        writeFileSync(metaFile, JSON.stringify({ ...meta, status, finished: new Date().toISOString() }, null, 2));
      },
    });
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    results.push(`  background worker: ${taskId} (pid ${child.pid})`);
  } catch (err) {
    results.push(`  spawn failed: ${err.message}`);
  }

  return (
    `Session ${sid} (${session.tab_name || sid}) was SIGTERM'd.\n` +
    `Pane reinject failed — background worker spawned as fallback.\n\n` +
    `${results.join("\n")}\n\n` +
    `Check worker: coord_get_result task_id="${taskId}"`
  );
}

// ────────────────────────────────────────────────────────────────────────────

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

const LEGACY_COST_DEPRECATIONS = {
  coord_cost_summary: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost overview" },
  coord_cost_session: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost sessions show --session-id <id>" },
  coord_cost_team: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost teams show --team-id <id>" },
  coord_cost_active_block: { canonical_tool: "coord_cost_budget", canonical_command: "claude-token-guard cost budget active-block" },
  coord_cost_statusline: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost overview --format statusline" },
  coord_cost_budget_status: { canonical_tool: "coord_cost_budget", canonical_command: "claude-token-guard cost budget status" },
  coord_cost_team_budget_recommend: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost teams recommend-budget" },
  coord_cost_set_budget: { canonical_tool: "coord_cost_budget", canonical_command: "claude-token-guard cost budget set" },
  coord_cost_refresh_index: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost index refresh" },
  coord_cost_export: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost export" },
  coord_cost_burn_rate_check: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind burn-rate" },
  coord_cost_burn_projection: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind burn-rate" },
  coord_cost_anomaly_check: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind anomaly" },
  coord_cost_anomalies: { canonical_tool: "coord_ops_alerts", canonical_command: "claude-token-guard ops alerts check --kind anomaly" },
  coord_cost_spend_leaderboard: { canonical_tool: "coord_cost_overview", canonical_command: "claude-token-guard cost teams leaderboard" },
  coord_cost_daily_report: { canonical_tool: "coord_ops_today", canonical_command: "claude-token-guard ops today --markdown" },
  coord_cost_daily_report_generate: { canonical_tool: "coord_ops_today", canonical_command: "claude-token-guard ops today --markdown" },
  coord_cost_trends: { canonical_tool: "coord_ops_trends", canonical_command: "claude-token-guard ops trends" },
};

function textWithDeprecationMetadata(toolName, content) {
  const meta = LEGACY_COST_DEPRECATIONS[toolName];
  if (!meta) return text(content);
  const raw = typeof content === "string" ? content : String(content ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.deprecated = true;
      parsed.canonical_tool = meta.canonical_tool;
      parsed.canonical_command = meta.canonical_command;
      return text(JSON.stringify(parsed, null, 2));
    }
  } catch {}
  const footer = `\n\n[DEPRECATED]\ncanonical_tool=${meta.canonical_tool}\ncanonical_command=${meta.canonical_command}\n`;
  return text(raw + footer);
}

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

function categorizeExecError(err) {
  const msg = String(err?.message || err || "");
  if (err?.name === "ValidationError") return "VALIDATION_ERROR";
  if (/timed out|ETIMEDOUT/i.test(msg)) return "TIMEOUT";
  if (/not found|ENOENT/i.test(msg)) return "DEPENDENCY_ERROR";
  if (/unsafe|invalid|required/i.test(msg)) return "VALIDATION_ERROR";
  if (/policy/i.test(msg)) return "POLICY_DENIED";
  return "RUNTIME_ERROR";
}

function withEnvelope(tool, startedAt, requestId, producer) {
  try {
    const data = applyLegacyDeprecationToOutput(tool, producer());
    if (!RESULT_ENVELOPE_ENABLED) return text(data);
    return text(JSON.stringify({
      ok: true,
      data: { text: data },
      error: null,
      meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings: [] },
    }, null, 2));
  } catch (err) {
    const message = err?.message || String(err);
    if (!RESULT_ENVELOPE_ENABLED) throw err;
    return text(JSON.stringify({
      ok: false,
      data: null,
      error: { code: categorizeExecError(err), message },
      meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings: [] },
    }, null, 2));
  }
}

function withEnvelopeAsync(tool, startedAt, requestId, producer) {
  return Promise.resolve()
    .then(producer)
    .then((data) => {
      data = applyLegacyDeprecationToOutput(tool, data);
      if (!RESULT_ENVELOPE_ENABLED) return text(data);
      return text(JSON.stringify({
        ok: true,
        data: { text: data },
        error: null,
        meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings: [] },
      }, null, 2));
    })
    .catch((err) => {
      const message = err?.message || String(err);
      if (!RESULT_ENVELOPE_ENABLED) throw err;
      return text(JSON.stringify({
        ok: false,
        data: null,
        error: { code: categorizeExecError(err), message },
        meta: { tool, durationMs: Date.now() - startedAt, requestId, warnings: [] },
      }, null, 2));
    });
}

function runQueuedAsync(task) {
  return new Promise((resolve, reject) => {
    const launch = () => {
      asyncInFlight += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          asyncInFlight -= 1;
          const next = asyncQueue.shift();
          if (next) next();
        });
    };
    if (asyncInFlight < ASYNC_MAX_PARALLEL) launch();
    else asyncQueue.push(launch);
  });
}

function runExecFileAsync(bin, argv, { timeoutMs = 60000, label = "command" } = {}) {
  return runQueuedAsync(() => new Promise((resolve, reject) => {
    execFile(bin, argv, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String((stderr || stdout || err.message || `${label} failed`)).trim();
        const e = new Error(detail || `${label} failed`);
        e.name = err.killed ? "TimeoutError" : (err.name || "ExecError");
        return reject(e);
      }
      resolve((stdout || "").trim() || "(no output)");
    });
  }));
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

async function runTeamRuntimeAsync(argv) {
  if (!existsSync(TEAM_RUNTIME_SCRIPT)) {
    throw new Error(`Team runtime script not found: ${TEAM_RUNTIME_SCRIPT}`);
  }
  return runExecFileAsync("python3", [TEAM_RUNTIME_SCRIPT, ...argv], {
    timeoutMs: 120000,
    label: "team runtime command",
  });
}

async function runCostRuntimeAsync(argv) {
  if (!existsSync(COST_RUNTIME_SCRIPT)) {
    throw new Error(`Cost runtime script not found: ${COST_RUNTIME_SCRIPT}`);
  }
  return runExecFileAsync("python3", [COST_RUNTIME_SCRIPT, ...argv], {
    timeoutMs: 120000,
    label: "cost runtime command",
  });
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
      name: "coord_resolve_session",
      description: "Resolve a session by iTerm2 tab name (fuzzy, case-insensitive). Returns session ID, TTY, and status. Use this when the user refers to a session by name instead of ID (e.g. 'master agent', 'token plan').",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full or partial iTerm2 tab name, e.g. 'master agent'" },
        },
        required: ["name"],
      },
    },
    {
      name: "coord_force_wake",
      description: "Forcibly unfreeze a stuck/frozen session. 3-stage escalation: (1) SIGINT + inject message, (2) kill hung MCP children + SIGINT + retry, (3) SIGTERM + spawn fresh worker with extracted task context. Use when coord_wake_session fails or session is mid-API call.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Target session ID (8 chars) or partial tab name (e.g. 'master agent')" },
          message: { type: "string", description: "Message/instruction to inject after unfreezing. Default: 'Lead: check inbox and continue your task.'" },
          force_kill: { type: "boolean", description: "Skip stages 1-2 and go straight to SIGTERM + fresh spawn. Use when you know the session is completely dead." },
        },
        required: ["session_id"],
      },
    },
    {
      name: "coord_wake_session",
      description: "Wake an idle session. macOS: AppleScript injection via iTerm2/Terminal.app. Windows/Linux: falls back to inbox message with notification. session_id can be a full ID or use coord_resolve_session to look up by tab name first.",
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
      description: "Add a team task with dependency list, file scope, priority, labels, estimates, and approval gate.",
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
          priority: { type: "string", enum: ["low", "normal", "high", "critical"], description: "Task priority (default: normal)" },
          labels: { type: "array", items: { type: "string" }, description: "Task labels/tags" },
          estimate_minutes: { type: "number", description: "Estimated time in minutes" },
          due_at: { type: "string", description: "Due date/time (ISO format)" },
          sla_class: { type: "string", enum: ["urgent", "normal", "relaxed"], description: "SLA classification" },
          approval_required: { type: "boolean", description: "Require lead approval before in_progress" },
        },
        required: ["team_id", "title"],
      },
    },
    {
      name: "coord_team_list_tasks",
      description: "List team tasks sorted by priority with labels, claims, and dependency state.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          status: { type: "string" },
          label: { type: "string", description: "Filter by label" },
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
      description: "Update task status, priority, labels, estimates. Approval gate intercepts in_progress for approval-required tasks.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          status: { type: "string", enum: ["pending", "blocked", "claimed", "in_progress", "completed", "cancelled", "awaiting_approval"] },
          member_id: { type: "string" },
          note: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          add_labels: { type: "array", items: { type: "string" } },
          remove_labels: { type: "array", items: { type: "string" } },
          estimate_minutes: { type: "number" },
          due_at: { type: "string" },
          sla_class: { type: "string", enum: ["urgent", "normal", "relaxed"] },
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
      name: "coord_team_recover_hard_all",
      description: "Run recover-hard across all active teams and write a sweep report.",
      inputSchema: {
        type: "object",
        properties: {
          ensure_tmux: { type: "boolean" },
          keep_events: { type: "number" },
          include_workers: { type: "boolean" },
          snapshot_window: { type: "string", enum: ["today", "week", "month", "active_block"] },
          cost_timeout: { type: "number" },
        },
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
      name: "coord_team_pause",
      description: "Soft-pause a team or selected members so new task claims are blocked.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
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
      name: "coord_team_resume_all",
      description: "Resume all paused/running teams and optionally ensure tmux sessions.",
      inputSchema: {
        type: "object",
        properties: {
          ensure_tmux: { type: "boolean" },
        },
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
      name: "coord_team_restart_member",
      description: "Restart a teammate pane/member while preserving role and claimed task context.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          member_id: { type: "string" },
          cwd: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          initial_prompt: { type: "string" },
        },
        required: ["team_id", "member_id"],
      },
    },
    {
      name: "coord_team_replace_member",
      description: "Replace a failed member with a new member ID and transfer task/worker ownership.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          old_member_id: { type: "string" },
          new_member_id: { type: "string" },
          new_name: { type: "string" },
          cwd: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          initial_prompt: { type: "string" },
          force: { type: "boolean" },
          stop_old: { type: "boolean" },
          spawn_new: { type: "boolean" },
        },
        required: ["team_id", "old_member_id", "new_member_id"],
      },
    },
    {
      name: "coord_team_clone",
      description: "Clone a team structure for a new repo/workstream with reset runtime state.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          new_team_id: { type: "string" },
          new_name: { type: "string" },
          description: { type: "string" },
          cwd: { type: "string" },
          without_tasks: { type: "boolean" },
          copy_task_status: { type: "boolean" },
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
      name: "coord_team_archive",
      description: "Archive a team into a compressed snapshot and remove active references.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          force_stop: { type: "boolean" },
          kill_panes: { type: "boolean" },
          keep_team_dir: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_gc",
      description: "Garbage collect stale team runtime artifacts (mailboxes, cursors, orphan tmux sessions).",
      inputSchema: {
        type: "object",
        properties: {
          dry_run: { type: "boolean" },
          prune_tmux: { type: "boolean" },
          cursor_age_days: { type: "number" },
        },
      },
    },
    {
      name: "coord_team_scale_to_preset",
      description: "Scale a running team to lite/standard/heavy by spawning missing and pausing/stopping extras.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          preset: { type: "string", enum: ["lite", "standard", "heavy"] },
          cwd: { type: "string" },
          hard_downshift: { type: "boolean" },
          budget_aware: { type: "boolean", description: "Override preset from budget recommendation" },
          dry_run: { type: "boolean", description: "Show what would happen without executing" },
        },
        required: ["team_id", "preset"],
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
      name: "coord_team_broadcast",
      description: "Broadcast a message to multiple team members with priority and exclusions.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          from_member: { type: "string" },
          content: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          ttl_seconds: { type: "number" },
          exclude_members: { type: "array", items: { type: "string" } },
          include_lead: { type: "boolean" },
          announcement: { type: "boolean" },
          reply_to_message_id: { type: "string" },
        },
        required: ["team_id", "from_member", "content"],
      },
    },
    // ─── Phase C: Communication + Task Semantics ───
    {
      name: "coord_team_announce",
      description: "Broadcast an announcement to all team members. Supports sticky announcements that persist until acknowledged.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          content: { type: "string", description: "Announcement message" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Announcement priority (default: normal)" },
          sticky: { type: "boolean", description: "If true, repeats in every inbox read until acked" },
        },
        required: ["team_id", "content"],
      },
    },
    {
      name: "coord_team_announcements",
      description: "List all team announcements with per-member ack status.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_message_thread",
      description: "Retrieve all messages in a thread, chronologically with summary.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          thread_id: { type: "string", description: "Thread ID to retrieve" },
        },
        required: ["team_id", "thread_id"],
      },
    },
    {
      name: "coord_team_message_receipts",
      description: "Delivery receipts dashboard: queue depth, ack latency percentiles, retry histogram, stale-by-member breakdown.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_message_sla_status",
      description: "Inspect message SLA warning/critical state using priority-specific thresholds.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          emit_events: { type: "boolean", description: "Emit PeerMessageSLAWarning/PeerMessageEscalated events while reporting" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_task_template_list",
      description: "List available task templates (built-in and team-custom).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_task_template_apply",
      description: "Create a set of tasks from a template with prefix and optional assignees.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          template_name: { type: "string", description: "Template name, e.g. build-review-test-docs" },
          prefix: { type: "string", description: "Prefix for task IDs (defaults to template name)" },
          assignees: { type: "array", items: { type: "string" }, description: "Member IDs to round-robin assign tasks to" },
        },
        required: ["team_id", "template_name"],
      },
    },
    {
      name: "coord_team_task_graph",
      description: "Generate a dependency graph of team tasks as ASCII or Mermaid flowchart.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          format: { type: "string", enum: ["text", "mermaid"], description: "Output format (default: text)" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_task_rebalance",
      description: "Auto-reassign pending/stalled tasks to underloaded members based on workload caps.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          force: { type: "boolean", description: "Reassign even claimed tasks" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_task_complete",
      description: "Complete a task with structured outcome: summary, artifacts, next steps.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          summary: { type: "string", description: "What was accomplished" },
          artifacts: { type: "array", items: { type: "string" }, description: "Files or outputs produced" },
          next_steps: { type: "array", items: { type: "string" }, description: "Recommended follow-up tasks" },
        },
        required: ["team_id", "task_id"],
      },
    },
    {
      name: "coord_team_task_approve",
      description: "Approve a task that requires lead approval before work begins.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          approved_by: { type: "string", description: "Approver ID (defaults to lead)" },
        },
        required: ["team_id", "task_id"],
      },
    },
    {
      name: "coord_team_task_import",
      description: "Bulk import tasks from a JSON file.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          file: { type: "string", description: "Path to JSON file containing task array" },
        },
        required: ["team_id", "file"],
      },
    },
    {
      name: "coord_team_task_export",
      description: "Export all team tasks to a JSON file.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          file: { type: "string", description: "Output file path" },
          format: { type: "string", enum: ["json", "csv", "md"] },
        },
        required: ["team_id", "file"],
      },
    },
    {
      name: "coord_team_task_complete_with_outcome",
      description: "Alias of coord_team_task_complete for explicit outcome-schema naming.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          summary: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
          next_steps: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          tests_run: { type: "array", items: { type: "string" } },
        },
        required: ["team_id", "task_id"],
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
      name: "coord_team_auto_heal",
      description: "Auto-heal active teams by reconciling and respawning broken pane members (one-shot or daemon loop).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          ensure_tmux: { type: "boolean" },
          daemon: { type: "boolean" },
          interval_seconds: { type: "number" },
          iterations: { type: "number" },
        },
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
      name: "coord_team_selftest",
      description: "Run runtime/tmux/cost/dashboard/message health checks and write a selftest report.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          cost_timeout: { type: "number" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_checkpoint",
      description: "Create a parity-gated team checkpoint archive (Phase E starter).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          label: { type: "string" },
          json: { type: "boolean" },
          force: { type: "boolean", description: "Bypass parity gate" },
          include_shadow: { type: "boolean", description: "Include shadow.sqlite3 in archive (default true)" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_replay_events",
      description: "Replay team events/messages into derived summaries and validate monotonicity (parity-gated).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          apply: { type: "boolean", description: "Apply replay rebuild (shadow resync + runtime event_seq repair) and emit diff report" },
          json: { type: "boolean" },
          write_report: { type: "boolean" },
          force: { type: "boolean", description: "Bypass parity gate" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_repair_state",
      description: "Repair malformed team state files/ledgers with backups (dry-run by default, parity-gated).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          apply: { type: "boolean", description: "Apply repairs (default dry-run)" },
          json: { type: "boolean" },
          write_report: { type: "boolean" },
          force: { type: "boolean", description: "Bypass parity gate" },
        },
        required: ["team_id"],
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
      name: "coord_cost_team_budget_recommend",
      description: "Recommend lite/standard/heavy preset from budget pct + burn-rate projection.",
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
      name: "coord_cost_refresh_index",
      description: "Refresh cached usage index for faster repeated /cost summaries.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean" },
          json: { type: "boolean" },
        },
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

    // --- Phase D: Cost Intelligence + Live Budget Control ---
    {
      name: "coord_team_set_budget_policy",
      description: "Set per-team budget policy: daily cap, model policy, auto-downshift, thresholds.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          daily_cap_usd: { type: "number", description: "Daily budget cap in USD" },
          model_policy: { type: "string", enum: ["cost-optimized", "balanced", "capability-first"] },
          auto_downshift: { type: "boolean", description: "Auto-scale to lite on critical budget" },
          warn_pct: { type: "number", description: "Warning threshold percentage" },
          crit_pct: { type: "number", description: "Critical threshold percentage" },
          preset_override: { type: "string", enum: ["lite", "standard", "heavy"], description: "Force preset regardless of budget" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_auto_scale_policy_status",
      description: "Show budget policy + recommendation + burn projection + anomaly status for a team.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          json: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_team_auto_scale_apply",
      description: "Apply budget-policy-driven auto-scaling (downshift) to a running team.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          dry_run: { type: "boolean" },
          force: { type: "boolean" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_cost_burn_rate_check",
      description: "Check burn-rate projection and alert if budget will be exceeded.",
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
      name: "coord_cost_burn_projection",
      description: "Alias of coord_cost_burn_rate_check (projection + exhaustion alert).",
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
      name: "coord_cost_anomaly_check",
      description: "Detect cost/token/message anomalies by comparing current vs baseline.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          sensitivity: { type: "number", description: "Multiplier threshold for anomaly detection (default: 2.0)" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_anomalies",
      description: "Alias of coord_cost_anomaly_check (cost/token/message spike detection).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string" },
          sensitivity: { type: "number" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_spend_leaderboard",
      description: "Ranked spend breakdown by session, team, or model.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["today", "week", "month"] },
          group_by: { type: "string", enum: ["session", "team", "model"] },
          limit: { type: "number", description: "Max entries to return (default: 10)" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_daily_report",
      description: "Generate daily cost report with budget status, burn-rate, anomalies, and recommendations.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["today", "week", "month"] },
          team_id: { type: "string" },
          auto: { type: "boolean", description: "Headless mode for cron/LaunchAgent" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_daily_report_generate",
      description: "Alias of coord_cost_daily_report for automation/report pipelines.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["today", "week", "month"] },
          team_id: { type: "string" },
          auto: { type: "boolean" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_trends",
      description: "Cost trend analysis: daily series, moving averages, week-over-week change.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["week", "month"] },
          format: { type: "string", enum: ["json", "md"] },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_ops_today",
      description: "Unified token-management single-pane snapshot (hooks + cost + alerts + health).",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "boolean" },
          markdown: { type: "boolean" },
          refresh: { type: "boolean" },
          evaluate_alerts: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_ops_session_recap",
      description: "Session recap: agents spawned, blocks, tokens, cost, budget status.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          latest: { type: "boolean" },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_ops_alerts",
      description: "Alert status or alert evaluation with dedup/proactive checks.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "evaluate"] },
          json: { type: "boolean" },
          no_deliver: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_ops_trends",
      description: "Rolling trend analysis (7/14/30 day daily series and deltas).",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "number", enum: [7, 14, 30] },
          json: { type: "boolean" },
        },
      },
    },
    {
      name: "coord_cost_overview",
      description: "Canonical cost overview command (summary/statusline alias wrapper).",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["summary", "statusline"] },
          window: { type: "string", enum: ["today", "week", "month", "active_block", "custom"] },
          json: { type: "boolean" },
          team_id: { type: "string" },
          session_id: { type: "string" },
          project: { type: "string" },
        },
      },
    },
    {
      name: "coord_cost_budget",
      description: "Canonical cost budget status wrapper.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["daily", "weekly", "monthly"] },
          json: { type: "boolean" },
          team_id: { type: "string" },
          project: { type: "string" },
        },
      },
    },

    // --- Phase F: Observability tools ---
    {
      name: "coord_obs_health_report",
      description: "Generate unified health dashboard: runtime + tasks + events + cost + budgets + alerts + parity grades.",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "boolean", description: "Return JSON instead of markdown" },
        },
      },
    },
    {
      name: "coord_obs_timeline",
      description: "Generate chronological team timeline (tasks, messages, events).",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "Team ID" },
          hours: { type: "number", description: "Hours to look back (default 24)" },
          json: { type: "boolean", description: "Return JSON" },
        },
        required: ["team_id"],
      },
    },
    {
      name: "coord_obs_slo",
      description: "Show SLO metrics report (ack latency, recovery time, task completion, restart/failure rates).",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "boolean", description: "Return JSON" },
        },
      },
    },
    {
      name: "coord_obs_slo_snapshot",
      description: "Record an SLO metrics snapshot to history.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "coord_obs_parity_history",
      description: "Show parity grade trend over time.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "coord_obs_audit_trail",
      description: "Export audit trail of sensitive operations (recoveries, force claims, interrupts, replacements).",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Hours to look back (default 168 = 7 days)" },
          json: { type: "boolean", description: "Return JSON" },
        },
      },
    },

    // --- Phase F: Governance / Policy tools ---
    {
      name: "coord_policy_lint",
      description: "Validate all governance, cost, and team policy configs.",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "boolean", description: "Return JSON" },
        },
      },
    },
    {
      name: "coord_policy_check_action",
      description: "Check if an action is allowed by team policy (deploy, prod_push, force_push, destructive_delete).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action to check" },
          team_id: { type: "string", description: "Team ID" },
        },
        required: ["action"],
      },
    },
    {
      name: "coord_policy_check_tools",
      description: "Check if a tool or model is allowed by team policy.",
      inputSchema: {
        type: "object",
        properties: {
          team_id: { type: "string", description: "Team ID" },
          tool: { type: "string", description: "Tool or model name to check" },
        },
        required: ["team_id", "tool"],
      },
    },
    {
      name: "coord_policy_redact",
      description: "Redact sensitive content (paths, secrets, or both) from a file.",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input file path" },
          mode: { type: "string", enum: ["paths", "secrets", "full"], description: "Redaction mode (default: full)" },
          output: { type: "string", description: "Output file path (default: stdout)" },
        },
        required: ["input"],
      },
    },
    {
      name: "coord_policy_sign",
      description: "Sign a file with SHA-256 checksum for integrity verification.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path to sign" },
        },
        required: ["file"],
      },
    },
    {
      name: "coord_policy_verify",
      description: "Verify a signed file's integrity.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path to verify" },
        },
        required: ["file"],
      },
    },

    // --- Phase I: Collaboration tools ---
    { name: "coord_collab_set_role", description: "Set operator role (lead/operator/viewer) for a team member.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, member: { type: "string" }, role: { type: "string", enum: ["lead", "operator", "viewer"] } }, required: ["team_id", "member", "role"] } },
    { name: "coord_collab_check_permission", description: "Check if an action is permitted for a member's role.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, member: { type: "string" }, action: { type: "string" } }, required: ["team_id", "member", "action"] } },
    { name: "coord_collab_handoff_create", description: "Create handoff snapshot for operator transitions.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, from: { type: "string" }, note: { type: "string" } }, required: ["team_id"] } },
    { name: "coord_collab_handoff_latest", description: "Show what changed since last handoff.", inputSchema: { type: "object", properties: { team_id: { type: "string" } }, required: ["team_id"] } },
    { name: "coord_collab_set_ownership", description: "Set team ownership metadata (owners, escalation, project).", inputSchema: { type: "object", properties: { team_id: { type: "string" }, owners: { type: "string" }, escalation: { type: "string" }, project: { type: "string" } }, required: ["team_id"] } },
    { name: "coord_collab_set_presence", description: "Set operator presence (available/busy/away/offline).", inputSchema: { type: "object", properties: { team_id: { type: "string" }, member: { type: "string" }, status: { type: "string", enum: ["available", "busy", "away", "offline"] } }, required: ["team_id", "member", "status"] } },
    { name: "coord_collab_who", description: "List operators with presence, roles, and activity.", inputSchema: { type: "object", properties: { team_id: { type: "string" } }, required: ["team_id"] } },
    { name: "coord_collab_comment", description: "Add comment/annotation to a task, event, or message.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, target: { type: "string" }, text: { type: "string" }, author: { type: "string" } }, required: ["team_id", "target", "text", "author"] } },
    { name: "coord_collab_comments", description: "List comments, optionally filtered by target.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, target: { type: "string" } }, required: ["team_id"] } },

    // --- Phase I: Smart Automation tools ---
    { name: "coord_auto_recommend_preset", description: "Recommend team preset based on budget, repo, and task type.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, budget: { type: "number" }, task_type: { type: "string" }, repo: { type: "string" } } } },
    { name: "coord_auto_decompose", description: "Decompose goal into task graph for approval.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, goal: { type: "string" }, template: { type: "string" }, dry_run: { type: "boolean" }, apply: { type: "boolean" } }, required: ["goal"] } },
    { name: "coord_auto_recover", description: "Auto-recover: doctor + SLO check + conditional recover-hard.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, all: { type: "boolean" } } } },
    { name: "coord_auto_scale", description: "Auto-scale by queue depth, budget pressure, and SLO.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, dry_run: { type: "boolean" } }, required: ["team_id"] } },
    { name: "coord_auto_weekly_optimize", description: "Weekly optimization recommendations.", inputSchema: { type: "object", properties: { team_id: { type: "string" }, all: { type: "boolean" } } } },
  ],
}));

// ─────────────────────────────────────────────────────────
// TOOL EXECUTION
// ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = randomUUID();
  const startedAt = Date.now();
  const teamTool = (argv) => {
    if (ASYNC_COORDINATOR_HANDLERS) {
      return withEnvelopeAsync(name, startedAt, requestId, () => runTeamRuntimeAsync(argv));
    }
    return withEnvelope(name, startedAt, requestId, () => runTeamRuntime(argv));
  };
  const costTool = (argv) => {
    if (ASYNC_COORDINATOR_HANDLERS) {
      return withEnvelopeAsync(name, startedAt, requestId, () => runCostRuntimeAsync(argv));
    }
    return withEnvelope(name, startedAt, requestId, () => runCostRuntime(argv));
  };
  const costToolDeprecated = (toolName, argv) => {
    if (ASYNC_COORDINATOR_HANDLERS) {
      return withEnvelopeAsync(name, startedAt, requestId, async () => {
        const out = await runCostRuntimeAsync(argv);
        return applyLegacyDeprecationToOutput(toolName, out);
      });
    }
    return withEnvelope(name, startedAt, requestId, () => {
      const out = runCostRuntime(argv);
      return applyLegacyDeprecationToOutput(toolName, out);
    });
  };
  const pythonScriptTool = (scriptName, argv, timeoutMs = 60000) => {
    const fullArgv = [join(homedir(), ".claude", "scripts", scriptName), ...argv];
    if (ASYNC_COORDINATOR_HANDLERS) {
      return withEnvelopeAsync(name, startedAt, requestId, () =>
        runExecFileAsync("python3", fullArgv, { timeoutMs, label: scriptName })
      );
    }
    return withEnvelope(name, startedAt, requestId, () =>
      execFileSync("python3", fullArgv, { encoding: "utf8", timeout: timeoutMs })
    );
  };

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
        const tabName = s.tab_name ? s.tab_name.replace(/\s*\(node\)\s*$/i, "") : "—";
        return `| ${tabName} | ${s.session} | ${s.tty || "?"} | ${status} | ${lastActive} | ${tools} | ${recentFiles} | ${lastOp} |`;
      });

      const table = `| Tab Name | Session | TTY | Status | Last Active | W/E/B/R | Recent Files | Last Op |\n|----------|---------|-----|--------|-------------|---------|--------------|---------|` + "\n" + rows.join("\n");
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
      output += `- **Tab Name:** ${session.tab_name || "unknown"}\n`;
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

    // ─── RESOLVE SESSION BY TAB NAME ───
    case "coord_resolve_session": {
      const query = String(args.name ?? "").toLowerCase();
      const sessions = getAllSessions().filter(s => s.status !== "closed");
      const match = sessions.find(s =>
        (s.tab_name || "").toLowerCase().includes(query) ||
        (s.session || "").toLowerCase().startsWith(query)
      );
      if (!match) {
        const names = sessions.map(s => s.tab_name ? `"${s.tab_name.replace(/\s*\(node\)\s*$/i, "")}" (${s.session})` : s.session).join(", ");
        return text(`No session found matching "${args.name}".\nAvailable: ${names}`);
      }
      return text(
        `Resolved "${args.name}" → session **${match.session}**\n` +
        `- Tab: ${match.tab_name || "unknown"}\n` +
        `- TTY: ${match.tty || "?"}\n` +
        `- Status: ${getSessionStatus(match)}\n` +
        `- Last active: ${timeAgo(match.last_active)}`
      );
    }

    // ─── FORCE WAKE (3-stage escalation) ───
    case "coord_force_wake": {
      // Resolve by tab name or partial ID
      let sid = String(args.session_id ?? "");
      const sessions = getAllSessions();
      const byName = sessions.find(s =>
        (s.tab_name || "").toLowerCase().includes(sid.toLowerCase()) ||
        (s.session || "").startsWith(sid)
      );
      if (byName) sid = byName.session;

      const sessionFile = join(TERMINALS_DIR, `session-${sid}.json`);
      const session = readJSON(sessionFile);
      if (!session) return text(`Session ${sid} not found. Try coord_list_sessions to get the right ID or tab name.`);

      const pid = session.host_pid;
      const tty = session.tty;
      const message = String(args.message ?? "Lead: check inbox and continue your task.");
      const results = [];

      // Stage 3 shortcut: force_kill=true
      if (args.force_kill) {
        results.push("force_kill=true — skipping stages 1-2");
        return text(await forceKillAndResume(session, sid, message, results));
      }

      // ── Stage 1: SIGINT + inject ──
      results.push("Stage 1: SIGINT + inject");
      if (pid) {
        try { process.kill(pid, "SIGINT"); results.push("  SIGINT sent"); } catch (e) { results.push(`  SIGINT failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 2000));
      } else {
        results.push("  no host_pid — skipping SIGINT");
      }

      const injected1 = await injectViaAppleScript(tty, message);
      results.push(`  inject: ${injected1 ? "sent" : "failed"}`);

      // Wait up to 12s for last_active to change
      const before = session.last_active;
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = readJSON(sessionFile);
        if (updated?.last_active !== before) {
          return text(`✓ Session ${sid} responded after Stage 1.\n\n${results.join("\n")}`);
        }
      }
      results.push("  no response after 12s — escalating");

      // ── Stage 2: Kill MCP children + SIGINT + inject ──
      results.push("Stage 2: kill MCP children + SIGINT + inject");
      if (pid) {
        try {
          const children = execSync(`pgrep -P ${pid}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
          children.forEach(cpid => { try { process.kill(parseInt(cpid), "SIGTERM"); } catch {} });
          results.push(`  killed ${children.length} child process(es)`);
        } catch { results.push("  no child processes found"); }
        await new Promise(r => setTimeout(r, 1000));
        try { process.kill(pid, "SIGINT"); results.push("  SIGINT sent"); } catch (e) { results.push(`  SIGINT failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 2000));
      }

      const injected2 = await injectViaAppleScript(tty, message);
      results.push(`  inject: ${injected2 ? "sent" : "failed"}`);

      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = readJSON(sessionFile);
        if (updated?.last_active !== before) {
          return text(`✓ Session ${sid} responded after Stage 2.\n\n${results.join("\n")}`);
        }
      }
      results.push("  no response after 10s — escalating to Stage 3");

      // ── Stage 3: SIGTERM + fresh spawn ──
      results.push("Stage 3: SIGTERM + fresh spawn");
      return text(await forceKillAndResume(session, sid, message, results));
    }

    // ─── WAKE SESSION (cross-platform) ───
    case "coord_wake_session": {
      const session_id = validateSafeId(args.session_id, "session_id");
      const message = String(args.message ?? "");
      const sessionFile = join(TERMINALS_DIR, `session-${session_id}.json`);
      if (!existsSync(sessionFile)) return text(`Session ${session_id} not found.`);
      const sessionData = readJSON(sessionFile);
      const targetTTY = sessionData?.tty;

      // Interrupt any pending operation so the session reaches the readline prompt
      if (sessionData?.host_pid) {
        try { process.kill(sessionData.host_pid, "SIGINT"); } catch {}
        await new Promise(r => setTimeout(r, 1500));
      }

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

      // macOS: injectViaAppleScript — write text + System Events key code 36 (actual Return)
      const injected = await injectViaAppleScript(targetTTY, message);
      if (injected) {
        return text(`Woke ${session_id} (${targetTTY || "unknown TTY"}).\nMessage sent and submitted.`);
      }

      // Pane not found — inbox fallback
      const inboxFile = join(INBOX_DIR, `${session_id}.jsonl`);
      appendFileSync(inboxFile, JSON.stringify({
        ts: new Date().toISOString(), from: "lead", priority: "urgent",
        content: `[WAKE] ${message}`,
      }) + "\n");
      return text(`Could not find session pane. Sent inbox message as fallback.\nUse coord_force_wake if session is frozen.`);
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
      return teamTool(["team", "list"]);
    }

    case "coord_team_create": {
      const argv = ["team", "create", "--name", String(args?.name ?? "")];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.description) argv.push("--description", String(args.description));
      if (args?.lead_session_id) argv.push("--lead-session-id", validateSafeId(args.lead_session_id, "lead_session_id"));
      if (args?.lead_member_id) argv.push("--lead-member-id", validateSafeId(args.lead_member_id, "lead_member_id"));
      if (args?.lead_name) argv.push("--lead-name", String(args.lead_name));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return teamTool(argv);
    }

    case "coord_team_start": {
      const argv = ["team", "start", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return teamTool(argv);
    }

    case "coord_team_stop": {
      const argv = ["team", "stop", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.kill_panes) argv.push("--kill-panes");
      return teamTool(argv);
    }

    case "coord_team_status": {
      const argv = ["team", "status", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.include_tasks) argv.push("--include-tasks");
      return teamTool(argv);
    }

    case "coord_team_add_member": {
      const argv = ["member", "add", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.name) argv.push("--name", String(args.name));
      if (args?.role) argv.push("--role", String(args.role));
      if (args?.kind) argv.push("--kind", String(args.kind));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return teamTool(argv);
    }

    case "coord_team_attach_session": {
      const argv = [
        "member", "attach-session",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
        "--session-id", validateSafeId(args.session_id, "session_id"),
      ];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      return teamTool(argv);
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
      return teamTool(argv);
    }

    case "coord_team_focus": {
      return teamTool([
        "teammate", "focus",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ]);
    }

    case "coord_team_interrupt": {
      const argv = [
        "teammate", "interrupt",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ];
      if (args?.message) argv.push("--message", String(args.message));
      return teamTool(argv);
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
      return teamTool(argv);
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
      return teamTool(argv);
    }

    case "coord_team_list_tasks": {
      const argv = ["task", "list", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.status) argv.push("--status", String(args.status));
      return teamTool(argv);
    }

    case "coord_team_claim_task": {
      const argv = [
        "task", "claim",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--task-id", validateSafeId(args.task_id, "task_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ];
      if (args?.force) argv.push("--force");
      return teamTool(argv);
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
      return teamTool(argv);
    }

    case "coord_team_check_events": {
      const argv = ["event", "check", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.types) argv.push("--types", String(args.types));
      if (args?.since_id != null) argv.push("--since-id", String(Math.trunc(Number(args.since_id))));
      if (args?.consumer) argv.push("--consumer", validateSafeId(args.consumer, "consumer"));
      return teamTool(argv);
    }

    case "coord_team_recover_hard": {
      const argv = ["team", "recover-hard", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (typeof args?.keep_events === "number") argv.push("--keep-events", String(Math.max(1, Math.floor(args.keep_events))));
      if (args?.include_workers === false) argv.push("--no-include-workers");
      else argv.push("--include-workers");
      if (args?.snapshot_window) argv.push("--snapshot-window", String(args.snapshot_window));
      if (typeof args?.cost_timeout === "number") argv.push("--cost-timeout", String(Math.max(3, Math.floor(args.cost_timeout))));
      return teamTool(argv);
    }

    case "coord_team_recover_hard_all": {
      const argv = ["team", "recover-hard-all"];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (typeof args?.keep_events === "number") argv.push("--keep-events", String(Math.max(1, Math.floor(args.keep_events))));
      if (args?.include_workers === false) argv.push("--no-include-workers");
      else argv.push("--include-workers");
      if (args?.snapshot_window) argv.push("--snapshot-window", String(args.snapshot_window));
      if (typeof args?.cost_timeout === "number") argv.push("--cost-timeout", String(Math.max(3, Math.floor(args.cost_timeout))));
      return teamTool(argv);
    }

    case "coord_team_recover": {
      const argv = ["team", "recover", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (typeof args?.keep_events === "number") argv.push("--keep-events", String(Math.max(1, Math.floor(args.keep_events))));
      if (args?.include_workers === false) argv.push("--no-include-workers");
      else argv.push("--include-workers");
      return teamTool(argv);
    }

    case "coord_team_pause": {
      const argv = ["team", "pause", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (Array.isArray(args?.member_ids)) {
        for (const mid of args.member_ids) argv.push("--member-id", validateSafeId(mid, "member_id"));
      }
      if (args?.reason) argv.push("--reason", String(args.reason));
      return teamTool(argv);
    }

    case "coord_team_resume": {
      const argv = ["team", "resume", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      return teamTool(argv);
    }

    case "coord_team_resume_all": {
      const argv = ["team", "resume-all"];
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      return teamTool(argv);
    }

    case "coord_team_doctor": {
      return teamTool(["team", "doctor", "--team-id", validateSafeId(args.team_id, "team_id")]);
    }

    case "coord_team_dashboard": {
      return teamTool(["team", "dashboard", "--team-id", validateSafeId(args.team_id, "team_id")]);
    }

    case "coord_team_restart_member": {
      const argv = [
        "team", "restart-member",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      if (args?.agent) argv.push("--agent", String(args.agent));
      if (args?.model) argv.push("--model", String(args.model));
      if (args?.initial_prompt) argv.push("--initial-prompt", String(args.initial_prompt));
      return teamTool(argv);
    }

    case "coord_team_replace_member": {
      const argv = [
        "team", "replace-member",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--old-member-id", validateSafeId(args.old_member_id, "old_member_id"),
        "--new-member-id", validateSafeId(args.new_member_id, "new_member_id"),
      ];
      if (args?.new_name) argv.push("--new-name", String(args.new_name));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      if (args?.agent) argv.push("--agent", String(args.agent));
      if (args?.model) argv.push("--model", String(args.model));
      if (args?.initial_prompt) argv.push("--initial-prompt", String(args.initial_prompt));
      if (args?.force) argv.push("--force");
      if (args?.stop_old === false) argv.push("--no-stop-old");
      else argv.push("--stop-old");
      if (args?.spawn_new === false) argv.push("--no-spawn-new");
      else argv.push("--spawn-new");
      return teamTool(argv);
    }

    case "coord_team_clone": {
      const argv = ["team", "clone", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.new_team_id) argv.push("--new-team-id", validateSafeId(args.new_team_id, "new_team_id"));
      if (args?.new_name) argv.push("--new-name", String(args.new_name));
      if (args?.description) argv.push("--description", String(args.description));
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      if (args?.without_tasks) argv.push("--without-tasks");
      if (args?.copy_task_status) argv.push("--copy-task-status");
      return teamTool(argv);
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
      return teamTool(argv);
    }

    case "coord_team_teardown": {
      const argv = ["team", "teardown", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.kill_panes) argv.push("--kill-panes");
      return teamTool(argv);
    }

    case "coord_team_archive": {
      const argv = ["team", "archive", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.force_stop) argv.push("--force-stop");
      if (args?.kill_panes) argv.push("--kill-panes");
      if (args?.keep_team_dir) argv.push("--keep-team-dir");
      return teamTool(argv);
    }

    case "coord_team_gc": {
      const argv = ["team", "gc"];
      if (args?.dry_run) argv.push("--dry-run");
      if (args?.prune_tmux) argv.push("--prune-tmux");
      if (typeof args?.cursor_age_days === "number") argv.push("--cursor-age-days", String(Math.max(1, Math.floor(args.cursor_age_days))));
      return teamTool(argv);
    }

    case "coord_team_scale_to_preset": {
      const argv = [
        "team", "scale-to-preset",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--preset", String(args.preset ?? ""),
      ];
      if (args?.cwd) argv.push("--cwd", String(args.cwd));
      if (args?.hard_downshift) argv.push("--hard-downshift");
      if (args?.budget_aware) argv.push("--budget-aware");
      if (args?.dry_run) argv.push("--dry-run");
      return teamTool(argv);
    }

    case "coord_team_ack_message": {
      return teamTool([
        "message", "ack",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--message-id", validateSafeId(args.message_id, "message_id"),
        "--member-id", validateSafeId(args.member_id, "member_id"),
      ]);
    }

    case "coord_team_broadcast": {
      const argv = [
        "message", "broadcast",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--from-member", validateSafeId(args.from_member, "from_member"),
        "--content", String(args.content ?? ""),
      ];
      if (args?.priority) argv.push("--priority", String(args.priority));
      if (typeof args?.ttl_seconds === "number") argv.push("--ttl-seconds", String(Math.max(1, Math.floor(args.ttl_seconds))));
      if (Array.isArray(args?.exclude_members)) {
        for (const mid of args.exclude_members) argv.push("--exclude-member", validateSafeId(mid, "exclude_member"));
      }
      if (args?.include_lead) argv.push("--include-lead");
      if (args?.announcement) argv.push("--announcement");
      if (args?.reply_to_message_id) argv.push("--reply-to-message-id", validateSafeId(args.reply_to_message_id, "reply_to_message_id"));
      return teamTool(argv);
    }

    // ─── Phase C: Communication + Task Semantics ───
    case "coord_team_announce": {
      const argv = ["team", "announce", "--team-id", String(args.team_id), "--content", String(args.content)];
      if (args.priority) argv.push("--priority", args.priority);
      if (args.sticky) argv.push("--sticky");
      return teamTool(argv);
    }
    case "coord_team_announcements": {
      return teamTool(["message", "announcements", "--team-id", String(args.team_id)]);
    }
    case "coord_team_message_thread": {
      return teamTool(["message", "thread", "--team-id", String(args.team_id), "--thread-id", String(args.thread_id)]);
    }
    case "coord_team_message_receipts": {
      return teamTool(["message", "receipts", "--team-id", String(args.team_id)]);
    }
    case "coord_team_message_sla_status": {
      const argv = ["message", "sla-status", "--team-id", String(args.team_id)];
      if (args.emit_events) argv.push("--emit-events");
      return teamTool(argv);
    }
    case "coord_team_task_template_list": {
      return teamTool(["task", "template-list", "--team-id", String(args.team_id)]);
    }
    case "coord_team_task_template_apply": {
      const argv = ["task", "template-apply", "--team-id", String(args.team_id), "--template-name", String(args.template_name)];
      if (args.prefix) argv.push("--prefix", args.prefix);
      if (args.assignees?.length) argv.push("--assignees", ...args.assignees);
      return teamTool(argv);
    }
    case "coord_team_task_graph": {
      const argv = ["task", "graph", "--team-id", String(args.team_id)];
      if (args.format) argv.push("--format", args.format);
      return teamTool(argv);
    }
    case "coord_team_task_rebalance": {
      const argv = ["task", "rebalance", "--team-id", String(args.team_id)];
      if (args.force) argv.push("--force");
      return teamTool(argv);
    }
    case "coord_team_task_complete": {
      const argv = ["task", "complete-with-outcome", "--team-id", String(args.team_id), "--task-id", String(args.task_id)];
      if (args.member_id) argv.push("--member-id", args.member_id);
      if (args.summary) argv.push("--summary", args.summary);
      if (args.artifacts?.length) argv.push("--artifacts", ...args.artifacts);
      if (args.next_steps?.length) argv.push("--next-steps", ...args.next_steps);
      if (args.risks?.length) argv.push("--risks", args.risks.join(","));
      if (args.tests_run?.length) argv.push("--tests-run", args.tests_run.join(","));
      return teamTool(argv);
    }
    case "coord_team_task_complete_with_outcome": {
      const argv = ["task", "complete-with-outcome", "--team-id", String(args.team_id), "--task-id", String(args.task_id)];
      if (args.member_id) argv.push("--member-id", args.member_id);
      if (args.summary) argv.push("--summary", args.summary);
      if (args.artifacts?.length) argv.push("--artifacts", ...args.artifacts);
      if (args.next_steps?.length) argv.push("--next-steps", ...args.next_steps);
      if (args.risks?.length) argv.push("--risks", args.risks.join(","));
      if (args.tests_run?.length) argv.push("--tests-run", args.tests_run.join(","));
      return teamTool(argv);
    }
    case "coord_team_task_approve": {
      const argv = ["task", "approve", "--team-id", String(args.team_id), "--task-id", String(args.task_id)];
      if (args.approved_by) argv.push("--approved-by", args.approved_by);
      return teamTool(argv);
    }
    case "coord_team_task_import": {
      return teamTool(["task", "import", "--team-id", String(args.team_id), "--file", String(args.file)]);
    }
    case "coord_team_task_export": {
      const argv = ["task", "export", "--team-id", String(args.team_id), "--file", String(args.file)];
      if (args.format) argv.push("--format", String(args.format));
      return teamTool(argv);
    }

    case "coord_team_release_claim": {
      const argv = [
        "task", "release-claim",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--task-id", validateSafeId(args.task_id, "task_id"),
      ];
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      if (args?.force) argv.push("--force");
      return teamTool(argv);
    }

    case "coord_team_reconcile": {
      const argv = ["team", "reconcile", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.keep_events != null) argv.push("--keep-events", String(Math.trunc(Number(args.keep_events))));
      if (args?.include_workers) argv.push("--include-workers");
      return teamTool(argv);
    }

    case "coord_team_auto_heal": {
      const argv = ["team", "auto-heal"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.ensure_tmux) argv.push("--ensure-tmux");
      if (args?.daemon) argv.push("--daemon");
      if (typeof args?.interval_seconds === "number") argv.push("--interval-seconds", String(Math.max(1, Math.floor(args.interval_seconds))));
      if (typeof args?.iterations === "number") argv.push("--iterations", String(Math.max(1, Math.floor(args.iterations))));
      return teamTool(argv);
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
      return teamTool(argv);
    }

    case "coord_team_attach_worker_result": {
      const argv = [
        "worker", "attach-result",
        "--team-id", validateSafeId(args.team_id, "team_id"),
        "--worker-task-id", validateSafeId(args.worker_task_id, "worker_task_id"),
      ];
      if (args?.task_id) argv.push("--task-id", validateSafeId(args.task_id, "task_id"));
      if (args?.member_id) argv.push("--member-id", validateSafeId(args.member_id, "member_id"));
      return teamTool(argv);
    }

    case "coord_team_selftest": {
      const argv = ["admin", "selftest", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (typeof args?.cost_timeout === "number") argv.push("--cost-timeout", String(Math.max(3, Math.floor(args.cost_timeout))));
      return teamTool(argv);
    }

    case "coord_team_checkpoint": {
      const argv = ["team", "checkpoint", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.label) argv.push("--label", String(args.label));
      if (args?.json) argv.push("--json");
      if (args?.force) argv.push("--force");
      if (args?.include_shadow === false) argv.push("--no-shadow");
      return teamTool(argv);
    }

    case "coord_team_replay_events": {
      const argv = ["admin", "replay-events", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.apply) argv.push("--apply");
      if (args?.json) argv.push("--json");
      if (args?.write_report) argv.push("--write-report");
      if (args?.force) argv.push("--force");
      return teamTool(argv);
    }

    case "coord_team_repair_state": {
      const argv = ["admin", "repair-state", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.apply) argv.push("--apply");
      if (args?.json) argv.push("--json");
      if (args?.write_report) argv.push("--write-report");
      if (args?.force) argv.push("--force");
      return teamTool(argv);
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
      return costToolDeprecated("coord_cost_summary", argv);
    }

    case "coord_cost_session": {
      const argv = ["session", "--session-id", validateSafeId(args.session_id, "session_id")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_session", argv);
    }

    case "coord_cost_team": {
      const argv = ["team", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.include_members) argv.push("--include-members");
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_team", argv);
    }

    case "coord_cost_active_block": {
      const argv = ["active-block"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_active_block", argv);
    }

    case "coord_cost_statusline": {
      const argv = ["statusline"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.cost_source) argv.push("--cost-source", String(args.cost_source));
      return costToolDeprecated("coord_cost_statusline", argv);
    }

    case "coord_cost_budget_status": {
      const argv = ["budget-status"];
      if (args?.period) argv.push("--period", String(args.period));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_budget_status", argv);
    }

    case "coord_cost_team_budget_recommend": {
      const argv = ["team-budget-recommend"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_team_budget_recommend", argv);
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
      return costToolDeprecated("coord_cost_set_budget", argv);
    }

    case "coord_cost_refresh_index": {
      const argv = ["index-refresh"];
      if (args?.force) argv.push("--force");
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_refresh_index", argv);
    }

    case "coord_cost_export": {
      const argv = ["export", "--format", String(args.format ?? "")];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.since) argv.push("--since", String(args.since));
      if (args?.until) argv.push("--until", String(args.until));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      return costToolDeprecated("coord_cost_export", argv);
    }

    // --- Phase D: Cost Intelligence + Live Budget Control handlers ---
    case "coord_team_set_budget_policy": {
      const argv = ["team", "set-budget-policy", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.daily_cap_usd != null) argv.push("--daily-cap-usd", String(args.daily_cap_usd));
      if (args?.model_policy) argv.push("--model-policy", String(args.model_policy));
      if (args?.auto_downshift === true) argv.push("--auto-downshift");
      if (args?.auto_downshift === false) argv.push("--no-auto-downshift");
      if (args?.warn_pct != null) argv.push("--warn-pct", String(args.warn_pct));
      if (args?.crit_pct != null) argv.push("--crit-pct", String(args.crit_pct));
      if (args?.preset_override) argv.push("--preset-override", String(args.preset_override));
      return teamTool(argv);
    }
    case "coord_team_auto_scale_policy_status": {
      const argv = ["team", "auto-scale-policy-status", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.json) argv.push("--json");
      return teamTool(argv);
    }
    case "coord_team_auto_scale_apply": {
      const argv = ["team", "auto-scale-apply", "--team-id", validateSafeId(args.team_id, "team_id")];
      if (args?.dry_run) argv.push("--dry-run");
      if (args?.force) argv.push("--force");
      return teamTool(argv);
    }
    case "coord_cost_burn_rate_check": {
      const argv = ["burn-rate-check"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_burn_rate_check", argv);
    }
    case "coord_cost_burn_projection": {
      const argv = ["burn-rate-check"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_burn_projection", argv);
    }
    case "coord_cost_anomaly_check": {
      const argv = ["anomaly-check"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.sensitivity != null) argv.push("--sensitivity", String(args.sensitivity));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_anomaly_check", argv);
    }
    case "coord_cost_anomalies": {
      const argv = ["anomaly-check"];
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.sensitivity != null) argv.push("--sensitivity", String(args.sensitivity));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_anomalies", argv);
    }
    case "coord_cost_spend_leaderboard": {
      const argv = ["spend-leaderboard"];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.group_by) argv.push("--group-by", String(args.group_by));
      if (args?.limit != null) argv.push("--limit", String(args.limit));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_spend_leaderboard", argv);
    }
    case "coord_cost_daily_report": {
      const argv = ["daily-report"];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.auto) argv.push("--auto");
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_daily_report", argv);
    }
    case "coord_cost_daily_report_generate": {
      const argv = ["daily-report"];
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.auto) argv.push("--auto");
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_daily_report_generate", argv);
    }
    case "coord_cost_trends": {
      const argv = ["cost-trends"];
      if (args?.period) argv.push("--period", String(args.period));
      if (args?.format) argv.push("--format", String(args.format));
      if (args?.json) argv.push("--json");
      return costToolDeprecated("coord_cost_trends", argv);
    }
    case "coord_ops_today": {
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "ops", "today"];
      if (args?.json) argv.push("--json");
      if (args?.markdown) argv.push("--markdown");
      if (args?.refresh) argv.push("--refresh");
      if (args?.evaluate_alerts) argv.push("--evaluate-alerts");
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }
    case "coord_ops_session_recap": {
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "ops", "session-recap"];
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.latest || !args?.session_id) argv.push("--latest");
      if (args?.json) argv.push("--json");
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }
    case "coord_ops_alerts": {
      const action = String(args?.action || "status");
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "ops", "alerts", action];
      if (args?.json) argv.push("--json");
      if (args?.no_deliver) argv.push("--no-deliver");
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }
    case "coord_ops_trends": {
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "ops", "trends"];
      if (args?.window != null) argv.push("--window", String(args.window));
      if (args?.json) argv.push("--json");
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }
    case "coord_cost_overview": {
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "cost", "overview"];
      if (args?.format) argv.push("--format", String(args.format));
      if (args?.window) argv.push("--window", String(args.window));
      if (args?.json) argv.push("--json");
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.session_id) argv.push("--session-id", validateSafeId(args.session_id, "session_id"));
      if (args?.project) argv.push("--project", String(args.project));
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }
    case "coord_cost_budget": {
      const argv = [join(homedir(), ".claude", "hooks", "claude_token_guard", "cli.py"), "cost", "budget", "status"];
      if (args?.period) argv.push("--period", String(args.period));
      if (args?.json) argv.push("--json");
      if (args?.team_id) argv.push("--team-id", validateSafeId(args.team_id, "team_id"));
      if (args?.project) argv.push("--project", String(args.project));
      return text(execFileSync("python3", argv, { encoding: "utf8", timeout: 60000 }));
    }

    // --- Phase F: Observability handlers ---
    case "coord_obs_health_report": {
      const argv = ["health-report"];
      if (args?.json) argv.push("--json");
      return pythonScriptTool("observability.py", argv, 60000);
    }
    case "coord_obs_timeline": {
      const argv = ["timeline", "--team", validateSafeId(args.team_id, "team_id")];
      if (args?.hours) argv.push("--hours", String(args.hours));
      if (args?.json) argv.push("--json");
      return pythonScriptTool("observability.py", argv, 60000);
    }
    case "coord_obs_slo": {
      const argv = ["slo", "--report"];
      if (args?.json) argv.push("--json");
      return pythonScriptTool("observability.py", argv, 60000);
    }
    case "coord_obs_slo_snapshot": {
      return pythonScriptTool("observability.py", ["slo"], 60000);
    }
    case "coord_obs_parity_history": {
      return pythonScriptTool("observability.py", ["parity-history", "--report"], 60000);
    }
    case "coord_obs_audit_trail": {
      const argv = ["audit-trail"];
      if (args?.hours) argv.push("--hours", String(args.hours));
      if (args?.json) argv.push("--json");
      return pythonScriptTool("observability.py", argv, 60000);
    }

    // --- Phase F: Policy handlers ---
    case "coord_policy_lint": {
      const argv = ["lint"];
      if (args?.json) argv.push("--json");
      return pythonScriptTool("policy_engine.py", argv, 30000);
    }
    case "coord_policy_check_action": {
      const argv = ["check-action", "--action", String(args.action)];
      if (args?.team_id) argv.push("--team", validateSafeId(args.team_id, "team_id"));
      return pythonScriptTool("policy_engine.py", argv, 15000);
    }
    case "coord_policy_check_tools": {
      const argv = ["check-tools", "--team", validateSafeId(args.team_id, "team_id"), "--tool", String(args.tool)];
      return pythonScriptTool("policy_engine.py", argv, 15000);
    }
    case "coord_policy_redact": {
      const argv = ["redact", "--input", String(args.input)];
      if (args?.mode) argv.push("--mode", String(args.mode));
      if (args?.output) argv.push("--output", String(args.output));
      return pythonScriptTool("policy_engine.py", argv, 30000);
    }
    case "coord_policy_sign": {
      return pythonScriptTool("policy_engine.py", ["sign", "--file", String(args.file)], 15000);
    }
    case "coord_policy_verify": {
      return pythonScriptTool("policy_engine.py", ["verify", "--file", String(args.file)], 15000);
    }

    // --- Phase I: Collaboration handlers ---
    case "coord_collab_set_role": {
      const argv = ["set-role", "--team", validateSafeId(args.team_id, "team_id"), "--member", String(args.member), "--role", String(args.role)];
      return pythonScriptTool("collaboration.py", argv, 15000);
    }
    case "coord_collab_check_permission": {
      const argv = ["check-permission", "--team", validateSafeId(args.team_id, "team_id"), "--member", String(args.member), "--action", String(args.action)];
      return pythonScriptTool("collaboration.py", argv, 15000);
    }
    case "coord_collab_handoff_create": {
      const argv = ["handoff-create", "--team", validateSafeId(args.team_id, "team_id")];
      if (args?.from) argv.push("--from", String(args.from));
      if (args?.note) argv.push("--note", String(args.note));
      return pythonScriptTool("collaboration.py", argv, 30000);
    }
    case "coord_collab_handoff_latest": {
      return pythonScriptTool("collaboration.py", ["handoff-latest", "--team", validateSafeId(args.team_id, "team_id")], 15000);
    }
    case "coord_collab_set_ownership": {
      const argv = ["set-ownership", "--team", validateSafeId(args.team_id, "team_id")];
      if (args?.owners) argv.push("--owners", String(args.owners));
      if (args?.escalation) argv.push("--escalation", String(args.escalation));
      if (args?.project) argv.push("--project", String(args.project));
      return pythonScriptTool("collaboration.py", argv, 15000);
    }
    case "coord_collab_set_presence": {
      const argv = ["set-presence", "--team", validateSafeId(args.team_id, "team_id"), "--member", String(args.member), "--status", String(args.status)];
      return pythonScriptTool("collaboration.py", argv, 15000);
    }
    case "coord_collab_who": {
      return pythonScriptTool("collaboration.py", ["who", "--team", validateSafeId(args.team_id, "team_id")], 15000);
    }
    case "coord_collab_comment": {
      const argv = ["comment", "--team", validateSafeId(args.team_id, "team_id"), "--target", String(args.target), "--text", String(args.text), "--author", String(args.author)];
      return pythonScriptTool("collaboration.py", argv, 15000);
    }
    case "coord_collab_comments": {
      const argv = ["comments", "--team", validateSafeId(args.team_id, "team_id")];
      if (args?.target) argv.push("--target", String(args.target));
      return pythonScriptTool("collaboration.py", argv, 15000);
    }

    // --- Phase I: Smart Automation handlers ---
    case "coord_auto_recommend_preset": {
      const argv = ["recommend-preset"];
      if (args?.team_id) argv.push("--team", validateSafeId(args.team_id, "team_id"));
      if (args?.budget) argv.push("--budget", String(args.budget));
      if (args?.task_type) argv.push("--task-type", String(args.task_type));
      if (args?.repo) argv.push("--repo", String(args.repo));
      return pythonScriptTool("smart_automation.py", argv, 30000);
    }
    case "coord_auto_decompose": {
      const argv = ["decompose", "--goal", String(args.goal)];
      if (args?.team_id) argv.push("--team", validateSafeId(args.team_id, "team_id"));
      if (args?.template) argv.push("--template", String(args.template));
      if (args?.dry_run) argv.push("--dry-run");
      if (args?.apply) argv.push("--apply");
      return pythonScriptTool("smart_automation.py", argv, 30000);
    }
    case "coord_auto_recover": {
      const argv = ["auto-recover"];
      if (args?.team_id) argv.push("--team", validateSafeId(args.team_id, "team_id"));
      if (args?.all) argv.push("--all");
      return pythonScriptTool("smart_automation.py", argv, 90000);
    }
    case "coord_auto_scale": {
      const argv = ["auto-scale", "--team", validateSafeId(args.team_id, "team_id")];
      if (args?.dry_run) argv.push("--dry-run");
      return pythonScriptTool("smart_automation.py", argv, 60000);
    }
    case "coord_auto_weekly_optimize": {
      const argv = ["weekly-optimize"];
      if (args?.team_id) argv.push("--team", validateSafeId(args.team_id, "team_id"));
      if (args?.all) argv.push("--all");
      return pythonScriptTool("smart_automation.py", argv, 60000);
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
  } catch (err) {
    const message = err?.message || String(err);
    const prefix = err?.name === "ValidationError" ? "Validation error" : "Coordinator error";
    if (RESULT_ENVELOPE_ENABLED) {
      return text(JSON.stringify({
        ok: false,
        data: null,
        error: { code: categorizeExecError(err), message: `${prefix}: ${message}` },
        meta: { tool: name, durationMs: Date.now() - startedAt, requestId, warnings: [] },
      }, null, 2));
    }
    return text(`${prefix}: ${message}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => { console.error("Coordinator error:", err); process.exit(1); });
