#!/usr/bin/env python3
"""Smart automation: preset recommendation, task decomposition, auto-recover, auto-scale, weekly optimization."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
TEAMS_DIR = CLAUDE / "teams"
REPORTS = CLAUDE / "reports"
COST_RUNTIME = CLAUDE / "scripts" / "cost_runtime.py"
TEAM_RUNTIME = CLAUDE / "scripts" / "team_runtime.py"
OBSERVABILITY = CLAUDE / "scripts" / "observability.py"
COST_BUDGETS = CLAUDE / "cost" / "budgets.json"
COST_CACHE = CLAUDE / "cost" / "cache.json"

# Task decomposition templates (mirrors team_runtime.py TASK_TEMPLATES)
DECOMPOSITION_TEMPLATES = {
    "build": {
        "description": "Full build pipeline",
        "tasks": [
            {"id": "plan", "title": "Plan architecture and approach", "dependsOn": []},
            {"id": "build", "title": "Implement the feature", "dependsOn": ["plan"]},
            {"id": "review", "title": "Code review", "dependsOn": ["build"]},
            {"id": "test", "title": "Write and run tests", "dependsOn": ["review"]},
            {"id": "docs", "title": "Update documentation", "dependsOn": ["test"]},
        ],
    },
    "bugfix": {
        "description": "Bug fix pipeline",
        "tasks": [
            {"id": "reproduce", "title": "Reproduce the bug", "dependsOn": []},
            {"id": "diagnose", "title": "Diagnose root cause", "dependsOn": ["reproduce"]},
            {"id": "fix", "title": "Implement fix", "dependsOn": ["diagnose"]},
            {"id": "verify", "title": "Verify fix and regression test", "dependsOn": ["fix"]},
        ],
    },
    "research": {
        "description": "Research pipeline",
        "tasks": [
            {"id": "research", "title": "Research and gather information", "dependsOn": []},
            {"id": "analyze", "title": "Analyze findings", "dependsOn": ["research"]},
            {"id": "summarize", "title": "Create summary report", "dependsOn": ["analyze"]},
        ],
    },
    "refactor": {
        "description": "Refactoring pipeline",
        "tasks": [
            {"id": "audit", "title": "Audit current code", "dependsOn": []},
            {"id": "plan", "title": "Plan refactoring approach", "dependsOn": ["audit"]},
            {"id": "refactor", "title": "Execute refactoring", "dependsOn": ["plan"]},
            {"id": "test", "title": "Run tests and validate", "dependsOn": ["refactor"]},
        ],
    },
}

PRESET_COMPOSITIONS = {
    "heavy": [
        {"name": "coder", "role": "teammate", "model": "sonnet"},
        {"name": "reviewer", "role": "teammate", "model": "sonnet"},
        {"name": "tester", "role": "teammate", "model": "sonnet"},
        {"name": "researcher", "role": "teammate", "model": "haiku"},
    ],
    "standard": [
        {"name": "coder", "role": "teammate", "model": "sonnet"},
        {"name": "reviewer", "role": "teammate", "model": "haiku"},
    ],
    "lite": [
        {"name": "worker", "role": "teammate", "model": "haiku"},
    ],
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


def _run_script(script: Path, *args: str, timeout: int = 60) -> tuple[int, str]:
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


def _emit_event(team_id: str, event_type: str, **payload: Any) -> None:
    ev = {"type": event_type, "ts": utc_now(), **payload}
    events_path = TEAMS_DIR / team_id / "events.jsonl"
    events_path.parent.mkdir(parents=True, exist_ok=True)
    with open(events_path, "a") as f:
        f.write(json.dumps(ev, separators=(",", ":")) + "\n")


def _budget_pressure(team_id: str | None = None) -> dict[str, Any]:
    """Calculate budget pressure as percentage of daily limit consumed."""
    budgets = read_json(COST_BUDGETS, {})
    cache = read_json(COST_CACHE, {})
    windows = cache.get("windows") or {}

    if team_id:
        team_key = f"today|team={team_id}|session=|project="
        entry = windows.get(team_key) if isinstance(windows, dict) else None
        limit = ((budgets.get("teams") or {}).get(team_id) or {}).get("dailyUSD")
    else:
        entry = windows.get("today") if isinstance(windows, dict) else None
        limit = (budgets.get("global") or {}).get("dailyUSD")

    if not limit or not entry:
        return {"pressure_pct": 0, "current_usd": 0, "limit_usd": 0, "available": True}

    totals = entry.get("totals") or {}
    current = totals.get("totalUSD") or totals.get("localCostUSD") or 0
    pct = (float(current) / float(limit)) * 100 if float(limit) > 0 else 0

    return {
        "pressure_pct": round(pct, 1),
        "current_usd": float(current),
        "limit_usd": float(limit),
        "available": pct < 95,
    }


# ============================================================
# I2.1: Auto-Bootstrap Recommendation
# ============================================================

def cmd_recommend_preset(args: argparse.Namespace) -> int:
    reasoning = []
    team_id = getattr(args, "team", None)
    budget = getattr(args, "budget", None)
    task_type = getattr(args, "task_type", None) or "build"
    repo = getattr(args, "repo", None)

    # Budget analysis
    if budget:
        budget_val = float(budget)
        if budget_val >= 10:
            budget_rec = "heavy"
            reasoning.append(f"Budget ${budget_val}/day supports heavy preset")
        elif budget_val >= 3:
            budget_rec = "standard"
            reasoning.append(f"Budget ${budget_val}/day supports standard preset")
        else:
            budget_rec = "lite"
            reasoning.append(f"Budget ${budget_val}/day suggests lite preset")
    elif team_id:
        bp = _budget_pressure(team_id)
        if bp["limit_usd"] > 0:
            if bp["pressure_pct"] < 50:
                budget_rec = "heavy"
                reasoning.append(f"Budget at {bp['pressure_pct']}% — room for heavy")
            elif bp["pressure_pct"] < 80:
                budget_rec = "standard"
                reasoning.append(f"Budget at {bp['pressure_pct']}% — standard recommended")
            else:
                budget_rec = "lite"
                reasoning.append(f"Budget at {bp['pressure_pct']}% — lite to conserve")
        else:
            budget_rec = "standard"
            reasoning.append("No budget limit configured — defaulting to standard")
    else:
        budget_rec = "standard"
        reasoning.append("No budget info — defaulting to standard")

    # Task type heuristic
    task_type_map = {
        "build": "heavy",
        "feature": "heavy",
        "refactor": "standard",
        "bugfix": "standard",
        "research": "lite",
        "docs": "lite",
    }
    task_rec = task_type_map.get(task_type, "standard")
    reasoning.append(f"Task type '{task_type}' suggests {task_rec}")

    # Repo size analysis
    if repo and Path(repo).exists():
        try:
            file_count = sum(1 for _ in Path(repo).rglob("*") if _.is_file() and ".git" not in str(_))
            if file_count > 500:
                repo_rec = "heavy"
                reasoning.append(f"Repo has {file_count} files — heavy recommended")
            elif file_count > 100:
                repo_rec = "standard"
                reasoning.append(f"Repo has {file_count} files — standard recommended")
            else:
                repo_rec = "lite"
                reasoning.append(f"Repo has {file_count} files — lite sufficient")
        except Exception:
            repo_rec = "standard"
            reasoning.append("Could not analyze repo — defaulting standard")
    else:
        repo_rec = budget_rec

    # Final decision: most conservative of the recommendations
    preset_order = {"lite": 0, "standard": 1, "heavy": 2}
    recommendations = [budget_rec, task_rec, repo_rec]
    # Take the median recommendation
    sorted_recs = sorted(recommendations, key=lambda x: preset_order.get(x, 1))
    final = sorted_recs[len(sorted_recs) // 2]
    reasoning.append(f"Final recommendation: {final} (median of {', '.join(recommendations)})")

    result = {
        "preset": final,
        "reasoning": reasoning,
        "composition": PRESET_COMPOSITIONS.get(final, []),
    }
    print(json.dumps(result, indent=2))
    return 0


# ============================================================
# I2.2: Auto-Task Decomposition
# ============================================================

def _detect_template(goal: str) -> str:
    goal_lower = goal.lower()
    if any(w in goal_lower for w in ("fix", "bug", "error", "broken", "crash")):
        return "bugfix"
    if any(w in goal_lower for w in ("research", "investigate", "analyze", "find out", "explore")):
        return "research"
    if any(w in goal_lower for w in ("refactor", "clean", "simplify", "reorganize")):
        return "refactor"
    return "build"


def cmd_decompose(args: argparse.Namespace) -> int:
    goal = args.goal
    team_id = getattr(args, "team", None)
    dry_run = getattr(args, "dry_run", False)
    apply = getattr(args, "apply", False)
    template_name = getattr(args, "template", None) or _detect_template(goal)

    template = DECOMPOSITION_TEMPLATES.get(template_name)
    if not template:
        print(f"Unknown template: {template_name}. Available: {', '.join(DECOMPOSITION_TEMPLATES.keys())}", file=sys.stderr)
        return 1

    # Generate task import format
    prefix = goal.lower().replace(" ", "-")[:20]
    import_tasks = []
    for t in template["tasks"]:
        task_id = f"{prefix}-{t['id']}"
        import_tasks.append({
            "taskId": task_id,
            "title": f"{t['title']}: {goal}",
            "status": "pending",
            "priority": "normal",
            "dependsOn": [f"{prefix}-{d}" for d in t["dependsOn"]],
        })

    result = {
        "goal": goal,
        "template": template_name,
        "description": template["description"],
        "tasks": import_tasks,
    }

    if dry_run or not apply:
        print(json.dumps(result, indent=2))
        if not apply:
            print("\nUse --apply to import these tasks into the team.", file=sys.stderr)
        return 0

    if apply and team_id:
        # Write temp file and import
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"tasks": import_tasks}, f, indent=2)
            tmp_path = f.name

        rc, out = _run_script(TEAM_RUNTIME, "task", "import", "--team-id", team_id, "--file", tmp_path)
        os.unlink(tmp_path)

        if rc == 0:
            _emit_event(team_id, "AutoDecomposition", goal=goal, template=template_name, taskCount=len(import_tasks))
            print(json.dumps({"status": "imported", "tasks": len(import_tasks), "detail": out[:500]}))
        else:
            print(f"Import failed: {out}", file=sys.stderr)
            return 1
    elif apply:
        print("--team required with --apply", file=sys.stderr)
        return 1

    return 0


# ============================================================
# I2.3: Auto-Recover Trigger
# ============================================================

def cmd_auto_recover(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    team_id = getattr(args, "team", None)
    all_teams = getattr(args, "all", False)

    if all_teams:
        team_ids = [d.name for d in sorted(TEAMS_DIR.iterdir()) if d.is_dir() and (d / "config.json").exists()] if TEAMS_DIR.exists() else []
    elif team_id:
        team_ids = [team_id]
    else:
        print("Specify --team or --all", file=sys.stderr)
        return 1

    results = []
    for tid in team_ids:
        # Run doctor
        rc_doctor, doctor_out = _run_script(TEAM_RUNTIME, "team", "doctor", "--team-id", tid, timeout=30)
        doctor_ok = rc_doctor == 0

        # Check SLO metrics
        slo_bad = False
        events = read_jsonl(TEAMS_DIR / tid / "events.jsonl")
        cutoff = time.time() - 3600  # last hour
        recent_failures = sum(1 for e in events if
            "fail" in (e.get("type") or "").lower() and
            _parse_ts(e.get("ts")) >= cutoff)
        recent_restarts = sum(1 for e in events if
            "restart" in (e.get("type") or "").lower() and
            _parse_ts(e.get("ts")) >= cutoff)

        if recent_failures > 3 or recent_restarts > 5:
            slo_bad = True

        needs_recovery = (not doctor_ok) or slo_bad
        action = "none"

        if needs_recovery:
            # Auto-run recover-hard
            rc_recover, recover_out = _run_script(
                TEAM_RUNTIME, "team", "recover-hard", "--team-id", tid,
                timeout=60,
            )
            action = "recover-hard"
            _emit_event(tid, "AutoRecoverTriggered",
                reason=f"doctor_ok={doctor_ok} slo_bad={slo_bad} failures={recent_failures} restarts={recent_restarts}",
                recoverResult=recover_out[:500])

            if rc_recover != 0:
                _emit_event(tid, "AutoRecoverFailed", detail=recover_out[:500])
                action = "recover-hard-failed"

        results.append({
            "team": tid,
            "doctor_ok": doctor_ok,
            "slo_bad": slo_bad,
            "recent_failures": recent_failures,
            "recent_restarts": recent_restarts,
            "action": action,
        })

    print(json.dumps({"results": results}, indent=2))
    return 0


def _parse_ts(ts: str | None) -> float:
    if not ts:
        return 0.0
    try:
        ts = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(ts).timestamp()
    except Exception:
        return 0.0


# ============================================================
# I2.4: Auto-Scale by Load
# ============================================================

def cmd_auto_scale(args: argparse.Namespace) -> int:
    team_id = args.team
    td = TEAMS_DIR / team_id
    if not td.exists():
        print(f"Team not found: {team_id}", file=sys.stderr)
        return 1

    dry_run = getattr(args, "dry_run", False)

    # Gather metrics
    tasks_doc = read_json(td / "tasks.json", {"tasks": []})
    tasks = tasks_doc.get("tasks", [])
    cfg = read_json(td / "config.json", {})
    members = cfg.get("members", [])

    pending = sum(1 for t in tasks if t.get("status") in ("pending", "blocked"))
    in_progress = sum(1 for t in tasks if t.get("status") == "in_progress")
    active_members = sum(1 for m in members if m.get("status") not in ("paused", "stopped", "replaced"))

    bp = _budget_pressure(team_id)
    budget_pct = bp["pressure_pct"]

    # SLO check
    events = read_jsonl(td / "events.jsonl")
    cutoff = time.time() - 86400
    restart_rate = sum(1 for e in events if "restart" in (e.get("type") or "").lower() and _parse_ts(e.get("ts")) >= cutoff)
    failure_rate = sum(1 for e in events if "fail" in (e.get("type") or "").lower() and _parse_ts(e.get("ts")) >= cutoff)

    # Decision matrix
    queue_depth = pending
    decision = "hold"
    target_preset = None
    reasoning = []

    if queue_depth > 10:
        if budget_pct < 50:
            decision = "scale_up"
            target_preset = "heavy"
            reasoning.append(f"Queue depth {queue_depth} > 10, budget {budget_pct}% < 50% → scale up to heavy")
        elif budget_pct < 80:
            decision = "scale_up"
            target_preset = "standard"
            reasoning.append(f"Queue depth {queue_depth} > 10, budget {budget_pct}% < 80% → scale up to standard")
        else:
            decision = "hold"
            reasoning.append(f"Queue depth {queue_depth} > 10 but budget {budget_pct}% > 80% → hold (budget constrained)")
    elif queue_depth >= 5:
        if budget_pct < 50:
            decision = "hold"
            target_preset = "standard"
            reasoning.append(f"Queue depth {queue_depth} moderate, budget OK → hold at standard")
        elif budget_pct >= 80:
            decision = "scale_down"
            target_preset = "lite"
            reasoning.append(f"Queue depth {queue_depth} moderate, budget {budget_pct}% high → scale down to lite")
        else:
            decision = "hold"
            reasoning.append(f"Queue depth {queue_depth} moderate, budget {budget_pct}% moderate → hold")
    else:
        if budget_pct >= 50:
            decision = "scale_down"
            target_preset = "lite"
            reasoning.append(f"Queue depth {queue_depth} low, budget {budget_pct}% >= 50% → scale down to lite")
        else:
            decision = "hold"
            reasoning.append(f"Queue depth {queue_depth} low, budget OK → hold")

    # SLO override: high failure = don't scale up
    if failure_rate > 5 and decision == "scale_up":
        decision = "hold"
        reasoning.append(f"SLO override: {failure_rate} failures in 24h — holding instead of scaling up")

    result = {
        "team": team_id,
        "metrics": {
            "queue_depth": queue_depth,
            "in_progress": in_progress,
            "active_members": active_members,
            "budget_pct": budget_pct,
            "restart_rate_24h": restart_rate,
            "failure_rate_24h": failure_rate,
        },
        "decision": decision,
        "target_preset": target_preset,
        "reasoning": reasoning,
    }

    if decision in ("scale_up", "scale_down") and target_preset and not dry_run:
        rc, out = _run_script(
            TEAM_RUNTIME, "team", "scale-to-preset",
            "--team-id", team_id, "--preset", target_preset,
            "--budget-aware",
            timeout=60,
        )
        result["scale_result"] = out[:500] if rc == 0 else f"failed: {out[:500]}"
        _emit_event(team_id, "AutoScaleDecision", **result)

    print(json.dumps(result, indent=2))
    return 0


# ============================================================
# I2.5: Weekly Optimization Recommendations
# ============================================================

def cmd_weekly_optimize(args: argparse.Namespace) -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    team_id = getattr(args, "team", None)
    all_teams = getattr(args, "all", False)

    if all_teams:
        team_ids = [d.name for d in sorted(TEAMS_DIR.iterdir()) if d.is_dir() and (d / "config.json").exists()] if TEAMS_DIR.exists() else []
    elif team_id:
        team_ids = [team_id]
    else:
        print("Specify --team or --all", file=sys.stderr)
        return 1

    for tid in team_ids:
        td = TEAMS_DIR / tid
        tasks_doc = read_json(td / "tasks.json", {"tasks": []})
        tasks = tasks_doc.get("tasks", [])
        events = read_jsonl(td / "events.jsonl")

        cutoff = time.time() - 7 * 86400
        week_events = [e for e in events if _parse_ts(e.get("ts")) >= cutoff]

        # Metrics
        completed_tasks = sum(1 for t in tasks if t.get("status") == "done")
        failed_restarts = sum(1 for e in week_events if "restart" in (e.get("type") or "").lower() or "fail" in (e.get("type") or "").lower())

        # Cost data
        bp = _budget_pressure(tid)

        # SLO history
        slo_history = read_jsonl(REPORTS / "slo-history.jsonl")
        team_slo = [s.get("teams", {}).get(tid, {}) for s in slo_history[-7:] if tid in s.get("teams", {})]

        avg_restart_rate = sum(s.get("restart_rate_24h", 0) for s in team_slo) / max(len(team_slo), 1)
        avg_failure_rate = sum(s.get("failure_rate_24h", 0) for s in team_slo) / max(len(team_slo), 1)

        # Generate recommendations
        recommendations = []

        # Budget recommendations
        if bp["limit_usd"] > 0:
            if bp["pressure_pct"] > 90:
                recommendations.append(f"Increase daily budget — consistently hitting {bp['pressure_pct']:.0f}% of ${bp['limit_usd']:.2f} limit")
            elif bp["pressure_pct"] < 30:
                recommendations.append(f"Budget underutilized at {bp['pressure_pct']:.0f}% — consider lowering limit to save costs")

        # Reliability recommendations
        if avg_restart_rate > 3:
            recommendations.append(f"High restart rate ({avg_restart_rate:.1f}/day avg) — investigate member stability")
        if avg_failure_rate > 2:
            recommendations.append(f"High failure rate ({avg_failure_rate:.1f}/day avg) — review error patterns")

        # Scale recommendations
        cfg = read_json(td / "config.json", {})
        member_count = len(cfg.get("members", []))
        if completed_tasks > 0 and member_count > 2:
            tasks_per_member = completed_tasks / member_count
            if tasks_per_member < 1:
                recommendations.append(f"Low utilization ({tasks_per_member:.1f} tasks/member/week) — consider scaling down")

        if failed_restarts > completed_tasks and completed_tasks > 0:
            recommendations.append(f"More failures ({failed_restarts}) than completions ({completed_tasks}) — system instability detected")

        if not recommendations:
            recommendations.append("System operating within normal parameters — no changes recommended")

        lines = [
            f"# Weekly Optimization — {tid}",
            "",
            f"Generated: {utc_now()}",
            f"Period: last 7 days",
            "",
            "## Metrics",
            "",
            f"- Completed tasks: {completed_tasks}",
            f"- Members: {member_count}",
            f"- Failed/restarted events: {failed_restarts}",
            f"- Budget pressure: {bp['pressure_pct']:.1f}% (${bp['current_usd']:.2f} / ${bp['limit_usd']:.2f})" if bp["limit_usd"] else "- Budget: no limit set",
            f"- Avg restart rate: {avg_restart_rate:.1f}/day",
            f"- Avg failure rate: {avg_failure_rate:.1f}/day",
            "",
            "## Recommendations",
            "",
        ]
        for r in recommendations:
            lines.append(f"- {r}")

        md = "\n".join(lines) + "\n"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = REPORTS / f"weekly-optimize-{tid}-{stamp}.md"
        out_path.write_text(md)
        print(md)
        print(f"\nSaved to: {out_path}", file=sys.stderr)

    return 0


# ============================================================
# CLI
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="smart_automation", description="Smart automation tools")
    sub = p.add_subparsers(dest="command")

    rp = sub.add_parser("recommend-preset", help="Recommend team preset based on budget/repo/task type")
    rp.add_argument("--team", help="Team ID (for budget lookup)")
    rp.add_argument("--budget", type=float, help="Daily budget in USD")
    rp.add_argument("--task-type", default="build", help="Task type: build, bugfix, research, refactor, docs")
    rp.add_argument("--repo", help="Repository path for size analysis")

    dc = sub.add_parser("decompose", help="Decompose goal into task graph")
    dc.add_argument("--team", help="Team ID")
    dc.add_argument("--goal", required=True, help="High-level goal description")
    dc.add_argument("--template", help="Force template: build, bugfix, research, refactor")
    dc.add_argument("--dry-run", action="store_true", help="Show tasks without importing")
    dc.add_argument("--apply", action="store_true", help="Import tasks into team")

    ar = sub.add_parser("auto-recover", help="Auto-recover teams based on health checks")
    ar.add_argument("--team", help="Team ID")
    ar.add_argument("--all", action="store_true", help="Check all teams")

    asc = sub.add_parser("auto-scale", help="Auto-scale team based on load and budget")
    asc.add_argument("--team", required=True, help="Team ID")
    asc.add_argument("--dry-run", action="store_true", help="Show decision without executing")

    wo = sub.add_parser("weekly-optimize", help="Generate weekly optimization recommendations")
    wo.add_argument("--team", help="Team ID")
    wo.add_argument("--all", action="store_true", help="All teams")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "recommend-preset": cmd_recommend_preset,
        "decompose": cmd_decompose,
        "auto-recover": cmd_auto_recover,
        "auto-scale": cmd_auto_scale,
        "weekly-optimize": cmd_weekly_optimize,
    }
    fn = dispatch.get(args.command)
    if not fn:
        parser.print_help()
        return 1
    return fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
