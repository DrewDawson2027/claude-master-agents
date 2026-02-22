#!/usr/bin/env python3
"""Multi-human collaboration: roles, handoffs, presence, comments, ownership."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
TEAMS_DIR = CLAUDE / "teams"
COST_RUNTIME = CLAUDE / "scripts" / "cost_runtime.py"
OBSERVABILITY = CLAUDE / "scripts" / "observability.py"

# Role-based permission matrix
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "lead": {
        "scale", "teardown", "replace", "force-claim", "interrupt", "deploy",
        "recover-hard", "restart-member", "archive", "gc", "bootstrap",
        "set-role", "set-ownership", "set-presence",
        "claim", "update", "release", "send-message", "add-task", "approve",
        "dashboard", "status", "task-list", "timeline", "inbox", "who",
        "comment", "handoff-create", "handoff-latest",
    },
    "operator": {
        "claim", "update", "release", "send-message", "add-task", "approve",
        "set-presence", "comment", "handoff-create", "handoff-latest",
        "dashboard", "status", "task-list", "timeline", "inbox", "who",
    },
    "viewer": {
        "dashboard", "status", "task-list", "timeline", "inbox", "who",
        "handoff-latest", "comments",
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


def _team_dir(team_id: str) -> Path:
    return TEAMS_DIR / team_id


def _load_config(team_id: str) -> dict[str, Any]:
    return read_json(_team_dir(team_id) / "config.json", {})


def _save_config(team_id: str, cfg: dict[str, Any]) -> None:
    write_json(_team_dir(team_id) / "config.json", cfg)


def _find_member(cfg: dict[str, Any], member_id: str) -> dict[str, Any] | None:
    for m in cfg.get("members", []):
        mid = m.get("memberId") or m.get("name") or ""
        if mid == member_id:
            return m
    return None


def _emit_event(team_id: str, event_type: str, **payload: Any) -> None:
    ev = {"type": event_type, "ts": utc_now(), **payload}
    append_jsonl(_team_dir(team_id) / "events.jsonl", ev)


def _run_script(script: Path, *args: str, timeout: int = 30) -> tuple[int, str]:
    if not script.exists():
        return 1, f"script not found: {script}"
    try:
        cp = subprocess.run(
            ["python3", str(script), *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return cp.returncode, (cp.stdout + cp.stderr).strip()
    except Exception as e:
        return 1, str(e)


# ============================================================
# I1.1: Role-Based Operator Commands
# ============================================================

def cmd_set_role(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    role = args.role
    if role not in ROLE_PERMISSIONS:
        print(f"Invalid role: {role}. Valid: {', '.join(ROLE_PERMISSIONS.keys())}", file=sys.stderr)
        return 1

    cfg = _load_config(team_id)
    member = _find_member(cfg, args.member)
    if not member:
        print(f"Member not found: {args.member}", file=sys.stderr)
        return 1

    member["operatorRole"] = role
    _save_config(team_id, cfg)
    _emit_event(team_id, "OperatorRoleChanged", memberId=args.member, role=role)
    print(json.dumps({"status": "ok", "member": args.member, "role": role}))
    return 0


def cmd_check_permission(args: argparse.Namespace) -> int:
    team_id = args.team
    cfg = _load_config(team_id)
    member = _find_member(cfg, args.member)

    if not member:
        # Unknown member defaults to viewer
        role = "viewer"
    else:
        role = member.get("operatorRole") or member.get("role", "viewer")
        # Map legacy roles
        if role == "lead":
            role = "lead"
        elif role == "teammate":
            role = "operator"
        elif role not in ROLE_PERMISSIONS:
            role = "viewer"

    allowed = ROLE_PERMISSIONS.get(role, set())
    permitted = args.action in allowed

    result = {"permitted": permitted, "role": role, "action": args.action, "member": args.member}
    print(json.dumps(result, indent=2))
    return 0 if permitted else 2


# ============================================================
# I1.2: Shared Handoff Snapshot
# ============================================================

def cmd_handoff_create(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    cfg = _load_config(team_id)
    tasks_doc = read_json(td / "tasks.json", {"tasks": []})
    events = read_jsonl(td / "events.jsonl")
    messages = read_jsonl(td / "messages.jsonl")
    runtime = read_json(td / "runtime.json", {})

    # Task summary
    tasks = tasks_doc.get("tasks", [])
    task_counts = {"pending": 0, "in_progress": 0, "blocked": 0, "done": 0}
    for t in tasks:
        st = t.get("status", "pending")
        if st in task_counts:
            task_counts[st] += 1

    top_tasks = []
    for t in tasks[:10]:
        top_tasks.append({
            "id": t.get("taskId") or t.get("id"),
            "title": t.get("title") or t.get("name"),
            "status": t.get("status"),
            "claimedBy": t.get("claimedBy"),
        })

    # Member statuses
    member_statuses = []
    for m in cfg.get("members", []):
        member_statuses.append({
            "id": m.get("memberId") or m.get("name"),
            "status": m.get("status"),
            "presence": m.get("presence", "unknown"),
            "role": m.get("operatorRole") or m.get("role"),
        })

    # Last 10 events
    recent_events = events[-10:] if events else []

    # Unread messages
    unread = [m for m in messages if not m.get("acked_at") and not m.get("ackedAt")]

    # Cost summary
    cost_today = ""
    if COST_RUNTIME.exists():
        _, cost_today = _run_script(COST_RUNTIME, "summary", "--window", "today", timeout=15)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    handoff = {
        "created": utc_now(),
        "from": getattr(args, "from_operator", None) or "unknown",
        "note": args.note or "",
        "team_id": team_id,
        "state": runtime.get("state", "unknown"),
        "task_counts": task_counts,
        "top_tasks": top_tasks,
        "member_statuses": member_statuses,
        "recent_events": recent_events,
        "unread_messages": len(unread),
        "cost_today": cost_today[:500],
    }

    handoffs_dir = td / "handoffs"
    handoffs_dir.mkdir(parents=True, exist_ok=True)
    json_path = handoffs_dir / f"handoff-{stamp}.json"
    write_json(json_path, handoff)

    # Render markdown
    lines = [
        f"# Handoff — {team_id}",
        "",
        f"From: {handoff['from']} | Created: {handoff['created']}",
        f"Note: {handoff['note'] or '(none)'}",
        "",
        "## Team State",
        f"- State: {handoff['state']}",
        f"- Tasks: pending={task_counts['pending']} in_progress={task_counts['in_progress']} blocked={task_counts['blocked']} done={task_counts['done']}",
        f"- Unread messages: {handoff['unread_messages']}",
        "",
        "## Members",
        "",
        "| Member | Status | Presence | Role |",
        "|--------|--------|----------|------|",
    ]
    for ms in member_statuses:
        lines.append(f"| {ms['id']} | {ms['status']} | {ms['presence']} | {ms['role']} |")

    lines += ["", "## Top Tasks", ""]
    for t in top_tasks:
        lines.append(f"- [{t['status']}] {t['id']}: {t['title']} (claimed: {t['claimedBy'] or '-'})")

    lines += ["", "## Recent Events", ""]
    for ev in recent_events:
        lines.append(f"- {ev.get('ts', '?')} {ev.get('type', '?')}")

    lines += ["", "## Cost Today", "", "```", cost_today or "No data", "```"]

    md_path = handoffs_dir / f"handoff-{stamp}.md"
    md_path.write_text("\n".join(lines) + "\n")

    _emit_event(team_id, "HandoffCreated", by=handoff["from"], path=str(json_path))
    print(json.dumps({"status": "created", "path": str(json_path), "md": str(md_path)}))
    return 0


def cmd_handoff_latest(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    handoffs_dir = td / "handoffs"

    if not handoffs_dir.exists():
        print("No handoffs found.")
        return 0

    handoff_files = sorted(handoffs_dir.glob("handoff-*.json"))
    if not handoff_files:
        print("No handoffs found.")
        return 0

    latest = read_json(handoff_files[-1], {})

    # Compare current state to handoff
    current_tasks = read_json(td / "tasks.json", {"tasks": []}).get("tasks", [])
    current_counts = {"pending": 0, "in_progress": 0, "blocked": 0, "done": 0}
    for t in current_tasks:
        st = t.get("status", "pending")
        if st in current_counts:
            current_counts[st] += 1

    prev_counts = latest.get("task_counts", {})

    lines = [
        f"# What Changed — {team_id}",
        "",
        f"Last handoff: {latest.get('created', '?')} by {latest.get('from', '?')}",
        f"Note: {latest.get('note', '')}",
        "",
        "## Task Delta",
        "",
        "| Status | At Handoff | Now | Delta |",
        "|--------|----------:|----|------:|",
    ]
    for st in ("pending", "in_progress", "blocked", "done"):
        prev = prev_counts.get(st, 0)
        curr = current_counts.get(st, 0)
        delta = curr - prev
        sign = "+" if delta > 0 else ""
        lines.append(f"| {st} | {prev} | {curr} | {sign}{delta} |")

    # New events since handoff
    handoff_ts = latest.get("created", "")
    events = read_jsonl(td / "events.jsonl")
    new_events = [e for e in events if (e.get("ts") or "") > handoff_ts]
    lines += [
        "",
        f"## New Events Since Handoff ({len(new_events)})",
        "",
    ]
    for ev in new_events[-20:]:
        lines.append(f"- {ev.get('ts', '?')} **{ev.get('type', '?')}**")

    if not new_events:
        lines.append("No new events.")

    print("\n".join(lines))
    return 0


# ============================================================
# I1.3: Team Ownership Metadata
# ============================================================

def cmd_set_ownership(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    cfg = _load_config(team_id)
    ownership = cfg.setdefault("ownership", {})

    if args.owners:
        ownership["owners"] = [o.strip() for o in args.owners.split(",")]
    if args.escalation:
        ownership["escalation"] = [e.strip() for e in args.escalation.split(",")]
    if args.project:
        ownership["project"] = args.project

    ownership["updatedAt"] = utc_now()
    _save_config(team_id, cfg)
    _emit_event(team_id, "OwnershipUpdated", ownership=ownership)
    print(json.dumps({"status": "ok", "ownership": ownership}))
    return 0


def cmd_get_ownership(args: argparse.Namespace) -> int:
    cfg = _load_config(args.team)
    ownership = cfg.get("ownership", {})
    print(json.dumps(ownership or {"owners": [], "escalation": [], "project": None}, indent=2))
    return 0


# ============================================================
# I1.4: Presence/Availability
# ============================================================

VALID_PRESENCE = {"available", "busy", "away", "offline"}


def cmd_set_presence(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    if args.status not in VALID_PRESENCE:
        print(f"Invalid presence: {args.status}. Valid: {', '.join(VALID_PRESENCE)}", file=sys.stderr)
        return 1

    cfg = _load_config(team_id)
    member = _find_member(cfg, args.member)
    if not member:
        print(f"Member not found: {args.member}", file=sys.stderr)
        return 1

    old_presence = member.get("presence", "unknown")
    member["presence"] = args.status
    member["presenceUpdatedAt"] = utc_now()
    _save_config(team_id, cfg)
    _emit_event(team_id, "OperatorPresenceChanged", memberId=args.member, from_=old_presence, to=args.status)
    print(json.dumps({"status": "ok", "member": args.member, "presence": args.status}))
    return 0


def cmd_who(args: argparse.Namespace) -> int:
    team_id = args.team
    cfg = _load_config(team_id)

    lines = [
        f"# Who — {team_id}",
        "",
        "| Member | Role | Presence | Status | Last Activity |",
        "|--------|------|----------|--------|---------------|",
    ]
    for m in cfg.get("members", []):
        mid = m.get("memberId") or m.get("name") or "?"
        role = m.get("operatorRole") or m.get("role") or "?"
        presence = m.get("presence") or "unknown"
        status = m.get("status") or "?"
        last = m.get("presenceUpdatedAt") or m.get("lastHeartbeat") or m.get("createdAt") or "?"
        lines.append(f"| {mid} | {role} | {presence} | {status} | {last} |")

    if not cfg.get("members"):
        lines.append("| - | - | - | - | - |")

    ownership = cfg.get("ownership", {})
    if ownership:
        lines += [
            "",
            "## Ownership",
            f"- Owners: {', '.join(ownership.get('owners', []))}",
            f"- Escalation: {', '.join(ownership.get('escalation', []))}",
            f"- Project: {ownership.get('project', '-')}",
        ]

    print("\n".join(lines))
    return 0


# ============================================================
# I1.5: Comment/Annotation Layer
# ============================================================

def _comments_path(team_id: str) -> Path:
    return _team_dir(team_id) / "comments.jsonl"


def cmd_comment(args: argparse.Namespace) -> int:
    team_id = args.team
    td = _team_dir(team_id)
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    target = args.target
    # Parse target type
    if ":" in target:
        target_type, target_id = target.split(":", 1)
    else:
        target_type, target_id = "general", target

    comment_id = hashlib.sha256(f"{utc_now()}{args.author}{args.text}".encode()).hexdigest()[:12]
    entry = {
        "id": comment_id,
        "target": target,
        "targetType": target_type,
        "targetId": target_id,
        "text": args.text,
        "author": args.author,
        "ts": utc_now(),
    }

    append_jsonl(_comments_path(team_id), entry)
    _emit_event(team_id, "CommentAdded", commentId=comment_id, target=target, author=args.author)
    print(json.dumps({"status": "ok", "id": comment_id}))
    return 0


def cmd_comments(args: argparse.Namespace) -> int:
    team_id = args.team
    all_comments = read_jsonl(_comments_path(team_id))

    target = getattr(args, "target", None)
    if target:
        all_comments = [c for c in all_comments if c.get("target") == target]

    # Show last 20
    recent = all_comments[-20:]

    if not recent:
        print("No comments found.")
        return 0

    lines = [
        f"# Comments — {team_id}",
        "",
        "| Time | Author | Target | Comment |",
        "|------|--------|--------|---------|",
    ]
    for c in recent:
        text = c.get("text", "")[:80]
        lines.append(f"| {c.get('ts', '?')} | {c.get('author', '?')} | {c.get('target', '?')} | {text} |")

    print("\n".join(lines))
    return 0


# ============================================================
# CLI
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="collaboration", description="Multi-human collaboration tools")
    sub = p.add_subparsers(dest="command")

    sr = sub.add_parser("set-role", help="Set operator role for a team member")
    sr.add_argument("--team", required=True)
    sr.add_argument("--member", required=True)
    sr.add_argument("--role", required=True, choices=["lead", "operator", "viewer"])

    cp = sub.add_parser("check-permission", help="Check if action is permitted for member role")
    cp.add_argument("--team", required=True)
    cp.add_argument("--member", required=True)
    cp.add_argument("--action", required=True)

    hc = sub.add_parser("handoff-create", help="Create handoff snapshot")
    hc.add_argument("--team", required=True)
    hc.add_argument("--from", dest="from_operator")
    hc.add_argument("--note", default="")

    hl = sub.add_parser("handoff-latest", help="Show what changed since last handoff")
    hl.add_argument("--team", required=True)

    so = sub.add_parser("set-ownership", help="Set team ownership metadata")
    so.add_argument("--team", required=True)
    so.add_argument("--owners", help="Comma-separated owner names")
    so.add_argument("--escalation", help="Comma-separated escalation contacts")
    so.add_argument("--project", help="Project name")

    go = sub.add_parser("get-ownership", help="Get team ownership metadata")
    go.add_argument("--team", required=True)

    sp = sub.add_parser("set-presence", help="Set operator presence")
    sp.add_argument("--team", required=True)
    sp.add_argument("--member", required=True)
    sp.add_argument("--status", required=True, choices=["available", "busy", "away", "offline"])

    w = sub.add_parser("who", help="List operators with presence and roles")
    w.add_argument("--team", required=True)

    cm = sub.add_parser("comment", help="Add comment/annotation")
    cm.add_argument("--team", required=True)
    cm.add_argument("--target", required=True, help="e.g. task:t1, event:e5, message:m3")
    cm.add_argument("--text", required=True)
    cm.add_argument("--author", required=True)

    cs = sub.add_parser("comments", help="List comments")
    cs.add_argument("--team", required=True)
    cs.add_argument("--target", help="Filter by target")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "set-role": cmd_set_role,
        "check-permission": cmd_check_permission,
        "handoff-create": cmd_handoff_create,
        "handoff-latest": cmd_handoff_latest,
        "set-ownership": cmd_set_ownership,
        "get-ownership": cmd_get_ownership,
        "set-presence": cmd_set_presence,
        "who": cmd_who,
        "comment": cmd_comment,
        "comments": cmd_comments,
    }
    fn = dispatch.get(args.command)
    if not fn:
        parser.print_help()
        return 1
    return fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
