#!/usr/bin/env python3
"""Observability suite: health reports, timelines, SLO metrics, parity history, audit trails."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
TEAMS_DIR = CLAUDE / "teams"
REPORTS = CLAUDE / "reports"
GOV = CLAUDE / "governance"
INBOX_DIR = CLAUDE / "terminals" / "inbox"
COST_RUNTIME = CLAUDE / "scripts" / "cost_runtime.py"
PARITY_AUDIT = CLAUDE / "scripts" / "parity_audit.py"
TRUST_AUDIT = CLAUDE / "scripts" / "trust_audit.py"
SLO_HISTORY = REPORTS / "slo-history.jsonl"
PARITY_HISTORY = REPORTS / "parity-history.jsonl"
ALERT_HISTORY = REPORTS / "slo-alerts.jsonl"
ALERT_STATE = REPORTS / "slo-alert-state.json"
SLO_THRESHOLDS = GOV / "slo-thresholds.json"

AUDIT_EVENT_TYPES = {
    "recovery_hard",
    "force_claim",
    "interrupt",
    "replace_member",
    "archive",
    "destroy",
    "restart_member",
    "teardown",
    "scale",
    "auto_heal",
    "recover",
    "gc",
}


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def now_epoch() -> float:
    return datetime.now(timezone.utc).timestamp()


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


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


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def run_script(script: Path, *args: str, timeout: int = 30) -> tuple[int, str]:
    if not script.exists():
        return 1, f"script not found: {script}"
    try:
        cp = subprocess.run(
            ["python3", str(script), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return cp.returncode, (cp.stdout + cp.stderr).strip()
    except Exception as e:
        return 1, str(e)


def parse_ts(ts: str | None) -> float:
    if not ts:
        return 0.0
    try:
        ts = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(ts).timestamp()
    except Exception:
        return 0.0


def format_age(seconds: float) -> str:
    s = int(max(0, seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def load_slo_thresholds() -> dict[str, Any]:
    defaults = {
        "cooldown_seconds": 900,
        "ack_latency_p95_warn_seconds": 900,
        "ack_latency_p95_crit_seconds": 3600,
        "recovery_time_warn_seconds": 1800,
        "recovery_time_crit_seconds": 7200,
        "task_completion_warn_seconds": 21600,
        "task_completion_crit_seconds": 86400,
        "restart_rate_24h_warn": 3,
        "restart_rate_24h_crit": 6,
        "failure_rate_24h_warn": 3,
        "failure_rate_24h_crit": 6,
    }
    data = read_json(SLO_THRESHOLDS, {})
    if not isinstance(data, dict):
        data = {}
    merged = dict(defaults)
    merged.update({k: v for k, v in data.items() if v is not None})
    return merged


def _alert_key(alert: dict[str, Any]) -> str:
    return f"{alert.get('team','*')}|{alert.get('type')}|{alert.get('metric')}"


def _inbox_targets(limit: int = 25) -> list[Path]:
    if not INBOX_DIR.exists():
        return []
    files = [p for p in INBOX_DIR.glob("*.jsonl") if not p.name.endswith(".processed")]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[:limit]


def _deliver_alerts_to_inbox(alerts: list[dict[str, Any]]) -> int:
    if not alerts:
        return 0
    payloads = []
    ts = utc_now()
    for a in alerts:
        payloads.append(
            {
                "ts": ts,
                "from": "system",
                "priority": "high" if a.get("severity") == "critical" else "normal",
                "content": f"[SLO ALERT] {a.get('team','-')}: {a.get('message','')}",
                "type": "slo_alert",
                "alert_type": a.get("type"),
                "metric": a.get("metric"),
            }
        )
    delivered = 0
    for inbox in _inbox_targets():
        try:
            with inbox.open("a", encoding="utf-8") as f:
                for row in payloads:
                    f.write(json.dumps(row, separators=(",", ":")) + "\n")
            delivered += 1
        except Exception:
            continue
    return delivered


def _load_alert_state() -> dict[str, Any]:
    data = read_json(ALERT_STATE, {})
    if not isinstance(data, dict):
        return {"last_sent": {}, "last_eval": None}
    data.setdefault("last_sent", {})
    return data


def _save_alert_state(state: dict[str, Any]) -> None:
    write_json(ALERT_STATE, state)


def _slo_alert_candidates(metrics: dict[str, Any], thresholds: dict[str, Any]) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    for team_id, tm in (metrics.get("teams") or {}).items():
        checks = [
            ("ack_latency_p95", tm.get("ack_latency_p95"), "seconds", "ack_latency_p95_"),
            ("recovery_time_avg", tm.get("recovery_time_avg"), "seconds", "recovery_time_"),
            ("task_completion_p95", tm.get("task_completion_p95"), "seconds", "task_completion_"),
            ("restart_rate_24h", tm.get("restart_rate_24h"), "count", "restart_rate_24h_"),
            ("failure_rate_24h", tm.get("failure_rate_24h"), "count", "failure_rate_24h_"),
        ]
        for metric, value, unit, prefix in checks:
            if value is None:
                continue
            warn_key = f"{prefix}warn_seconds" if unit == "seconds" else f"{prefix}warn"
            crit_key = f"{prefix}crit_seconds" if unit == "seconds" else f"{prefix}crit"
            warn = thresholds.get(warn_key)
            crit = thresholds.get(crit_key)
            severity = None
            if crit is not None and value >= crit:
                severity = "critical"
            elif warn is not None and value >= warn:
                severity = "warning"
            if severity:
                val_fmt = format_age(value) if unit == "seconds" else str(int(value))
                thr_fmt = format_age(crit if severity == "critical" else warn) if unit == "seconds" else str(int(crit if severity == "critical" else warn))
                alerts.append(
                    {
                        "ts": utc_now(),
                        "team": team_id,
                        "type": "slo_breach",
                        "metric": metric,
                        "severity": severity,
                        "value": value,
                        "threshold": crit if severity == "critical" else warn,
                        "message": f"{metric}={val_fmt} breached {severity} threshold {thr_fmt}",
                    }
                )
    return alerts


def evaluate_slo_alerts(deliver: bool = True) -> dict[str, Any]:
    thresholds = load_slo_thresholds()
    metrics = _compute_slo_metrics()
    append_jsonl(SLO_HISTORY, metrics)

    candidates = _slo_alert_candidates(metrics, thresholds)
    state = _load_alert_state()
    cooldown = int(thresholds.get("cooldown_seconds", 900))
    now = now_epoch()
    emitted: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    last_sent = state.get("last_sent", {})
    for a in candidates:
        key = _alert_key(a)
        last = float(last_sent.get(key, 0) or 0)
        if now - last < cooldown:
            suppressed.append(a)
            continue
        emitted.append(a)
        last_sent[key] = now
        append_jsonl(ALERT_HISTORY, a)

    delivered_targets = 0
    if deliver and emitted:
        delivered_targets = _deliver_alerts_to_inbox(emitted)

    state["last_sent"] = last_sent
    state["last_eval"] = utc_now()
    state["last_eval_summary"] = {
        "candidate_count": len(candidates),
        "emitted_count": len(emitted),
        "suppressed_count": len(suppressed),
        "delivered_targets": delivered_targets,
    }
    _save_alert_state(state)

    return {
        "status": "ok",
        "thresholds": thresholds,
        "metrics_timestamp": metrics.get("timestamp"),
        "candidate_count": len(candidates),
        "emitted_count": len(emitted),
        "suppressed_count": len(suppressed),
        "delivered_targets": delivered_targets,
        "alerts": emitted,
        "suppressed": suppressed[:20],
    }


def alerts_status() -> dict[str, Any]:
    state = _load_alert_state()
    recent = read_jsonl(ALERT_HISTORY)[-20:]
    return {
        "status": "ok",
        "thresholds": load_slo_thresholds(),
        "state": state,
        "recent_alerts": recent,
        "recent_alert_count": len(recent),
    }


# --- Team data helpers ---


def list_teams() -> list[dict[str, Any]]:
    teams = []
    if not TEAMS_DIR.exists():
        return teams
    for d in sorted(TEAMS_DIR.iterdir()):
        if not d.is_dir():
            continue
        cfg = read_json(d / "config.json", {})
        rt = read_json(d / "runtime.json", {})
        teams.append(
            {
                "id": d.name,
                "name": cfg.get("name", d.name),
                "state": rt.get("state", "unknown"),
                "members": cfg.get("members", []),
                "tmux": rt.get("tmux_session"),
            }
        )
    return teams


def team_events(team_id: str) -> list[dict[str, Any]]:
    return read_jsonl(TEAMS_DIR / team_id / "events.jsonl")


def team_tasks(team_id: str) -> dict[str, Any]:
    doc = read_json(TEAMS_DIR / team_id / "tasks.json", [])
    if isinstance(doc, list):
        return {"tasks": doc}
    return doc


def team_messages(team_id: str) -> list[dict[str, Any]]:
    return read_jsonl(TEAMS_DIR / team_id / "messages.jsonl")


# ============================================================
# health-report
# ============================================================


def cmd_health_report(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    ts = utc_now()
    teams = list_teams()

    # Runtime status
    runtime_rows = []
    for t in teams:
        member_count = len(t.get("members", []))
        runtime_rows.append(
            f"| {t['id']} | {t['name']} | {t['state']} | {member_count} | {t.get('tmux') or '-'} |"
        )

    # Task summary across all teams
    total_tasks = {"pending": 0, "in_progress": 0, "done": 0, "blocked": 0}
    for t in teams:
        doc = team_tasks(t["id"])
        for task in doc.get("tasks", []):
            st = task.get("status", "pending")
            if st in total_tasks:
                total_tasks[st] += 1
            if task.get("blocked"):
                total_tasks["blocked"] += 1

    # Event feed (last 24h)
    cutoff = now_epoch() - 86400
    recent_events = []
    for t in teams:
        for ev in team_events(t["id"]):
            ev_ts = parse_ts(ev.get("ts") or ev.get("timestamp"))
            if ev_ts >= cutoff:
                ev["_team"] = t["id"]
                recent_events.append(ev)
    recent_events.sort(key=lambda e: parse_ts(e.get("ts") or e.get("timestamp")))

    # Cost/budget
    cost_today = ""
    cost_week = ""
    if COST_RUNTIME.exists():
        _, cost_today = run_script(COST_RUNTIME, "summary", "--window", "today")
        _, cost_week = run_script(COST_RUNTIME, "summary", "--window", "week")

    # Parity grades
    parity_json = read_json(REPORTS / "parity-audit-latest.json", {})

    # Trust audit
    trust_json = read_json(REPORTS / "trust-audit-latest.json", {})

    # Alerts (health-state + SLO alerts)
    alerts = []
    for t in teams:
        if t["state"] not in ("running", "stopped", "paused"):
            alerts.append(f"Team {t['id']} in unexpected state: {t['state']}")
        for m in t.get("members", []):
            if m.get("status") == "error":
                alerts.append(
                    f"Member {m.get('name', m.get('id', '?'))} in team {t['id']} has error status"
                )
    if trust_json.get("tier2_unapproved"):
        alerts.append(
            f"Unapproved tier-2 plugins: {', '.join(trust_json['tier2_unapproved'])}"
        )
    alert_status = alerts_status()
    recent_slo = alert_status.get("recent_alerts", [])
    for a in recent_slo[-10:]:
        alerts.append(
            f"SLO {a.get('severity','?')} {a.get('team','?')} {a.get('metric','?')}: {a.get('message','')}"
        )

    # Build report
    lines = [
        "# Health Report",
        "",
        f"Generated: {ts}",
        "",
        "## Runtime Status",
        "",
        "| Team | Name | State | Members | tmux |",
        "|------|------|-------|--------:|------|",
    ]
    lines.extend(runtime_rows or ["| - | - | - | 0 | - |"])

    lines += [
        "",
        "## Task Summary",
        "",
        f"- Pending: {total_tasks['pending']}",
        f"- In Progress: {total_tasks['in_progress']}",
        f"- Done: {total_tasks['done']}",
        f"- Blocked: {total_tasks['blocked']}",
        "",
        "## Events (Last 24h)",
        "",
    ]
    if recent_events:
        for ev in recent_events[-50:]:
            ev_ts_str = ev.get("ts") or ev.get("timestamp") or "?"
            ev_type = ev.get("type") or ev.get("event_type") or "?"
            lines.append(
                f"- `{ev_ts_str}` **{ev_type}** ({ev.get('_team', '?')}): {ev.get('detail', ev.get('summary', ''))}"
            )
    else:
        lines.append("No events in last 24h.")

    lines += [
        "",
        "## Cost / Budget",
        "",
        "### Today",
        "```",
        cost_today or "No cost data",
        "```",
        "",
        "### This Week",
        "```",
        cost_week or "No cost data",
        "```",
        "",
        "## Alerts",
        "",
    ]
    lines.extend([f"- {a}" for a in alerts] or ["No alerts."])

    lines += ["", "## Parity Grades", ""]
    cats = parity_json.get("categories", {})
    if cats:
        lines.append("| Category | Grade | Present | Missing |")
        lines.append("|----------|-------|--------:|---------|")
        for cat, v in cats.items():
            missing = ", ".join(v.get("missing", [])) or "-"
            lines.append(
                f"| {cat} | {v.get('grade', '?')} | {v.get('presentCount', 0)}/{v.get('requiredCount', 0)} | {missing} |"
            )
    else:
        lines.append("No parity data. Run `parity_audit.py` first.")

    lines += ["", "## Trust", ""]
    if trust_json:
        s = trust_json.get("summary", {})
        lines.append(
            f"- Tier 0: {s.get('tier0', 0)}, Tier 1: {s.get('tier1', 0)}, Tier 2: {s.get('tier2', 0)}"
        )
    else:
        lines.append("No trust data. Run `trust_audit.py` first.")

    md = "\n".join(lines) + "\n"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    md_path = REPORTS / f"health-report-{stamp}.md"
    json_path = REPORTS / f"health-report-{stamp}.json"
    md_path.write_text(md)

    report_data = {
        "generated": ts,
        "teams": [
            {
                "id": t["id"],
                "name": t["name"],
                "state": t["state"],
                "members": len(t.get("members", [])),
            }
            for t in teams
        ],
        "tasks": total_tasks,
        "event_count_24h": len(recent_events),
        "alerts": alerts,
        "slo_alert_status": alert_status.get("state", {}),
        "parity": cats,
    }
    json_path.write_text(json.dumps(report_data, indent=2) + "\n")

    if getattr(args, "json", False):
        print(json.dumps(report_data, indent=2))
    else:
        print(md)
    return 0


# ============================================================
# timeline
# ============================================================


def cmd_timeline(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    team_id = args.team
    team_dir = TEAMS_DIR / team_id
    if not team_dir.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    hours = getattr(args, "hours", 24)
    cutoff = now_epoch() - (hours * 3600)

    entries: list[tuple[float, str, str]] = []

    # Events
    for ev in team_events(team_id):
        ev_ts = parse_ts(ev.get("ts") or ev.get("timestamp"))
        if ev_ts >= cutoff:
            ev_type = ev.get("type") or ev.get("event_type") or "event"
            detail = (
                ev.get("detail")
                or ev.get("summary")
                or json.dumps(
                    {
                        k: v
                        for k, v in ev.items()
                        if k not in ("ts", "timestamp", "type", "event_type", "id")
                    }
                )
            )
            entries.append((ev_ts, ev_type, str(detail)[:200]))

    # Messages
    for msg in team_messages(team_id):
        msg_ts = parse_ts(msg.get("ts") or msg.get("timestamp") or msg.get("sent_at"))
        if msg_ts >= cutoff:
            sender = msg.get("from") or msg.get("sender") or "?"
            to = msg.get("to") or msg.get("recipient") or "?"
            body = (msg.get("body") or msg.get("content") or "")[:100]
            entries.append((msg_ts, "message", f"{sender} -> {to}: {body}"))

    # Task transitions
    doc = team_tasks(team_id)
    for task in doc.get("tasks", []):
        for field in ("created_at", "claimed_at", "completed_at"):
            ts_val = parse_ts(task.get(field))
            if ts_val >= cutoff:
                action = field.replace("_at", "").replace("_", " ")
                entries.append(
                    (
                        ts_val,
                        f"task_{action}",
                        f"{task.get('id', '?')}: {task.get('title', task.get('name', '?'))}",
                    )
                )

    entries.sort(key=lambda x: x[0])

    lines = [
        f"# Team Timeline: {team_id}",
        "",
        f"Period: last {hours}h | Generated: {utc_now()}",
        "",
    ]
    if entries:
        for ts_val, ev_type, detail in entries:
            dt = datetime.fromtimestamp(ts_val, tz=timezone.utc)
            lines.append(f"[{dt.strftime('%H:%M')}] {ev_type} | {detail}")
    else:
        lines.append("No activity in this period.")

    md = "\n".join(lines) + "\n"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = REPORTS / f"team-timeline-{team_id}-{stamp}.md"
    out_path.write_text(md)

    if getattr(args, "json", False):
        print(
            json.dumps(
                {"team": team_id, "entries": len(entries), "path": str(out_path)}
            )
        )
    else:
        print(md)
    return 0


# ============================================================
# slo
# ============================================================


def _compute_slo_metrics() -> dict[str, Any]:
    now = now_epoch()
    teams = list_teams()
    metrics: dict[str, Any] = {"timestamp": utc_now(), "teams": {}}

    for t in teams:
        tid = t["id"]
        events = team_events(tid)
        msgs = team_messages(tid)
        doc = team_tasks(tid)
        tasks = doc.get("tasks", [])

        # Ack latency: message sent → acked
        ack_latencies = []
        for msg in msgs:
            sent = parse_ts(msg.get("ts") or msg.get("sent_at"))
            acked = parse_ts(msg.get("acked_at"))
            if sent and acked and acked > sent:
                ack_latencies.append(acked - sent)

        # Recovery time: failure → recovery event pairs
        recovery_times = []
        last_failure_ts = None
        for ev in events:
            ev_type = ev.get("type") or ev.get("event_type") or ""
            ev_ts = parse_ts(ev.get("ts") or ev.get("timestamp"))
            if "fail" in ev_type.lower() or "error" in ev_type.lower():
                last_failure_ts = ev_ts
            elif "recover" in ev_type.lower() and last_failure_ts:
                recovery_times.append(ev_ts - last_failure_ts)
                last_failure_ts = None

        # Task completion time
        completion_times = []
        for task in tasks:
            claimed = parse_ts(task.get("claimed_at"))
            completed = parse_ts(task.get("completed_at"))
            if claimed and completed and completed > claimed:
                completion_times.append(completed - claimed)

        # Restart rate (events in last 24h)
        day_cutoff = now - 86400
        day_events = [
            e
            for e in events
            if parse_ts(e.get("ts") or e.get("timestamp")) >= day_cutoff
        ]
        restart_count = sum(
            1
            for e in day_events
            if "restart" in (e.get("type") or e.get("event_type") or "").lower()
        )
        failure_count = sum(
            1
            for e in day_events
            if "fail" in (e.get("type") or e.get("event_type") or "").lower()
            or "error" in (e.get("type") or e.get("event_type") or "").lower()
        )

        def avg(lst: list[float]) -> float | None:
            return sum(lst) / len(lst) if lst else None

        def p95(lst: list[float]) -> float | None:
            if not lst:
                return None
            s = sorted(lst)
            idx = int(len(s) * 0.95)
            return s[min(idx, len(s) - 1)]

        metrics["teams"][tid] = {
            "ack_latency_avg": avg(ack_latencies),
            "ack_latency_p95": p95(ack_latencies),
            "ack_latency_samples": len(ack_latencies),
            "recovery_time_avg": avg(recovery_times),
            "recovery_time_samples": len(recovery_times),
            "task_completion_avg": avg(completion_times),
            "task_completion_p95": p95(completion_times),
            "task_completion_samples": len(completion_times),
            "restart_rate_24h": restart_count,
            "failure_rate_24h": failure_count,
        }

    return metrics


def cmd_slo(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    metrics = _compute_slo_metrics()

    report_only = getattr(args, "report", False)

    if not report_only:
        append_jsonl(SLO_HISTORY, metrics)

    if report_only or getattr(args, "json", False):
        # Load history for trend
        history = read_jsonl(SLO_HISTORY)
        recent = history[-7:] if len(history) >= 7 else history

        if getattr(args, "json", False):
            print(
                json.dumps({"latest": metrics, "history_count": len(history)}, indent=2)
            )
            return 0

        lines = ["# SLO Metrics Report", "", f"Generated: {utc_now()}", ""]

        for tid, tm in metrics.get("teams", {}).items():
            lines.append(f"## Team: {tid}")
            lines.append("")
            lines.append("| Metric | Value |")
            lines.append("|--------|------:|")
            for k, v in tm.items():
                if v is None:
                    v_str = "-"
                elif "latency" in k or "time" in k:
                    v_str = format_age(v)
                else:
                    v_str = str(v)
                label = k.replace("_", " ").title()
                lines.append(f"| {label} | {v_str} |")
            lines.append("")

        if len(recent) > 1:
            lines.append("## 7-Day Trend")
            lines.append("")
            lines.append("| Date | Teams | Restarts | Failures |")
            lines.append("|------|------:|--------:|---------:|")
            for snap in recent:
                ts_str = snap.get("timestamp", "?")[:10]
                total_restarts = sum(
                    t.get("restart_rate_24h", 0) for t in snap.get("teams", {}).values()
                )
                total_failures = sum(
                    t.get("failure_rate_24h", 0) for t in snap.get("teams", {}).values()
                )
                lines.append(
                    f"| {ts_str} | {len(snap.get('teams', {}))} | {total_restarts} | {total_failures} |"
                )

        print("\n".join(lines))
    else:
        print(
            json.dumps(
                {"status": "snapshot_recorded", "teams": len(metrics.get("teams", {}))},
                indent=2,
            )
        )

    return 0


# ============================================================
# parity-history
# ============================================================


def cmd_parity_history(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)

    report_only = getattr(args, "report", False)

    if not report_only:
        # Run parity audit and record
        latest = read_json(REPORTS / "parity-audit-latest.json")
        if not latest:
            # Try running it
            rc, _ = run_script(PARITY_AUDIT)
            latest = read_json(REPORTS / "parity-audit-latest.json")

        if latest:
            cats = latest.get("categories", {})
            grades = {cat: v.get("grade", "?") for cat, v in cats.items()}
            overall_scores = [
                v.get("presentCount", 0) / max(v.get("requiredCount", 1), 1)
                for v in cats.values()
            ]
            overall = sum(overall_scores) / len(overall_scores) if overall_scores else 0
            entry = {
                "timestamp": utc_now(),
                "categories": grades,
                "overall": round(overall, 3),
            }
            append_jsonl(PARITY_HISTORY, entry)
            if not report_only:
                print(
                    json.dumps(
                        {"status": "recorded", "overall": entry["overall"]}, indent=2
                    )
                )
                return 0

    # Report
    history = read_jsonl(PARITY_HISTORY)
    if not history:
        print("No parity history recorded yet.")
        return 0

    lines = ["# Parity Grade History", "", f"Generated: {utc_now()}", ""]

    # Get all category names
    all_cats = set()
    for h in history:
        all_cats.update(h.get("categories", {}).keys())
    all_cats_sorted = sorted(all_cats)

    header = "| Date | Overall | " + " | ".join(all_cats_sorted) + " |"
    sep = "|------|--------:|" + "|".join(["-------:" for _ in all_cats_sorted]) + "|"
    lines.append(header)
    lines.append(sep)

    for h in history[-20:]:
        ts_str = h.get("timestamp", "?")[:10]
        overall = f"{h.get('overall', 0):.0%}"
        cats = h.get("categories", {})
        cat_vals = " | ".join(cats.get(c, "?") for c in all_cats_sorted)
        lines.append(f"| {ts_str} | {overall} | {cat_vals} |")

    print("\n".join(lines))
    return 0


# ============================================================
# alerts / slo-loop
# ============================================================


def cmd_alerts(args: argparse.Namespace) -> int:
    action = getattr(args, "action", "status")
    if action == "evaluate":
        result = evaluate_slo_alerts(deliver=not getattr(args, "no_deliver", False))
    else:
        result = alerts_status()
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    else:
        print(f"Alert status: {result.get('status','?')}")
        if action == "evaluate":
            print(
                f"Candidates={result.get('candidate_count',0)} emitted={result.get('emitted_count',0)} suppressed={result.get('suppressed_count',0)} delivered_targets={result.get('delivered_targets',0)}"
            )
            for a in result.get("alerts", [])[:20]:
                print(f"- [{a.get('severity','?')}] {a.get('team','?')} {a.get('metric','?')}: {a.get('message','')}")
        else:
            state = result.get("state", {})
            print(f"Last eval: {state.get('last_eval') or '-'}")
            for a in result.get("recent_alerts", [])[-10:]:
                print(f"- [{a.get('severity','?')}] {a.get('team','?')} {a.get('metric','?')}: {a.get('message','')}")
    return 0


def cmd_slo_loop(args: argparse.Namespace) -> int:
    import time

    interval = max(10, int(getattr(args, "interval", 300)))
    once = bool(getattr(args, "once", False))
    max_iter = int(getattr(args, "iterations", 0) or 0)
    i = 0
    while True:
        result = evaluate_slo_alerts(deliver=not getattr(args, "no_deliver", False))
        if getattr(args, "json", False):
            print(json.dumps({"iteration": i + 1, **result}, indent=2))
        else:
            print(
                f"[{utc_now()}] slo-loop iteration={i+1} emitted={result.get('emitted_count',0)} candidates={result.get('candidate_count',0)}"
            )
        i += 1
        if once or (max_iter and i >= max_iter):
            return 0
        time.sleep(interval)


# ============================================================
# audit-trail
# ============================================================


def cmd_audit_trail(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    teams = list_teams()
    hours = getattr(args, "hours", 168)  # default 7 days
    cutoff = now_epoch() - (hours * 3600)

    audit_entries: list[dict[str, Any]] = []
    for t in teams:
        for ev in team_events(t["id"]):
            ev_type = (ev.get("type") or ev.get("event_type") or "").lower()
            ev_ts = parse_ts(ev.get("ts") or ev.get("timestamp"))
            if ev_ts >= cutoff and any(at in ev_type for at in AUDIT_EVENT_TYPES):
                audit_entries.append(
                    {
                        "timestamp": ev.get("ts") or ev.get("timestamp") or "?",
                        "team": t["id"],
                        "action": ev_type,
                        "actor": ev.get("actor")
                        or ev.get("by")
                        or ev.get("member_id")
                        or "-",
                        "target": ev.get("target")
                        or ev.get("member")
                        or ev.get("task_id")
                        or "-",
                        "detail": (ev.get("detail") or ev.get("summary") or "")[:200],
                    }
                )

    audit_entries.sort(key=lambda e: e["timestamp"])

    lines = [
        "# Audit Trail",
        "",
        f"Period: last {hours}h | Generated: {utc_now()}",
        "",
        "| Timestamp | Team | Action | Actor | Target | Detail |",
        "|-----------|------|--------|-------|--------|--------|",
    ]
    for e in audit_entries:
        lines.append(
            f"| {e['timestamp']} | {e['team']} | {e['action']} | {e['actor']} | {e['target']} | {e['detail']} |"
        )

    if not audit_entries:
        lines.append("| - | - | - | - | - | No audit events in period |")

    md = "\n".join(lines) + "\n"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = REPORTS / f"audit-trail-{stamp}.md"
    out_path.write_text(md)

    if getattr(args, "json", False):
        print(
            json.dumps({"entries": len(audit_entries), "path": str(out_path)}, indent=2)
        )
    else:
        print(md)
    return 0


# ============================================================
# CLI
# ============================================================


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="observability", description="Observability suite")
    sub = p.add_subparsers(dest="command")

    hr = sub.add_parser("health-report", help="Unified health dashboard report")
    hr.add_argument("--json", action="store_true", help="JSON output")

    tl = sub.add_parser("timeline", help="Chronological team timeline")
    tl.add_argument("--team", required=True, help="Team ID")
    tl.add_argument(
        "--hours", type=int, default=24, help="Hours to look back (default 24)"
    )
    tl.add_argument("--json", action="store_true")

    slo = sub.add_parser("slo", help="Record SLO metrics snapshot")
    slo.add_argument(
        "--report", action="store_true", help="Show report instead of recording"
    )
    slo.add_argument("--json", action="store_true")

    al = sub.add_parser("alerts", help="Evaluate or show SLO alerts")
    al.add_argument("action", nargs="?", choices=["status", "evaluate"], default="status")
    al.add_argument("--json", action="store_true")
    al.add_argument("--no-deliver", action="store_true", help="Do not write inbox notifications")

    sl = sub.add_parser("slo-loop", help="Continuous SLO/alert evaluation loop")
    sl.add_argument("--interval", type=int, default=300, help="Polling interval seconds (default 300)")
    sl.add_argument("--iterations", type=int, default=0, help="Stop after N iterations (0 = forever)")
    sl.add_argument("--once", action="store_true", help="Run one iteration and exit")
    sl.add_argument("--no-deliver", action="store_true")
    sl.add_argument("--json", action="store_true")

    ph = sub.add_parser("parity-history", help="Record/show parity grade history")
    ph.add_argument("--report", action="store_true", help="Show trend report")

    at = sub.add_parser(
        "audit-trail", help="Export audit trail of sensitive operations"
    )
    at.add_argument(
        "--hours",
        type=int,
        default=168,
        help="Hours to look back (default 168 = 7 days)",
    )
    at.add_argument("--json", action="store_true")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "health-report": cmd_health_report,
        "timeline": cmd_timeline,
        "slo": cmd_slo,
        "alerts": cmd_alerts,
        "slo-loop": cmd_slo_loop,
        "parity-history": cmd_parity_history,
        "audit-trail": cmd_audit_trail,
    }
    fn = dispatch.get(args.command)
    if not fn:
        parser.print_help()
        return 1
    return fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
