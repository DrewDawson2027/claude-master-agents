#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
TEAMS_DIR = CLAUDE_DIR / "teams"
TERMINALS_DIR = CLAUDE_DIR / "terminals"
TEAM_INDEX_FILE = TEAMS_DIR / "index.json"
INBOX_DIR = TERMINALS_DIR / "inbox"
RESULTS_DIR = TERMINALS_DIR / "results"
TEAM_PRESET_PROFILE_FILE = CLAUDE_DIR / "cost" / "team-preset-profiles.json"
COST_CACHE_FILE = CLAUDE_DIR / "cost" / "cache.json"
COST_BUDGETS_FILE = CLAUDE_DIR / "cost" / "budgets.json"
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
IDLE_THRESHOLD_SECONDS = 180
IDLE_COOLDOWN_SECONDS = 300
CLAIM_TTL_SECONDS = 900
MESSAGE_TTL_SECONDS = 86400
EVENT_COMPACT_KEEP = 1000


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def now_epoch() -> int:
    return int(time.time())


def parse_ts(ts: str | None) -> float:
    if not ts:
        return 0.0


def format_age(seconds: float | int) -> str:
    s = int(max(0, seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def safe_id(value: str, label: str = "id") -> str:
    if not value or not isinstance(value, str):
        raise ValueError(f"{label} must be a non-empty string")
    if len(value) > 80 or not SAFE_ID_RE.match(value) or ".." in value or "/" in value or "\\" in value:
        raise ValueError(f"{label} contains unsafe characters")
    return value


def slugify(value: str, fallback: str = "item") -> str:
    out = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip().lower()).strip("-")
    return safe_id(out[:60] or fallback, "slug")


def ensure_dirs() -> None:
    TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    TERMINALS_DIR.mkdir(parents=True, exist_ok=True)
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)


def canonical_path(path: str) -> str:
    try:
        return str(Path(path).expanduser().resolve(strict=False))
    except Exception:
        return str(Path(path).expanduser())


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def ensure_team_preset_profiles() -> dict[str, Any]:
    default = {
        "defaultProfile": "budget-aware-v1",
        "profiles": {
            "budget-aware-v1": {
                "strategy": "daily_budget_pct",
                "fallbackPreset": "standard",
                "noBudgetPreset": "standard",
                "rules": [
                    {"maxPct": 40, "preset": "heavy"},
                    {"maxPct": 75, "preset": "standard"},
                    {"maxPct": 1000000, "preset": "lite"},
                ],
            }
        },
    }
    cur = read_json(TEAM_PRESET_PROFILE_FILE, None)
    if not isinstance(cur, dict) or "profiles" not in cur:
        write_json(TEAM_PRESET_PROFILE_FILE, default)
        return default
    return cur


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
    tmp.replace(path)


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, separators=(",", ":")) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except Exception:
            continue
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    tmp.replace(path)


@contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as f:
        if fcntl is not None:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)


@dataclass
class TeamPaths:
    team_id: str

    @property
    def root(self) -> Path:
        return TEAMS_DIR / self.team_id

    @property
    def config(self) -> Path:
        return self.root / "config.json"

    @property
    def runtime(self) -> Path:
        return self.root / "runtime.json"

    @property
    def tasks(self) -> Path:
        return self.root / "tasks.json"

    @property
    def events(self) -> Path:
        return self.root / "events.jsonl"

    @property
    def messages(self) -> Path:
        return self.root / "messages.jsonl"

    @property
    def mailbox_dir(self) -> Path:
        return self.root / "mailboxes"

    @property
    def control_dir(self) -> Path:
        return self.root / "control"

    @property
    def claims_dir(self) -> Path:
        return self.root / "claims"

    @property
    def cursors_dir(self) -> Path:
        return self.root / "cursors"

    @property
    def worker_map(self) -> Path:
        return self.root / "workers.json"


class TeamStore:
    def __init__(self, team_id: str):
        ensure_dirs()
        self.team_id = safe_id(team_id, "team_id")
        self.paths = TeamPaths(self.team_id)

    def exists(self) -> bool:
        return self.paths.config.exists()

    def ensure(self) -> None:
        self.paths.root.mkdir(parents=True, exist_ok=True)
        self.paths.mailbox_dir.mkdir(exist_ok=True)
        self.paths.control_dir.mkdir(exist_ok=True)
        self.paths.claims_dir.mkdir(exist_ok=True)
        self.paths.cursors_dir.mkdir(exist_ok=True)
        if not self.paths.runtime.exists():
            write_json(self.paths.runtime, {"state": "stopped", "event_seq": 0, "tmux_session": None, "updatedAt": utc_now()})
        if not self.paths.tasks.exists():
            write_json(self.paths.tasks, {"tasks": []})
        if not self.paths.worker_map.exists():
            write_json(self.paths.worker_map, {"workers": []})

    def load_config(self) -> dict[str, Any]:
        cfg = read_json(self.paths.config, {}) or {}
        if "members" not in cfg or not isinstance(cfg.get("members"), list):
            cfg["members"] = []
        return cfg

    def save_config(self, cfg: dict[str, Any]) -> None:
        cfg["updatedAt"] = utc_now()
        write_json(self.paths.config, cfg)

    def load_runtime(self) -> dict[str, Any]:
        return read_json(self.paths.runtime, {"state": "stopped", "event_seq": 0, "tmux_session": None}) or {"state": "stopped", "event_seq": 0, "tmux_session": None}

    def save_runtime(self, runtime: dict[str, Any]) -> None:
        runtime["updatedAt"] = utc_now()
        write_json(self.paths.runtime, runtime)

    def load_tasks(self) -> dict[str, Any]:
        doc = read_json(self.paths.tasks, {"tasks": []}) or {"tasks": []}
        if not isinstance(doc.get("tasks"), list):
            doc["tasks"] = []
        return doc

    def save_tasks(self, tasks: dict[str, Any]) -> None:
        tasks["updatedAt"] = utc_now()
        write_json(self.paths.tasks, tasks)

    def next_event_id(self) -> int:
        with file_lock(self.paths.root / ".runtime.lock"):
            rt = self.load_runtime()
            seq = int(rt.get("event_seq", 0)) + 1
            rt["event_seq"] = seq
            self.save_runtime(rt)
            return seq

    def emit_event(self, event_type: str, **payload: Any) -> dict[str, Any]:
        event = {"id": self.next_event_id(), "ts": utc_now(), "type": event_type, **payload}
        append_jsonl(self.paths.events, event)
        return event

    def compact_events(self, keep: int = EVENT_COMPACT_KEEP) -> int:
        events = read_jsonl(self.paths.events)
        if len(events) <= keep:
            return 0
        trimmed = events[-keep:]
        write_jsonl(self.paths.events, trimmed)
        return len(events) - len(trimmed)

    def members_by_id(self) -> dict[str, dict[str, Any]]:
        cfg = self.load_config()
        out: dict[str, dict[str, Any]] = {}
        for m in cfg.get("members", []):
            mid = m.get("memberId") or m.get("agentId") or m.get("name")
            if isinstance(mid, str):
                out[mid] = m
        return out


def load_index() -> dict[str, Any]:
    return read_json(TEAM_INDEX_FILE, {"teams": []}) or {"teams": []}


def save_index(index: dict[str, Any]) -> None:
    write_json(TEAM_INDEX_FILE, index)


def list_teams() -> list[dict[str, Any]]:
    ensure_dirs()
    teams = []
    for d in sorted(TEAMS_DIR.iterdir()):
        if not d.is_dir():
            continue
        cfg = read_json(d / "config.json", None)
        if not isinstance(cfg, dict):
            continue
        rt = read_json(d / "runtime.json", {"state": "unknown"}) or {"state": "unknown"}
        teams.append({
            "team_id": d.name,
            "name": cfg.get("name", d.name),
            "description": cfg.get("description", ""),
            "members": len(cfg.get("members", [])) if isinstance(cfg.get("members"), list) else 0,
            "state": rt.get("state", "unknown"),
            "tmux_session": rt.get("tmux_session"),
            "updatedAt": cfg.get("updatedAt") or rt.get("updatedAt"),
        })
    return teams


def get_session_file(session_id: str) -> Path:
    sid = safe_id(session_id[:8], "session_id")
    return TERMINALS_DIR / f"session-{sid}.json"


def get_session_data(session_id: str) -> dict[str, Any] | None:
    return read_json(get_session_file(session_id), None)


def team_member_lookup_by_session(sid8: str) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    sid8 = safe_id(sid8[:8], "session_id")
    for team in list_teams():
        store = TeamStore(team["team_id"])
        cfg = store.load_config()
        for m in cfg.get("members", []):
            if (m.get("sessionId") or "")[:8] == sid8:
                out.append((store.team_id, m))
    return out


def ensure_member_defaults(member: dict[str, Any]) -> dict[str, Any]:
    if "memberId" not in member:
        raw = member.get("agentId") or member.get("name") or f"member-{int(time.time())}"
        member["memberId"] = slugify(str(raw), "member")
    member.setdefault("name", member["memberId"])
    member.setdefault("role", "teammate")
    member.setdefault("kind", "session")
    member.setdefault("status", "idle")
    member.setdefault("createdAt", utc_now())
    return member


def load_message_ledger(store: TeamStore) -> list[dict[str, Any]]:
    return read_jsonl(store.paths.messages)


def latest_messages_by_id(store: TeamStore) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in load_message_ledger(store):
        mid = row.get("id")
        if isinstance(mid, str):
            latest[mid] = row
    return latest


def message_exists(store: TeamStore, message_id: str) -> bool:
    return message_id in latest_messages_by_id(store)


def append_message_ledger(store: TeamStore, row: dict[str, Any]) -> None:
    append_jsonl(store.paths.messages, row)


def claim_file_path(store: TeamStore, task_id: str) -> Path:
    return store.paths.claims_dir / f"{task_id}.json"


def expire_stale_claims(store: TeamStore) -> list[str]:
    expired: list[str] = []
    now = now_epoch()
    for cf in store.paths.claims_dir.glob("*.json"):
        data = read_json(cf, None)
        if not isinstance(data, dict):
            continue
        exp = parse_ts(data.get("expiresAt"))
        if exp and exp < now:
            data["status"] = "expired"
            write_json(cf, data)
            expired.append(str(data.get("taskId") or cf.stem))
    if not expired:
        return expired

    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        changed = False
        for tid in expired:
            t = _get_task(doc, tid)
            if not t:
                continue
            if t.get("status") in {"claimed", "in_progress"} and t.get("claimedBy"):
                previous_owner = t.get("claimedBy")
                t["claimedBy"] = None
                t["claimedAt"] = None
                if t.get("status") == "claimed":
                    t["status"] = "pending"
                t["updatedAt"] = utc_now()
                t.setdefault("history", []).append({"ts": utc_now(), "action": "claim_expired", "by": "runtime", "previousOwner": previous_owner})
                store.emit_event("TaskClaimExpired", taskId=tid, previousOwner=previous_owner)
                changed = True
        if changed:
            _refresh_task_blocked_state(doc)
            store.save_tasks(doc)
    return expired


def refresh_member_claim_heartbeats(store: TeamStore, member_id: str) -> int:
    count = 0
    now_s = utc_now()
    exp_s = datetime.fromtimestamp(now_epoch() + CLAIM_TTL_SECONDS, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        for t in doc.get("tasks", []):
            if t.get("claimedBy") != member_id:
                continue
            if t.get("status") not in {"claimed", "in_progress"}:
                continue
            cf = claim_file_path(store, t.get("taskId"))
            claim = read_json(cf, {}) or {}
            claim.update({
                "taskId": t.get("taskId"),
                "claimedBy": member_id,
                "files": [canonical_path(f) for f in (t.get("files") or [])],
                "ttlSeconds": int(claim.get("ttlSeconds") or CLAIM_TTL_SECONDS),
                "heartbeatAt": now_s,
                "expiresAt": exp_s,
                "claimedAt": t.get("claimedAt"),
                "status": "active",
            })
            write_json(cf, claim)
            count += 1
    return count


def cmd_team_create(args: argparse.Namespace) -> str:
    team_id = safe_id(args.team_id or slugify(args.name, "team"), "team_id")
    store = TeamStore(team_id)
    if store.exists() and not args.force:
        raise SystemExit(f"Team {team_id} already exists. Use --force to overwrite config fields.")
    store.ensure()
    lead_member_id = safe_id(args.lead_member_id or "lead", "lead_member_id")
    cfg = {
        "id": team_id,
        "name": args.name,
        "description": args.description or "",
        "createdAt": utc_now(),
        "leadMemberId": lead_member_id,
        "leadSessionId": (args.lead_session_id or "")[:8] or None,
        "members": [ensure_member_defaults({
            "memberId": lead_member_id,
            "name": args.lead_name or "lead",
            "role": "lead",
            "kind": "session",
            "sessionId": (args.lead_session_id or "")[:8] or None,
            "cwd": args.cwd,
        })],
    }
    store.save_config(cfg)
    rt = store.load_runtime()
    rt["state"] = "stopped"
    rt.setdefault("tmux_session", None)
    store.save_runtime(rt)
    index = load_index()
    teams = [t for t in index.get("teams", []) if t.get("id") != team_id]
    teams.append({"id": team_id, "name": args.name, "createdAt": utc_now()})
    index["teams"] = teams
    save_index(index)
    return f"Created team {team_id} ({args.name}) with lead member '{lead_member_id}'."


def cmd_team_list(args: argparse.Namespace) -> str:
    rows = list_teams()
    if not rows:
        return "No teams found."
    lines = ["| Team | Name | State | Members | tmux |", "|---|---|---|---:|---|"]
    for t in rows:
        lines.append(f"| {t['team_id']} | {t['name']} | {t['state']} | {t['members']} | {t.get('tmux_session') or '—'} |")
    return "\n".join(lines)


def _ensure_tmux_session(store: TeamStore, cwd: str | None = None) -> str:
    rt = store.load_runtime()
    tmux_session = rt.get("tmux_session") or f"claude-team-{store.team_id}"
    check = subprocess.run(["tmux", "has-session", "-t", tmux_session], capture_output=True)
    if check.returncode != 0:
        cmd = ["tmux", "new-session", "-d", "-s", tmux_session]
        if cwd:
            cmd += ["-c", cwd]
        subprocess.run(cmd, check=True)
    rt["tmux_session"] = tmux_session
    rt.setdefault("state", "running")
    store.save_runtime(rt)
    return tmux_session


def cmd_team_start(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    store.ensure()
    cfg = store.load_config()
    lead = next((m for m in cfg.get("members", []) if m.get("memberId") == cfg.get("leadMemberId")), None)
    cwd = args.cwd or (lead or {}).get("cwd") or str(HOME)
    tmux_session = _ensure_tmux_session(store, cwd)
    rt = store.load_runtime()
    rt["state"] = "running"
    store.save_runtime(rt)
    return f"Team {store.team_id} started. tmux session: {tmux_session}"


def cmd_team_stop(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    rt = store.load_runtime()
    tmux_session = rt.get("tmux_session")
    msgs = []
    if tmux_session:
        if args.kill_panes:
            subprocess.run(["tmux", "kill-session", "-t", tmux_session], check=False)
            msgs.append(f"Killed tmux session {tmux_session}")
        else:
            subprocess.run(["tmux", "set-option", "-t", tmux_session, "remain-on-exit", "on"], check=False)
            msgs.append(f"Left tmux session {tmux_session} running (no --kill-panes)")
    rt["state"] = "stopped"
    store.save_runtime(rt)
    return "\n".join(msgs + [f"Team {store.team_id} marked stopped."])


def cmd_team_status(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    cfg = store.load_config()
    rt = store.load_runtime()
    tasks_doc = store.load_tasks()
    tasks = tasks_doc.get("tasks", [])
    counts: dict[str, int] = {}
    for t in tasks:
        counts[t.get("status", "unknown")] = counts.get(t.get("status", "unknown"), 0) + 1
    lines = [
        f"## Team {store.team_id}",
        f"- Name: {cfg.get('name', store.team_id)}",
        f"- State: {rt.get('state', 'unknown')}",
        f"- tmux: {rt.get('tmux_session') or '—'}",
        f"- Members: {len(cfg.get('members', []))}",
        f"- Tasks: total={len(tasks)} pending={counts.get('pending',0)} in_progress={counts.get('in_progress',0)} completed={counts.get('completed',0)} blocked={counts.get('blocked',0)}",
    ]
    lines.append("\n### Members")
    for m in cfg.get("members", []):
        sid = m.get("sessionId") or "—"
        pane = m.get("paneId") or "—"
        lines.append(f"- {m.get('memberId')} ({m.get('role','teammate')}/{m.get('kind','?')}): status={m.get('status','?')} session={sid} pane={pane}")
    if args.include_tasks and tasks:
        lines.append("\n### Tasks")
        for t in tasks:
            deps = ",".join(t.get("dependsOn", [])) or "—"
            claim = t.get("claimedBy") or "—"
            lines.append(f"- {t['taskId']} [{t['status']}] claim={claim} deps={deps} :: {t['title']}")
    return "\n".join(lines)


def _update_member(store: TeamStore, member_id: str, mutate_fn):
    cfg = store.load_config()
    found = False
    for i, m in enumerate(cfg.get("members", [])):
        if m.get("memberId") == member_id:
            nm = dict(m)
            mutate_fn(nm)
            cfg["members"][i] = ensure_member_defaults(nm)
            found = True
            break
    if not found:
        raise SystemExit(f"Member {member_id} not found in team {store.team_id}.")
    store.save_config(cfg)


def cmd_member_add(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    cfg = store.load_config()
    member_id = safe_id(args.member_id or slugify(args.name or args.role or "member", "member"), "member_id")
    if any((m.get("memberId") == member_id) for m in cfg.get("members", [])):
        raise SystemExit(f"Member {member_id} already exists.")
    m = ensure_member_defaults({
        "memberId": member_id,
        "name": args.name or member_id,
        "role": args.role or "teammate",
        "kind": args.kind or "session",
        "sessionId": (args.session_id or "")[:8] or None,
        "cwd": args.cwd,
        "status": "idle",
    })
    cfg.setdefault("members", []).append(m)
    store.save_config(cfg)
    return f"Added member {member_id} ({m['kind']}) to team {store.team_id}."


def cmd_member_attach_session(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    sid8 = safe_id(args.session_id[:8], "session_id")
    member_id = safe_id(args.member_id, "member_id")
    session_data = get_session_data(sid8)

    def mutate(m: dict[str, Any]):
        m["sessionId"] = sid8
        m["kind"] = m.get("kind") or "session"
        m["status"] = "active"
        if args.cwd:
            m["cwd"] = args.cwd
        elif session_data and session_data.get("cwd"):
            m["cwd"] = session_data.get("cwd")
        if session_data:
            if session_data.get("tty"):
                m["tty"] = session_data.get("tty")
            if session_data.get("host_pid"):
                m["hostPid"] = session_data.get("host_pid")
        m["lastSeen"] = utc_now()

    _update_member(store, member_id, mutate)
    store.emit_event("TeammateAttached", memberId=member_id, sessionId=sid8)

    # Deliver any mailbox backlog to terminal inbox now that session is known.
    mailbox = store.paths.mailbox_dir / f"{member_id}.jsonl"
    if mailbox.exists() and mailbox.stat().st_size > 0:
        terminal_inbox = INBOX_DIR / f"{sid8}.jsonl"
        with mailbox.open("r", encoding="utf-8") as src, terminal_inbox.open("a", encoding="utf-8") as dst:
            for line in src:
                if line.strip():
                    dst.write(line)
        mailbox.write_text("")

    return f"Attached session {sid8} to {store.team_id}:{member_id}."


def _tmux_run(*cmd: str, capture: bool = True) -> str:
    proc = subprocess.run(["tmux", *cmd], check=True, capture_output=capture, text=True)
    return (proc.stdout or "").strip()


def cmd_teammate_spawn_pane(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    member_id = safe_id(args.member_id, "member_id")
    cfg = store.load_config()
    if not any(m.get("memberId") == member_id for m in cfg.get("members", [])):
        cfg.setdefault("members", []).append(ensure_member_defaults({
            "memberId": member_id,
            "name": args.name or member_id,
            "role": args.role or "teammate",
            "kind": "pane",
            "cwd": args.cwd,
            "status": "starting",
        }))
        store.save_config(cfg)
    tmux_session = _ensure_tmux_session(store, args.cwd)

    # Prefer split panes for "in-process teammate" UX, but fall back to a new tmux
    # window when layout constraints prevent another split.
    target_window = f"{tmux_session}:0"
    pane_info = ""
    spawn_mode = "split-window"
    try:
        split_args = ["split-window", "-P", "-F", "#{pane_id} #{pane_tty}", "-t", target_window]
        if args.cwd:
            split_args += ["-c", args.cwd]
        pane_info = _tmux_run(*split_args)
    except subprocess.CalledProcessError:
        spawn_mode = "new-window"
        new_args = ["new-window", "-P", "-F", "#{pane_id} #{pane_tty}", "-t", tmux_session]
        if args.cwd:
            new_args += ["-c", args.cwd]
        pane_info = _tmux_run(*new_args)
    parts = pane_info.split()
    pane_id = parts[0] if parts else None
    pane_tty = parts[1] if len(parts) > 1 else None
    if not pane_id:
        raise SystemExit("Failed to create tmux pane.")

    shell_cmd_parts = [
        f"export CLAUDE_TEAM_ID={shlex.quote(store.team_id)}",
        f"export CLAUDE_TEAM_MEMBER_ID={shlex.quote(member_id)}",
        "export CLAUDE_TEAM_RUNTIME=1",
    ]
    if args.cwd:
        shell_cmd_parts.append(f"cd {shlex.quote(args.cwd)}")
    claude_cmd = "claude"
    if args.agent:
        claude_cmd += f" --agent {shlex.quote(args.agent)}"
    if args.model:
        claude_cmd += f" --model {shlex.quote(args.model)}"
    if args.initial_prompt:
        claude_cmd += f" --prompt {shlex.quote(args.initial_prompt)}"
    shell_cmd_parts.append(claude_cmd)
    cmd_str = "; ".join(shell_cmd_parts)
    _tmux_run("send-keys", "-t", pane_id, cmd_str, "C-m", capture=False)

    def mutate(m: dict[str, Any]):
        m["kind"] = "pane"
        m["paneId"] = pane_id
        m["paneTty"] = pane_tty
        m["tmuxSession"] = tmux_session
        m["tmuxSpawnMode"] = spawn_mode
        m["cwd"] = args.cwd or m.get("cwd")
        m["status"] = "starting"
        m["lastSpawnedAt"] = utc_now()

    _update_member(store, member_id, mutate)
    store.emit_event("TeammateSpawned", memberId=member_id, kind="pane", paneId=pane_id, tmuxSession=tmux_session, spawnMode=spawn_mode)

    return (
        f"Spawned in-process teammate {member_id} in tmux pane {pane_id} ({pane_tty or 'tty?'}) for team {store.team_id} [{spawn_mode}].\n"
        f"tmux session: {tmux_session}\n"
        f"Attach with: tmux attach-session -t {tmux_session}"
    )


def cmd_teammate_focus(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    members = store.members_by_id()
    m = members.get(args.member_id)
    if not m:
        raise SystemExit(f"Member {args.member_id} not found.")
    pane_id = m.get("paneId")
    tmux_session = m.get("tmuxSession") or store.load_runtime().get("tmux_session")
    if pane_id and tmux_session:
        subprocess.run(["tmux", "select-pane", "-t", pane_id], check=False)
        subprocess.run(["tmux", "select-window", "-t", f"{tmux_session}:0"], check=False)
        return f"Focused tmux pane {pane_id} for {store.team_id}:{args.member_id}."
    sid = (m.get("sessionId") or "")[:8]
    if sid:
        return f"Member {args.member_id} is session-backed ({sid}). Use coord_wake_session for frontmost focus/injection."
    raise SystemExit(f"Member {args.member_id} has no pane/session target.")


def _signal_pid(pid: int, sig: int) -> bool:
    try:
        os.kill(pid, sig)
        return True
    except Exception:
        return False


def cmd_teammate_interrupt(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    members = store.members_by_id()
    m = members.get(args.member_id)
    if not m:
        raise SystemExit(f"Member {args.member_id} not found.")
    pane_id = m.get("paneId")
    if pane_id:
        _tmux_run("send-keys", "-t", pane_id, "C-c", capture=False)
        if args.message:
            _tmux_run("send-keys", "-t", pane_id, args.message, "C-m", capture=False)
        store.emit_event("TeammateInterrupted", memberId=args.member_id, mode="tmux", reason=args.message or None)
        return f"Sent Ctrl-C to {store.team_id}:{args.member_id} ({pane_id})."

    sid = (m.get("sessionId") or "")[:8]
    if sid:
        session = get_session_data(sid) or {}
        pid = session.get("host_pid") or m.get("hostPid")
        if pid and str(pid).isdigit() and _signal_pid(int(pid), signal.SIGINT):
            store.emit_event("TeammateInterrupted", memberId=args.member_id, mode="signal", sessionId=sid)
            return f"Sent SIGINT to session-backed teammate {args.member_id} (session {sid}, pid {pid})."
        # Fallback to terminal inbox message.
        inbox_msg = {
            "ts": utc_now(),
            "from": "team-control",
            "priority": "urgent",
            "content": f"[INTERRUPT REQUEST] {args.message or 'Stop current action and report status.'}",
        }
        append_jsonl(INBOX_DIR / f"{sid}.jsonl", inbox_msg)
        store.emit_event("TeammateInterrupted", memberId=args.member_id, mode="inbox", sessionId=sid)
        return f"Session {sid} has no signalable pid. Sent urgent interrupt request via inbox."

    raise SystemExit(f"No interrupt target for member {args.member_id}.")


def _deliver_to_member_session(store: TeamStore, member: dict[str, Any], msg: dict[str, Any]) -> dict[str, Any]:
    sid = (member.get("sessionId") or "")[:8]
    result = {"status": "queued", "deliveredAt": None, "retryCount": 0, "channel": "mailbox"}
    if sid:
        payload = {
            "ts": msg["ts"],
            "from": f"team:{store.team_id}/{msg['fromMember']}",
            "priority": msg.get("priority", "normal"),
            "content": msg["content"],
            "team_message_id": msg["id"],
        }
        inbox_file = INBOX_DIR / f"{sid}.jsonl"
        try:
            append_jsonl(inbox_file, payload)
            result = {"status": "delivered", "deliveredAt": utc_now(), "retryCount": 0, "channel": "session-inbox", "sessionId": sid}
        except Exception:
            # Retry once, then mailbox fallback.
            try:
                append_jsonl(inbox_file, payload)
                result = {"status": "delivered", "deliveredAt": utc_now(), "retryCount": 1, "channel": "session-inbox", "sessionId": sid}
            except Exception:
                append_jsonl(store.paths.mailbox_dir / f"{member['memberId']}.jsonl", msg)
                result = {"status": "queued", "deliveredAt": None, "retryCount": 2, "channel": "mailbox-fallback", "sessionId": sid}
    else:
        append_jsonl(store.paths.mailbox_dir / f"{member['memberId']}.jsonl", msg)
        result = {"status": "queued", "deliveredAt": None, "retryCount": 0, "channel": "mailbox"}
    return result


def cmd_message_send(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    members = store.members_by_id()
    frm = members.get(args.from_member)
    to = members.get(args.to_member)
    if not frm:
        raise SystemExit(f"Sender {args.from_member} not found.")
    if not to:
        raise SystemExit(f"Recipient {args.to_member} not found.")
    message_id = safe_id(args.message_id or f"M{int(time.time() * 1000)}", "message_id")
    if message_exists(store, message_id):
        existing = latest_messages_by_id(store).get(message_id) or {}
        return f"Message {message_id} already exists (status={existing.get('status','unknown')}). Duplicate suppressed."
    expires_at = datetime.fromtimestamp(now_epoch() + int(args.ttl_seconds or MESSAGE_TTL_SECONDS), tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    msg = {
        "id": message_id,
        "ts": utc_now(),
        "fromMember": args.from_member,
        "toMember": args.to_member,
        "priority": args.priority,
        "content": args.content,
        "status": "queued",
        "deliveredAt": None,
        "acknowledgedAt": None,
        "retryCount": 0,
        "expiresAt": expires_at,
    }
    delivery = _deliver_to_member_session(store, to, msg)
    msg.update(delivery)
    append_message_ledger(store, msg)
    event_type = "PeerMessageDelivered" if msg["status"] == "delivered" else "PeerMessageQueued"
    store.emit_event(event_type, fromMember=args.from_member, toMember=args.to_member, messageId=msg["id"], channel=msg.get("channel"))
    return f"{'Delivered' if msg['status']=='delivered' else 'Queued'} peer message {msg['id']} from {args.from_member} to {args.to_member} (channel={msg.get('channel')})."


def cmd_message_inbox(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    mid = safe_id(args.member_id, "member_id")
    mailbox = store.paths.mailbox_dir / f"{mid}.jsonl"
    msgs = read_jsonl(mailbox)
    if args.clear:
        mailbox.write_text("")
    if not msgs:
        return f"No team mailbox messages for {mid}."
    lines = [f"## Mailbox {store.team_id}:{mid} ({len(msgs)} message(s))"]
    for m in msgs[-20:]:
        lines.append(f"- {m.get('ts')} {m.get('fromMember')} -> {m.get('toMember')} [{m.get('priority','normal')}] {m.get('content')}")
    return "\n".join(lines)


def cmd_message_ack(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    message_id = safe_id(args.message_id, "message_id")
    latest = latest_messages_by_id(store).get(message_id)
    if not latest:
        raise SystemExit(f"Message {message_id} not found.")
    ack_row = dict(latest)
    ack_row["ts"] = utc_now()
    ack_row["status"] = "acknowledged"
    ack_row["acknowledgedAt"] = ack_row["ts"]
    ack_row["acknowledgedBy"] = safe_id(args.member_id, "member_id")
    append_message_ledger(store, ack_row)
    store.emit_event("PeerMessageAcknowledged", messageId=message_id, memberId=ack_row["acknowledgedBy"])
    return f"Acknowledged message {message_id} by {ack_row['acknowledgedBy']}."


def _get_task(tasks_doc: dict[str, Any], task_id: str) -> dict[str, Any] | None:
    for t in tasks_doc.get("tasks", []):
        if t.get("taskId") == task_id:
            return t
    return None


def _dependency_unmet(tasks_doc: dict[str, Any], deps: list[str]) -> list[str]:
    unmet = []
    for dep in deps:
        t = _get_task(tasks_doc, dep)
        if not t or t.get("status") != "completed":
            unmet.append(dep)
    return unmet


def _check_file_claim_conflicts(store: TeamStore, tasks_doc: dict[str, Any], file_paths: list[str], task_id: str | None = None) -> list[str]:
    conflicts = []
    if not file_paths:
        return conflicts
    normalized = {canonical_path(f) for f in file_paths}
    for t in tasks_doc.get("tasks", []):
        if task_id and t.get("taskId") == task_id:
            continue
        if t.get("status") not in {"in_progress", "claimed"}:
            continue
        if not t.get("claimedBy"):
            continue
        overlap = normalized.intersection({canonical_path(f) for f in (t.get("files", []) or [])})
        if overlap:
            age = format_age(now_epoch() - int(parse_ts(t.get("claimedAt")) or now_epoch()))
            conflicts.append(f"{t.get('taskId')} ({t.get('claimedBy')}, age={age}): {', '.join(sorted(overlap))}")
    return conflicts


def cmd_task_add(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        task_id = safe_id(args.task_id or f"T{int(time.time())}", "task_id")
        if _get_task(doc, task_id):
            raise SystemExit(f"Task {task_id} already exists.")
        deps = [safe_id(d, "depends_on") for d in (args.depends_on or [])]
        unmet = [d for d in deps if _get_task(doc, d) is None]
        if unmet:
            raise SystemExit(f"Unknown dependency task(s): {', '.join(unmet)}")
        files = [canonical_path(f) for f in (args.files or [])]
        task = {
            "taskId": task_id,
            "title": args.title,
            "description": args.description or "",
            "status": "blocked" if deps else "pending",
            "dependsOn": deps,
            "files": files,
            "claimedBy": None,
            "claimedAt": None,
            "assignee": args.assignee,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
            "history": [{"ts": utc_now(), "action": "created", "by": args.created_by or "lead"}],
        }
        doc["tasks"].append(task)
        store.save_tasks(doc)
    store.emit_event("TaskAdded", taskId=task_id, title=args.title)
    return f"Added task {task_id} [{task['status']}] to team {store.team_id}."


def cmd_task_list(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    doc = store.load_tasks()
    tasks = doc.get("tasks", [])
    if args.status:
        tasks = [t for t in tasks if t.get("status") == args.status]
    if not tasks:
        return "No tasks found."
    lines = ["| Task | Status | Claimed By | Depends | Title |", "|---|---|---|---|---|"]
    for t in tasks:
        lines.append(
            f"| {t.get('taskId')} | {t.get('status')} | {t.get('claimedBy') or '—'} | {','.join(t.get('dependsOn',[])) or '—'} | {t.get('title')} |"
        )
    return "\n".join(lines)


def _refresh_task_blocked_state(tasks_doc: dict[str, Any]) -> None:
    for t in tasks_doc.get("tasks", []):
        deps = t.get("dependsOn", []) or []
        if t.get("status") in {"completed", "cancelled"}:
            continue
        unmet = _dependency_unmet(tasks_doc, deps)
        if unmet:
            if t.get("status") not in {"in_progress", "claimed"}:
                t["status"] = "blocked"
        else:
            if t.get("status") == "blocked":
                t["status"] = "pending"
        t["updatedAt"] = utc_now()


def cmd_task_claim(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        task = _get_task(doc, args.task_id)
        if not task:
            raise SystemExit(f"Task {args.task_id} not found.")
        unmet = _dependency_unmet(doc, task.get("dependsOn", []))
        if unmet and not args.force:
            raise SystemExit(f"Task {args.task_id} is blocked by: {', '.join(unmet)}")
        if task.get("claimedBy") and task.get("claimedBy") != args.member_id and not args.force:
            raise SystemExit(f"Task {args.task_id} already claimed by {task.get('claimedBy')}.")
        conflicts = _check_file_claim_conflicts(store, doc, task.get("files", []), task_id=args.task_id)
        if conflicts and not args.force:
            raise SystemExit("File-claim conflict(s):\n" + "\n".join(f"- {c}" for c in conflicts))

        previous_owner = task.get("claimedBy")
        task["claimedBy"] = args.member_id
        task["claimedAt"] = utc_now()
        task["status"] = "claimed"
        task.setdefault("history", []).append({"ts": utc_now(), "action": "claimed", "by": args.member_id, "force": bool(args.force), "previousOwner": previous_owner})
        claim_doc = {
            "taskId": args.task_id,
            "claimedBy": args.member_id,
            "claimedAt": task["claimedAt"],
            "files": [canonical_path(f) for f in (task.get("files") or [])],
            "ttlSeconds": int(args.ttl_seconds or CLAIM_TTL_SECONDS),
            "heartbeatAt": utc_now(),
            "expiresAt": datetime.fromtimestamp(now_epoch() + int(args.ttl_seconds or CLAIM_TTL_SECONDS), tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "forceClaim": bool(args.force),
            "previousOwner": previous_owner,
            "status": "active",
        }
        write_json(claim_file_path(store, args.task_id), claim_doc)
        store.save_tasks(doc)
    store.emit_event("TaskClaimed", taskId=args.task_id, memberId=args.member_id, force=bool(args.force))
    return f"Task {args.task_id} claimed by {args.member_id}."


def cmd_task_update(args: argparse.Namespace) -> str:
    allowed = {"pending", "blocked", "claimed", "in_progress", "completed", "cancelled"}
    if args.status not in allowed:
        raise SystemExit(f"Invalid status: {args.status}")
    store = TeamStore(args.team_id)
    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        task = _get_task(doc, args.task_id)
        if not task:
            raise SystemExit(f"Task {args.task_id} not found.")
        if args.status in {"claimed", "in_progress"} and not (task.get("claimedBy") or args.member_id):
            raise SystemExit("Claim or provide --member-id before marking in_progress.")
        if args.member_id and not task.get("claimedBy"):
            task["claimedBy"] = args.member_id
            task["claimedAt"] = utc_now()
        prev = task.get("status")
        task["status"] = args.status
        task["updatedAt"] = utc_now()
        if args.note:
            task["lastNote"] = args.note
        task.setdefault("history", []).append({"ts": utc_now(), "action": f"status:{args.status}", "by": args.member_id or "unknown", "note": args.note})
        if args.status in {"completed", "cancelled", "pending", "blocked"}:
            claim_file = claim_file_path(store, args.task_id)
            if claim_file.exists():
                claim_file.unlink(missing_ok=True)
            if args.status in {"completed", "cancelled"}:
                task["claimedBy"] = None
        _refresh_task_blocked_state(doc)
        store.save_tasks(doc)

    store.emit_event("TaskUpdated", taskId=args.task_id, status=args.status, previousStatus=prev)
    if args.status == "completed":
        store.emit_event("TaskCompleted", taskId=args.task_id, completedBy=args.member_id or prev or "unknown", note=args.note or None)
    return f"Task {args.task_id} updated: {prev} -> {args.status}."


def cmd_task_release_claim(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    with file_lock(store.paths.root / ".tasks.lock"):
        doc = store.load_tasks()
        task = _get_task(doc, args.task_id)
        if not task:
            raise SystemExit(f"Task {args.task_id} not found.")
        owner = task.get("claimedBy")
        if not owner:
            return f"Task {args.task_id} is not claimed."
        if args.member_id and owner != args.member_id and not args.force:
            raise SystemExit(f"Task {args.task_id} is claimed by {owner}, not {args.member_id}.")
        task["claimedBy"] = None
        task["claimedAt"] = None
        if task.get("status") in {"claimed", "in_progress"}:
            task["status"] = "pending"
        task["updatedAt"] = utc_now()
        task.setdefault("history", []).append({"ts": utc_now(), "action": "claim_released", "by": args.member_id or "runtime", "force": bool(args.force)})
        cf = claim_file_path(store, args.task_id)
        if cf.exists():
            cf.unlink(missing_ok=True)
        _refresh_task_blocked_state(doc)
        store.save_tasks(doc)
    store.emit_event("TaskClaimReleased", taskId=args.task_id, previousOwner=owner, by=args.member_id or "runtime")
    return f"Released claim on {args.task_id} (previous owner: {owner})."


def cmd_event_check(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    events = read_jsonl(store.paths.events)
    if args.types:
        wanted = {t.strip() for t in args.types.split(",") if t.strip()}
        events = [e for e in events if e.get("type") in wanted]
    since_id = args.since_id
    if since_id is not None:
        events = [e for e in events if int(e.get("id", 0)) > since_id]
    cursor_path = None
    if args.consumer:
        cursor_path = store.paths.cursors_dir / f"{safe_id(args.consumer, 'consumer')}.txt"
        if since_id is None and cursor_path.exists():
            try:
                cursor = int(cursor_path.read_text().strip())
                events = [e for e in events if int(e.get("id", 0)) > cursor]
            except Exception:
                pass
    if not events:
        return "No new events."
    if cursor_path:
        cursor_path.write_text(str(max(int(e.get("id", 0)) for e in events)))
    lines = [f"## Events ({len(events)})"]
    for e in events[-50:]:
        details = {k: v for k, v in e.items() if k not in {"id", "ts", "type"}}
        lines.append(f"- #{e.get('id')} {e.get('ts')} {e.get('type')} {json.dumps(details, separators=(',', ':'))}")
    return "\n".join(lines)


def _tmux_session_exists(name: str | None) -> bool:
    if not name:
        return False
    proc = subprocess.run(["tmux", "has-session", "-t", name], capture_output=True)
    return proc.returncode == 0


def _tmux_list_panes(tmux_session: str) -> list[dict[str, str]]:
    if not _tmux_session_exists(tmux_session):
        return []
    out = _tmux_run("list-panes", "-a", "-t", tmux_session, "-F", "#{pane_id}\t#{pane_tty}\t#{pane_active}\t#{pane_current_command}")
    panes = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            panes.append({"paneId": parts[0], "paneTty": parts[1], "active": parts[2], "command": parts[3]})
    return panes


def cmd_team_resume(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    store.ensure()
    cfg = store.load_config()
    rt = store.load_runtime()
    tmux_session = rt.get("tmux_session") or f"claude-team-{store.team_id}"
    if args.ensure_tmux and not _tmux_session_exists(tmux_session):
        lead = next((m for m in cfg.get("members", []) if m.get("memberId") == cfg.get("leadMemberId")), None)
        _ensure_tmux_session(store, (lead or {}).get("cwd") or str(HOME))
    panes = _tmux_list_panes(rt.get("tmux_session") or tmux_session)
    pane_ids = {p["paneId"] for p in panes}
    touched = 0
    for m in cfg.get("members", []):
        # Reconcile pane-backed members
        if m.get("paneId"):
            if m["paneId"] in pane_ids:
                m["status"] = "active" if m.get("sessionId") else "starting"
            else:
                m["status"] = "missing-pane"
            touched += 1
        # Refresh attached session metadata if session file exists
        sid = (m.get("sessionId") or "")[:8]
        if sid:
            sd = get_session_data(sid)
            if sd:
                m["status"] = "active" if sd.get("status") not in {"closed", "stale"} else sd.get("status")
                if sd.get("tty"):
                    m["tty"] = sd.get("tty")
                if sd.get("host_pid"):
                    m["hostPid"] = sd.get("host_pid")
                m["lastSeen"] = utc_now()
                touched += 1
    store.save_config(cfg)
    rt = store.load_runtime()
    rt["state"] = "running" if _tmux_session_exists(rt.get("tmux_session")) else rt.get("state", "stopped")
    store.save_runtime(rt)
    store.emit_event("TeamResumed", repairedMembers=touched)
    return f"Resumed team {store.team_id}. tmux_exists={_tmux_session_exists(rt.get('tmux_session'))} repaired_members={touched}"


def cmd_team_doctor(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    cfg = store.load_config()
    rt = store.load_runtime()
    findings: list[str] = []
    passes: list[str] = []
    tmux_session = rt.get("tmux_session")
    if tmux_session:
        if _tmux_session_exists(tmux_session):
            passes.append(f"tmux session exists: {tmux_session}")
        else:
            findings.append(f"missing tmux session: {tmux_session}")
    else:
        findings.append("runtime missing tmux_session")

    panes = {p["paneId"]: p for p in _tmux_list_panes(tmux_session or "")}
    for m in cfg.get("members", []):
        mid = m.get("memberId")
        if m.get("paneId") and m["paneId"] not in panes:
            findings.append(f"{mid}: pane missing ({m.get('paneId')})")
        if m.get("sessionId"):
            sf = get_session_file(str(m["sessionId"]))
            if not sf.exists():
                findings.append(f"{mid}: session file missing ({m.get('sessionId')})")
            else:
                passes.append(f"{mid}: session file present")
        mb = store.paths.mailbox_dir / f"{mid}.jsonl"
        if not mb.exists():
            passes.append(f"{mid}: mailbox will be created on demand")

    # Tasks/claims consistency
    doc = store.load_tasks()
    for t in doc.get("tasks", []):
        cf = claim_file_path(store, t.get("taskId"))
        if t.get("claimedBy") and t.get("status") in {"claimed", "in_progress"} and not cf.exists():
            findings.append(f"task {t.get('taskId')}: claimed but claim file missing")
        if cf.exists() and (not t.get("claimedBy")):
            findings.append(f"task {t.get('taskId')}: claim file exists but task unclaimed")
    expired = expire_stale_claims(store)
    if expired:
        findings.append(f"expired claims cleaned: {', '.join(expired)}")

    # Cursor integrity
    for c in store.paths.cursors_dir.glob("*.txt"):
        try:
            int(c.read_text().strip() or "0")
        except Exception:
            findings.append(f"bad cursor: {c.name}")

    status = "PASS" if not findings else "WARN"
    lines = [f"## Team Doctor: {store.team_id}", f"- Status: {status}"]
    if passes:
        lines.append("\n### Checks Passed")
        lines.extend([f"- {p}" for p in passes[:20]])
    if findings:
        lines.append("\n### Findings")
        lines.extend([f"- {f}" for f in findings])
    return "\n".join(lines)


def cmd_team_reconcile(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    expired = expire_stale_claims(store)
    compacted = store.compact_events(keep=int(args.keep_events or EVENT_COMPACT_KEEP))
    # Re-run worker bridge if requested
    worker_msg = ""
    if args.include_workers:
        worker_msg = cmd_hook_reconcile_workers(argparse.Namespace())
    store.emit_event("TeamReconciled", expiredClaims=len(expired), compactedEvents=compacted)
    bits = [f"Reconciled team {store.team_id}: expired_claims={len(expired)} compacted_events={compacted}"]
    if expired:
        bits.append("Expired claims: " + ", ".join(expired))
    if worker_msg:
        bits.append(worker_msg)
    return "\n".join(bits)


def _dashboard_task_counts(doc: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in doc.get("tasks", []):
        s = str(t.get("status", "unknown"))
        counts[s] = counts.get(s, 0) + 1
    return counts


def _try_cost_summary(team_id: str | None = None) -> str | None:
    cost_script = CLAUDE_DIR / "scripts" / "cost_runtime.py"
    if not cost_script.exists():
        return None
    argv = ["python3", str(cost_script), "summary", "--window", "today"]
    if team_id:
        argv += ["--team-id", team_id]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=6, check=False)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        return None
    return None


def cmd_team_dashboard(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    cfg = store.load_config()
    rt = store.load_runtime()
    tasks_doc = store.load_tasks()
    task_counts = _dashboard_task_counts(tasks_doc)
    events = read_jsonl(store.paths.events)[-10:]
    msgs = latest_messages_by_id(store)
    pending_msgs = sum(1 for m in msgs.values() if m.get("status") in {"queued", "delivered"})
    lines = [
        f"## Team Dashboard: {store.team_id}",
        f"- State: {rt.get('state','unknown')} | tmux: {rt.get('tmux_session') or '—'}",
        f"- Members: {len(cfg.get('members', []))} | Messages(open): {pending_msgs}",
        f"- Tasks: pending={task_counts.get('pending',0)} blocked={task_counts.get('blocked',0)} claimed={task_counts.get('claimed',0)} in_progress={task_counts.get('in_progress',0)} completed={task_counts.get('completed',0)}",
    ]
    cost = _try_cost_summary(store.team_id)
    if cost:
        lines.append("\n### Cost (Today)")
        lines.append(cost)
    lines.append("\n### Members")
    for m in cfg.get("members", []):
        lines.append(f"- {m.get('memberId')}: role={m.get('role')} kind={m.get('kind')} status={m.get('status')} session={m.get('sessionId') or '—'} pane={m.get('paneId') or '—'}")
    lines.append("\n### Recent Events")
    if not events:
        lines.append("- none")
    else:
        for e in events:
            lines.append(f"- #{e.get('id')} {e.get('type')} {e.get('ts')}")
    return "\n".join(lines)


def _bootstrap_default_teammates(preset: str | None) -> list[str]:
    p = (preset or "standard").strip().lower()
    if p == "lite":
        return [
            "coder-1:coder",
            "reviewer-1:reviewer",
        ]
    if p == "heavy":
        return [
            "planner-1:planner",
            "coder-1:coder",
            "coder-2:coder",
            "reviewer-1:reviewer",
            "research-1:researcher",
        ]
    return [
        "coder-1:coder",
        "reviewer-1:reviewer",
        "research-1:researcher",
    ]


def _auto_bootstrap_preset(team_id: str) -> tuple[str, dict[str, Any]]:
    cost_script = CLAUDE_DIR / "scripts" / "cost_runtime.py"
    profiles = ensure_team_preset_profiles()
    prof_name = str(profiles.get("defaultProfile") or "budget-aware-v1")
    prof = ((profiles.get("profiles") or {}).get(prof_name) or {})
    fallback = str(prof.get("fallbackPreset") or "standard")
    no_budget = str(prof.get("noBudgetPreset") or fallback)
    meta: dict[str, Any] = {"mode": "auto", "profile": prof_name, "selectedPreset": fallback, "reason": "fallback"}
    try:
        budgets_doc = read_json(COST_BUDGETS_FILE, {}) or {}
        cache_doc = read_json(COST_CACHE_FILE, {}) or {}
        windows = cache_doc.get("windows") or {}
        team_key = f"today|team={team_id}|session=|project="
        team_entry = windows.get(team_key) if isinstance(windows, dict) else None
        global_entry = windows.get("today") if isinstance(windows, dict) else None
        team_limit = (((budgets_doc.get("teams") or {}).get(team_id) or {}).get("dailyUSD"))
        global_limit = ((budgets_doc.get("global") or {}).get("dailyUSD"))
        chosen_scope = None
        current_usd = None
        limit_usd = None
        if team_limit and isinstance(team_entry, dict):
            chosen_scope = f"team:{team_id}"
            limit_usd = float(team_limit)
            ttot = (team_entry.get("totals") or {})
            current_usd = ttot.get("totalUSD")
            if current_usd is None:
                current_usd = ttot.get("localCostUSD")
        elif global_limit and isinstance(global_entry, dict):
            chosen_scope = "global"
            limit_usd = float(global_limit)
            gtot = (global_entry.get("totals") or {})
            current_usd = gtot.get("totalUSD")
            if current_usd is None:
                current_usd = gtot.get("localCostUSD")
        if chosen_scope and limit_usd and current_usd is not None:
            pct = (float(current_usd) / float(limit_usd)) * 100.0 if limit_usd else None
            meta.update({
                "budgetScope": chosen_scope,
                "budgetPeriod": "daily",
                "budgetPct": round(float(pct or 0), 2) if pct is not None else None,
                "currentUSD": float(current_usd),
                "limitUSD": float(limit_usd),
                "cacheGeneratedAt": cache_doc.get("generatedAt"),
                "selectionSource": "cost-cache",
            })
            for rule in (prof.get("rules") or []):
                try:
                    max_pct = float(rule.get("maxPct"))
                    preset = str(rule.get("preset"))
                except Exception:
                    continue
                if pct is not None and float(pct) <= max_pct:
                    meta["selectedPreset"] = preset
                    meta["reason"] = f"budget_pct<={max_pct:g}"
                    return preset, meta
    except Exception as e:
        meta["cacheError"] = str(e)[:200]
    # Fast fallback: ccusage statusline is usually much faster than a full summary scan.
    try:
        budgets_doc = read_json(COST_BUDGETS_FILE, {}) or {}
        global_limit = ((budgets_doc.get("global") or {}).get("dailyUSD"))
        if global_limit:
            cp = subprocess.run(
                ["ccusage", "statusline", "--offline", "--cost-source", "both"],
                capture_output=True,
                text=True,
                timeout=4,
            )
            line = (cp.stdout or "").strip()
            m = re.search(r"\$([0-9][0-9,]*(?:\.[0-9]+)?)", line)
            if cp.returncode == 0 and m:
                current_usd = float(m.group(1).replace(",", ""))
                limit_usd = float(global_limit)
                pct = (current_usd / limit_usd) * 100.0 if limit_usd else None
                meta.update({
                    "budgetScope": "global",
                    "budgetPeriod": "daily",
                    "budgetPct": round(float(pct or 0), 2) if pct is not None else None,
                    "currentUSD": current_usd,
                    "limitUSD": limit_usd,
                    "selectionSource": "ccusage-statusline",
                })
                for rule in (prof.get("rules") or []):
                    try:
                        max_pct = float(rule.get("maxPct"))
                        preset = str(rule.get("preset"))
                    except Exception:
                        continue
                    if pct is not None and float(pct) <= max_pct:
                        meta["selectedPreset"] = preset
                        meta["reason"] = f"budget_pct<={max_pct:g}"
                        return preset, meta
    except Exception as e:
        meta["statuslineError"] = str(e)[:200]
    if not cost_script.exists():
        meta["reason"] = "cost_runtime_missing"
        meta["selectedPreset"] = fallback
        return fallback, meta
    try:
        budgets_doc = read_json(COST_BUDGETS_FILE, {}) or {}
        team_has_budget = bool((((budgets_doc.get("teams") or {}).get(team_id) or {}).get("dailyUSD")))
        summary_cmd = ["python3", str(cost_script), "summary", "--window", "today", "--json"]
        if team_has_budget:
            summary_cmd.extend(["--team-id", team_id])
        cp = subprocess.run(
            summary_cmd,
            capture_output=True,
            text=True,
            timeout=45,
        )
        if cp.returncode != 0 or not (cp.stdout or "").strip():
            meta["reason"] = "cost_summary_failed"
            meta["detail"] = (cp.stderr or cp.stdout or "").strip()[:300]
            return fallback, meta
        payload = json.loads(cp.stdout)
        budget = payload.get("budget") or {}
        pct = budget.get("pct")
        current = budget.get("currentUSD")
        limit = budget.get("limitUSD")
        meta.update({
            "budgetScope": budget.get("scope"),
            "budgetPeriod": budget.get("period"),
            "budgetPct": pct,
            "currentUSD": current,
            "limitUSD": limit,
            "selectionSource": "cost-summary",
        })
        if pct is None:
            meta["selectedPreset"] = no_budget
            meta["reason"] = "no_budget_configured"
            return no_budget, meta
        for rule in (prof.get("rules") or []):
            try:
                max_pct = float(rule.get("maxPct"))
                preset = str(rule.get("preset"))
            except Exception:
                continue
            if float(pct) <= max_pct:
                meta["selectedPreset"] = preset
                meta["reason"] = f"budget_pct<={max_pct:g}"
                return preset, meta
        meta["selectedPreset"] = fallback
        meta["reason"] = "no_rule_match"
        return fallback, meta
    except Exception as e:
        meta["reason"] = "auto_select_exception"
        meta["detail"] = str(e)[:300]
        return fallback, meta


def cmd_team_bootstrap(args: argparse.Namespace) -> str:
    team_id = safe_id(args.team_id or slugify(args.name, "team"), "team_id")
    if not TeamStore(team_id).exists():
        cmd_team_create(argparse.Namespace(
            team_id=team_id, name=args.name, description=args.description, lead_session_id=args.lead_session_id,
            lead_member_id=args.lead_member_id, lead_name=args.lead_name, cwd=args.cwd, force=False
        ))
    cmd_team_start(argparse.Namespace(team_id=team_id, cwd=args.cwd))
    preset = (getattr(args, "preset", None) or "standard").lower()
    auto_meta: dict[str, Any] | None = None
    if preset == "auto":
        preset, auto_meta = _auto_bootstrap_preset(team_id)
    teammate_specs = list(args.teammate or _bootstrap_default_teammates(preset))
    spawned: list[str] = []
    skipped: list[str] = []
    existing_members = TeamStore(team_id).members_by_id()
    for spec in teammate_specs:
        parts = [p.strip() for p in spec.split(":")]
        member_id = safe_id(parts[0], "member_id")
        role = parts[1] if len(parts) > 1 and parts[1] else "teammate"
        cwd = parts[2] if len(parts) > 2 and parts[2] else args.cwd
        existing = existing_members.get(member_id)
        if existing and existing.get("paneId"):
            skipped.append(member_id)
            continue
        cmd_teammate_spawn_pane(argparse.Namespace(team_id=team_id, member_id=member_id, name=member_id, role=role, cwd=cwd, agent=None, model=None, initial_prompt=None))
        spawned.append(member_id)
        existing_members = TeamStore(team_id).members_by_id()
    store = TeamStore(team_id)
    store.emit_event("TeamBootstrapped", spawned=spawned, skipped=skipped, preset=preset, auto=auto_meta)
    msg = [f"Bootstrapped team {team_id}.", cmd_team_status(argparse.Namespace(team_id=team_id, include_tasks=False))]
    if auto_meta:
        msg.insert(1, f"Auto preset selected: {preset} ({auto_meta.get('reason')}; burn={auto_meta.get('currentUSD')} / cap={auto_meta.get('limitUSD')} pct={auto_meta.get('budgetPct')})")
    if spawned:
        msg.insert(2 if auto_meta else 1, f"Spawned teammates: {', '.join(spawned)}")
    if skipped:
        idx = 3 if (auto_meta and spawned) else 2 if (auto_meta or spawned) else 1
        msg.insert(idx, f"Skipped already-running teammates: {', '.join(skipped)}")
    return "\n\n".join(msg)


def cmd_team_recover(args: argparse.Namespace) -> str:
    team_id = safe_id(args.team_id, "team_id")
    parts: list[str] = []
    parts.append("## Team Recover")
    parts.append(cmd_team_resume(argparse.Namespace(team_id=team_id, ensure_tmux=bool(args.ensure_tmux))))
    parts.append(cmd_team_reconcile(argparse.Namespace(
        team_id=team_id,
        keep_events=getattr(args, "keep_events", None),
        include_workers=bool(getattr(args, "include_workers", True)),
    )))
    parts.append(cmd_team_doctor(argparse.Namespace(team_id=team_id)))
    TeamStore(team_id).emit_event("TeamRecovered", ensureTmux=bool(args.ensure_tmux), includeWorkers=bool(getattr(args, "include_workers", True)))
    return "\n\n".join(parts)


def cmd_team_teardown(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    summary = {
        "team_id": store.team_id,
        "ts": utc_now(),
        "runtime": store.load_runtime(),
        "task_counts": _dashboard_task_counts(store.load_tasks()),
        "members": store.load_config().get("members", []),
        "recent_events": read_jsonl(store.paths.events)[-20:],
    }
    cost_script = CLAUDE_DIR / "scripts" / "cost_runtime.py"
    if cost_script.exists():
        try:
            out = subprocess.run(["python3", str(cost_script), "summary", "--window", "today", "--team-id", store.team_id, "--json"], capture_output=True, text=True, timeout=8)
            if out.returncode == 0 and out.stdout.strip():
                summary["cost"] = json.loads(out.stdout)
        except Exception:
            pass
    out_file = store.paths.root / f"teardown-summary-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    write_json(out_file, summary)
    stop_msg = cmd_team_stop(argparse.Namespace(team_id=store.team_id, kill_panes=bool(args.kill_panes)))
    store.emit_event("TeamTeardown", summaryFile=str(out_file), killPanes=bool(args.kill_panes))
    return f"{stop_msg}\nSummary: {out_file}"


def _load_worker_map(store: TeamStore) -> dict[str, Any]:
    wm = read_json(store.paths.worker_map, {"workers": []}) or {"workers": []}
    if not isinstance(wm.get("workers"), list):
        wm["workers"] = []
    return wm


def cmd_worker_register(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    if not store.exists():
        raise SystemExit(f"Team {args.team_id} not found.")
    wm = _load_worker_map(store)
    wid = safe_id(args.worker_task_id, "worker_task_id")
    if any(w.get("workerTaskId") == wid for w in wm["workers"]):
        return f"Worker {wid} already registered for team {store.team_id}."
    row = {
        "workerTaskId": wid,
        "taskId": args.task_id,
        "memberId": args.member_id,
        "registeredAt": utc_now(),
        "reported": False,
        "autoCompleteOnWorkerSuccess": bool(args.auto_complete),
    }
    wm["workers"].append(row)
    write_json(store.paths.worker_map, wm)
    store.emit_event("TaskWorkerRegistered", workerTaskId=wid, taskId=args.task_id, memberId=args.member_id)
    return f"Registered worker {wid} for team {store.team_id} task={args.task_id or '—'} member={args.member_id or '—'}."


def cmd_worker_attach_result(args: argparse.Namespace) -> str:
    store = TeamStore(args.team_id)
    wm = _load_worker_map(store)
    wid = safe_id(args.worker_task_id, "worker_task_id")
    target = next((w for w in wm["workers"] if w.get("workerTaskId") == wid), None)
    if not target:
        raise SystemExit(f"Worker {wid} not registered.")
    target["reported"] = True
    target["reportedAt"] = utc_now()
    target["attachedResultAt"] = utc_now()
    if args.task_id:
        target["taskId"] = args.task_id
    if args.member_id:
        target["memberId"] = args.member_id
    write_json(store.paths.worker_map, wm)
    store.emit_event("TaskWorkerAttached", workerTaskId=wid, taskId=target.get("taskId"), memberId=target.get("memberId"))
    return f"Attached worker result {wid} to team {store.team_id}."


def cmd_hook_session_start(args: argparse.Namespace) -> str:
    # Auto-attach session to team/member when spawned with CLAUDE_TEAM_* env vars.
    if not args.team_id or not args.member_id:
        return "No team env vars present."
    store = TeamStore(args.team_id)
    if not store.exists():
        return f"Team {args.team_id} not found; skipping attach."
    try:
        ns = argparse.Namespace(team_id=args.team_id, member_id=args.member_id, session_id=args.session_id, cwd=args.cwd)
        msg = cmd_member_attach_session(ns)
    except SystemExit as e:
        return str(e)
    # Mark pid on session file if provided.
    if args.host_pid:
        sf = get_session_file(args.session_id)
        data = read_json(sf, {}) or {}
        if isinstance(data, dict):
            data["host_pid"] = args.host_pid
            write_json(sf, data)
    return msg


def _scan_and_emit_idle_events() -> list[str]:
    emitted: list[str] = []
    current = now_epoch()
    sessions = {}
    for sf in TERMINALS_DIR.glob("session-*.json"):
        data = read_json(sf, None)
        if isinstance(data, dict) and data.get("session"):
            sessions[str(data.get("session"))[:8]] = data

    for team in list_teams():
        store = TeamStore(team["team_id"])
        cfg = store.load_config()
        changed = False
        for m in cfg.get("members", []):
            sid = (m.get("sessionId") or "")[:8]
            if not sid:
                continue
            s = sessions.get(sid)
            if not s:
                continue
            age = current - int(parse_ts(s.get("last_active")) or 0)
            idle_emitted_at = int(m.get("idleEventAtEpoch", 0) or 0)
            if age >= IDLE_THRESHOLD_SECONDS:
                if idle_emitted_at == 0 or (current - idle_emitted_at) >= IDLE_COOLDOWN_SECONDS:
                    store.emit_event("TeammateIdle", memberId=m.get("memberId"), sessionId=sid, idleSeconds=age)
                    m["idleEventAtEpoch"] = current
                    m["status"] = "idle"
                    emitted.append(f"{store.team_id}:{m.get('memberId')}")
                    changed = True
            else:
                # Reset cooldown marker once active again so future idle transitions emit once.
                if m.get("idleEventAtEpoch"):
                    m["idleEventAtEpoch"] = 0
                    m["status"] = "active"
                    changed = True
                else:
                    if m.get("status") != "active":
                        m["status"] = "active"
                        changed = True
                m["lastSeen"] = utc_now()
                if s.get("tty"):
                    m["tty"] = s.get("tty")
                if s.get("host_pid"):
                    m["hostPid"] = s.get("host_pid")
        if changed:
            store.save_config(cfg)
    return emitted


def cmd_hook_heartbeat(args: argparse.Namespace) -> str:
    emitted = _scan_and_emit_idle_events()
    refreshed = 0
    expired_total = 0
    for team in list_teams():
        store = TeamStore(team["team_id"])
        expired_total += len(expire_stale_claims(store))
        cfg = store.load_config()
        for m in cfg.get("members", []):
            if m.get("status") == "active" and m.get("memberId"):
                refreshed += refresh_member_claim_heartbeats(store, m["memberId"])
    return f"Heartbeat hook scanned teams; emitted {len(emitted)} TeammateIdle event(s); refreshed_claims={refreshed}; expired_claims={expired_total}."


def cmd_hook_session_end(args: argparse.Namespace) -> str:
    sid8 = safe_id(args.session_id[:8], "session_id")
    touched = 0
    for team_id, m in team_member_lookup_by_session(sid8):
        store = TeamStore(team_id)

        def mutate(mem: dict[str, Any]):
            mem["status"] = "closed"
            mem["lastSeen"] = utc_now()

        _update_member(store, m.get("memberId"), mutate)
        store.emit_event("TeammateClosed", memberId=m.get("memberId"), sessionId=sid8)
        touched += 1
    return f"Session-end hook updated {touched} team member(s)."


def cmd_hook_reconcile_workers(args: argparse.Namespace) -> str:
    # Bridge worker completions into team events if team worker mappings exist.
    count = 0
    for team in list_teams():
        store = TeamStore(team["team_id"])
        worker_map = read_json(store.paths.worker_map, {"workers": []}) or {"workers": []}
        changed = False
        for w in worker_map.get("workers", []):
            if w.get("reported"):
                continue
            task_id = w.get("workerTaskId")
            if not task_id:
                continue
            done_file = RESULTS_DIR / f"{task_id}.meta.json.done"
            if not done_file.exists():
                continue
            done = read_json(done_file, {}) or {}
            status = done.get("status", "completed")
            store.emit_event("TaskCompleted" if status == "completed" else "TaskWorkerFinished", taskId=w.get("taskId"), workerTaskId=task_id, memberId=w.get("memberId"), workerStatus=status)
            if w.get("taskId") and status == "completed" and w.get("autoCompleteOnWorkerSuccess", False):
                try:
                    ns = argparse.Namespace(team_id=store.team_id, task_id=w["taskId"], status="completed", member_id=w.get("memberId"), note=f"Worker {task_id} completed", force=False)
                    cmd_task_update(ns)
                except Exception:
                    pass
            w["reported"] = True
            w["reportedAt"] = utc_now()
            count += 1
            changed = True
        if changed:
            write_json(store.paths.worker_map, worker_map)
    return f"Reconciled {count} worker completion(s)."


def cmd_hook_session_events(args: argparse.Namespace) -> str:
    sid8 = safe_id(args.session_id[:8], "session_id")
    memberships = team_member_lookup_by_session(sid8)
    if not memberships:
        return ""
    chunks: list[str] = []
    for team_id, member in memberships:
        store = TeamStore(team_id)
        events = read_jsonl(store.paths.events)
        cursor_path = store.paths.cursors_dir / f"session-{sid8}.txt"
        last_id = 0
        if cursor_path.exists():
            try:
                last_id = int(cursor_path.read_text().strip() or "0")
            except Exception:
                last_id = 0
        new_events = [e for e in events if int(e.get("id", 0)) > last_id]
        # Filter to high-signal coordination events for hook delivery.
        allowed = {"TeammateIdle", "TaskCompleted", "TaskClaimed", "PeerMessageDelivered", "TeammateInterrupted"}
        new_events = [e for e in new_events if e.get("type") in allowed]
        if not new_events:
            continue
        max_id = max(int(e.get("id", 0)) for e in new_events)
        cursor_path.write_text(str(max_id))
        lines = [f"--- TEAM EVENTS ({team_id}) for {member.get('memberId')} ---"]
        for e in new_events[-20:]:
            details = {k: v for k, v in e.items() if k not in {"id", "ts", "type"}}
            lines.append(f"#{e.get('id')} {e.get('ts')} {e.get('type')} {json.dumps(details, separators=(',', ':'))}")
        lines.append("--- END TEAM EVENTS ---")
        chunks.append("\n".join(lines))
    return "\n\n".join(chunks)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Local Claude Team Runtime")
    sp = p.add_subparsers(dest="domain", required=True)

    # team
    team = sp.add_parser("team")
    team_sp = team.add_subparsers(dest="action", required=True)
    t_create = team_sp.add_parser("create")
    t_create.add_argument("--team-id")
    t_create.add_argument("--name", required=True)
    t_create.add_argument("--description")
    t_create.add_argument("--lead-session-id")
    t_create.add_argument("--lead-member-id")
    t_create.add_argument("--lead-name")
    t_create.add_argument("--cwd")
    t_create.add_argument("--force", action="store_true")

    team_sp.add_parser("list")

    t_start = team_sp.add_parser("start")
    t_start.add_argument("--team-id", required=True)
    t_start.add_argument("--cwd")

    t_stop = team_sp.add_parser("stop")
    t_stop.add_argument("--team-id", required=True)
    t_stop.add_argument("--kill-panes", action="store_true")

    t_status = team_sp.add_parser("status")
    t_status.add_argument("--team-id", required=True)
    t_status.add_argument("--include-tasks", action="store_true")

    t_resume = team_sp.add_parser("resume")
    t_resume.add_argument("--team-id", required=True)
    t_resume.add_argument("--ensure-tmux", action="store_true")

    t_doctor = team_sp.add_parser("doctor")
    t_doctor.add_argument("--team-id", required=True)

    t_reconcile = team_sp.add_parser("reconcile")
    t_reconcile.add_argument("--team-id", required=True)
    t_reconcile.add_argument("--keep-events", type=int)
    t_reconcile.add_argument("--include-workers", action="store_true")

    t_dash = team_sp.add_parser("dashboard")
    t_dash.add_argument("--team-id", required=True)

    t_recover = team_sp.add_parser("recover")
    t_recover.add_argument("--team-id", required=True)
    t_recover.add_argument("--ensure-tmux", action="store_true")
    t_recover.add_argument("--keep-events", type=int)
    t_recover.add_argument("--include-workers", dest="include_workers", action="store_true", default=True)
    t_recover.add_argument("--no-include-workers", dest="include_workers", action="store_false")

    t_boot = team_sp.add_parser("bootstrap")
    t_boot.add_argument("--team-id")
    t_boot.add_argument("--name", required=True)
    t_boot.add_argument("--description")
    t_boot.add_argument("--lead-session-id")
    t_boot.add_argument("--lead-member-id")
    t_boot.add_argument("--lead-name")
    t_boot.add_argument("--cwd")
    t_boot.add_argument("--preset", choices=["lite", "standard", "heavy", "auto"], default="standard")
    t_boot.add_argument("--teammate", action="append", help="Format memberId[:role[:cwd]]; may repeat")

    t_teardown = team_sp.add_parser("teardown")
    t_teardown.add_argument("--team-id", required=True)
    t_teardown.add_argument("--kill-panes", action="store_true")

    # member
    member = sp.add_parser("member")
    member_sp = member.add_subparsers(dest="action", required=True)
    m_add = member_sp.add_parser("add")
    m_add.add_argument("--team-id", required=True)
    m_add.add_argument("--member-id")
    m_add.add_argument("--name")
    m_add.add_argument("--role")
    m_add.add_argument("--kind", choices=["session", "pane", "worker"], default="session")
    m_add.add_argument("--session-id")
    m_add.add_argument("--cwd")

    m_attach = member_sp.add_parser("attach-session")
    m_attach.add_argument("--team-id", required=True)
    m_attach.add_argument("--member-id", required=True)
    m_attach.add_argument("--session-id", required=True)
    m_attach.add_argument("--cwd")

    # teammate (tmux/control)
    teammate = sp.add_parser("teammate")
    teammate_sp = teammate.add_subparsers(dest="action", required=True)
    ts_pane = teammate_sp.add_parser("spawn-pane")
    ts_pane.add_argument("--team-id", required=True)
    ts_pane.add_argument("--member-id", required=True)
    ts_pane.add_argument("--name")
    ts_pane.add_argument("--role")
    ts_pane.add_argument("--cwd", required=True)
    ts_pane.add_argument("--agent")
    ts_pane.add_argument("--model")
    ts_pane.add_argument("--initial-prompt")

    t_focus = teammate_sp.add_parser("focus")
    t_focus.add_argument("--team-id", required=True)
    t_focus.add_argument("--member-id", required=True)

    t_interrupt = teammate_sp.add_parser("interrupt")
    t_interrupt.add_argument("--team-id", required=True)
    t_interrupt.add_argument("--member-id", required=True)
    t_interrupt.add_argument("--message")

    # message
    message = sp.add_parser("message")
    msg_sp = message.add_subparsers(dest="action", required=True)
    msg_send = msg_sp.add_parser("send")
    msg_send.add_argument("--team-id", required=True)
    msg_send.add_argument("--from-member", required=True)
    msg_send.add_argument("--to-member", required=True)
    msg_send.add_argument("--content", required=True)
    msg_send.add_argument("--priority", choices=["normal", "urgent"], default="normal")
    msg_send.add_argument("--message-id")
    msg_send.add_argument("--ttl-seconds", type=int, default=MESSAGE_TTL_SECONDS)

    msg_inbox = msg_sp.add_parser("inbox")
    msg_inbox.add_argument("--team-id", required=True)
    msg_inbox.add_argument("--member-id", required=True)
    msg_inbox.add_argument("--clear", action="store_true")

    msg_ack = msg_sp.add_parser("ack")
    msg_ack.add_argument("--team-id", required=True)
    msg_ack.add_argument("--message-id", required=True)
    msg_ack.add_argument("--member-id", required=True)

    # task
    task = sp.add_parser("task")
    task_sp = task.add_subparsers(dest="action", required=True)
    task_add = task_sp.add_parser("add")
    task_add.add_argument("--team-id", required=True)
    task_add.add_argument("--task-id")
    task_add.add_argument("--title", required=True)
    task_add.add_argument("--description")
    task_add.add_argument("--depends-on", dest="depends_on", action="append")
    task_add.add_argument("--file", dest="files", action="append")
    task_add.add_argument("--assignee")
    task_add.add_argument("--created-by")

    task_list = task_sp.add_parser("list")
    task_list.add_argument("--team-id", required=True)
    task_list.add_argument("--status")

    task_claim = task_sp.add_parser("claim")
    task_claim.add_argument("--team-id", required=True)
    task_claim.add_argument("--task-id", required=True)
    task_claim.add_argument("--member-id", required=True)
    task_claim.add_argument("--force", action="store_true")
    task_claim.add_argument("--ttl-seconds", type=int, default=CLAIM_TTL_SECONDS)

    task_update = task_sp.add_parser("update")
    task_update.add_argument("--team-id", required=True)
    task_update.add_argument("--task-id", required=True)
    task_update.add_argument("--status", required=True)
    task_update.add_argument("--member-id")
    task_update.add_argument("--note")

    task_release = task_sp.add_parser("release-claim")
    task_release.add_argument("--team-id", required=True)
    task_release.add_argument("--task-id", required=True)
    task_release.add_argument("--member-id")
    task_release.add_argument("--force", action="store_true")

    # event
    event = sp.add_parser("event")
    ev_sp = event.add_subparsers(dest="action", required=True)
    ev_check = ev_sp.add_parser("check")
    ev_check.add_argument("--team-id", required=True)
    ev_check.add_argument("--types")
    ev_check.add_argument("--since-id", type=int)
    ev_check.add_argument("--consumer")

    worker = sp.add_parser("worker")
    wk_sp = worker.add_subparsers(dest="action", required=True)
    wk_reg = wk_sp.add_parser("register")
    wk_reg.add_argument("--team-id", required=True)
    wk_reg.add_argument("--worker-task-id", required=True)
    wk_reg.add_argument("--task-id")
    wk_reg.add_argument("--member-id")
    wk_reg.add_argument("--auto-complete", action="store_true")

    wk_att = wk_sp.add_parser("attach-result")
    wk_att.add_argument("--team-id", required=True)
    wk_att.add_argument("--worker-task-id", required=True)
    wk_att.add_argument("--task-id")
    wk_att.add_argument("--member-id")

    # hook
    hook = sp.add_parser("hook")
    hook_sp = hook.add_subparsers(dest="action", required=True)
    hs = hook_sp.add_parser("session-start")
    hs.add_argument("--session-id", required=True)
    hs.add_argument("--cwd")
    hs.add_argument("--host-pid", type=int)
    hs.add_argument("--team-id")
    hs.add_argument("--member-id")

    hh = hook_sp.add_parser("heartbeat")
    hh.add_argument("--session-id")  # optional, scanner uses all sessions

    he = hook_sp.add_parser("session-end")
    he.add_argument("--session-id", required=True)

    hook_sp.add_parser("reconcile-workers")

    hse = hook_sp.add_parser("session-events")
    hse.add_argument("--session-id", required=True)

    return p


def dispatch(args: argparse.Namespace) -> str:
    d = args.domain
    a = args.action
    if d == "team" and a == "create":
        return cmd_team_create(args)
    if d == "team" and a == "list":
        return cmd_team_list(args)
    if d == "team" and a == "start":
        return cmd_team_start(args)
    if d == "team" and a == "stop":
        return cmd_team_stop(args)
    if d == "team" and a == "status":
        return cmd_team_status(args)
    if d == "team" and a == "resume":
        return cmd_team_resume(args)
    if d == "team" and a == "doctor":
        return cmd_team_doctor(args)
    if d == "team" and a == "reconcile":
        return cmd_team_reconcile(args)
    if d == "team" and a == "dashboard":
        return cmd_team_dashboard(args)
    if d == "team" and a == "recover":
        return cmd_team_recover(args)
    if d == "team" and a == "bootstrap":
        return cmd_team_bootstrap(args)
    if d == "team" and a == "teardown":
        return cmd_team_teardown(args)
    if d == "member" and a == "add":
        return cmd_member_add(args)
    if d == "member" and a == "attach-session":
        return cmd_member_attach_session(args)
    if d == "teammate" and a == "spawn-pane":
        return cmd_teammate_spawn_pane(args)
    if d == "teammate" and a == "focus":
        return cmd_teammate_focus(args)
    if d == "teammate" and a == "interrupt":
        return cmd_teammate_interrupt(args)
    if d == "message" and a == "send":
        return cmd_message_send(args)
    if d == "message" and a == "inbox":
        return cmd_message_inbox(args)
    if d == "message" and a == "ack":
        return cmd_message_ack(args)
    if d == "task" and a == "add":
        return cmd_task_add(args)
    if d == "task" and a == "list":
        return cmd_task_list(args)
    if d == "task" and a == "claim":
        return cmd_task_claim(args)
    if d == "task" and a == "update":
        return cmd_task_update(args)
    if d == "task" and a == "release-claim":
        return cmd_task_release_claim(args)
    if d == "event" and a == "check":
        return cmd_event_check(args)
    if d == "worker" and a == "register":
        return cmd_worker_register(args)
    if d == "worker" and a == "attach-result":
        return cmd_worker_attach_result(args)
    if d == "hook" and a == "session-start":
        return cmd_hook_session_start(args)
    if d == "hook" and a == "heartbeat":
        return cmd_hook_heartbeat(args)
    if d == "hook" and a == "session-end":
        return cmd_hook_session_end(args)
    if d == "hook" and a == "reconcile-workers":
        return cmd_hook_reconcile_workers(args)
    if d == "hook" and a == "session-events":
        return cmd_hook_session_events(args)
    raise SystemExit(f"Unknown command: {d} {a}")


def main() -> int:
    ensure_dirs()
    parser = build_parser()
    args = parser.parse_args()
    try:
        out = dispatch(args)
        if out:
            print(out)
        return 0
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {' '.join(e.cmd) if isinstance(e.cmd, list) else e.cmd}: {e}", file=sys.stderr)
        return 1
    except (ValueError, SystemExit) as e:
        msg = str(e)
        if msg and msg != "0":
            print(msg, file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Unhandled error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
