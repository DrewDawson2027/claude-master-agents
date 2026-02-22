#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"
TEAMS = CLAUDE / "teams"
REPORTS = CLAUDE / "reports"
COST_RUNTIME = CLAUDE / "scripts" / "cost_runtime.py"
OUT = REPORTS / f"weekly-ops-digest-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def list_teams() -> list[dict]:
    out = []
    if not TEAMS.exists():
        return out
    for d in sorted(TEAMS.iterdir()):
        if not d.is_dir():
            continue
        cfg = d / "config.json"
        rt = d / "runtime.json"
        if not cfg.exists() or not rt.exists():
            continue
        try:
            c = json.loads(cfg.read_text())
        except Exception:
            c = {}
        try:
            r = json.loads(rt.read_text())
        except Exception:
            r = {}
        out.append(
            {
                "id": d.name,
                "name": c.get("name") or d.name,
                "state": r.get("state") or "unknown",
                "tmux": r.get("tmux_session"),
                "members": len(c.get("members") or []),
            }
        )
    return out


def lock_contention_summary() -> dict:
    rows = []
    for t in list_teams():
        metrics = TEAMS / t["id"] / "metrics.json"
        if not metrics.exists():
            continue
        try:
            data = json.loads(metrics.read_text())
        except Exception:
            continue
        lc = data.get("lockContention") or []
        if not isinstance(lc, list):
            continue
        rows.extend([r for r in lc[-200:] if isinstance(r, dict)])
    waits = []
    warns = 0
    for r in rows:
        try:
            w = float(r.get("waitSeconds") or 0)
        except Exception:
            w = 0.0
        waits.append(w)
        if r.get("warn"):
            warns += 1
    waits.sort()
    p95 = waits[int((len(waits)-1)*0.95)] if waits else 0.0
    return {
        "samples": len(rows),
        "warns": warns,
        "maxWaitSeconds": round((max(waits) if waits else 0.0), 6),
        "p95WaitSeconds": round(p95, 6),
    }


def latest_report(prefix: str) -> Path | None:
    files = sorted(REPORTS.glob(f"{prefix}-*.md"))
    return files[-1] if files else None


def parse_recover_report(report: Path | None) -> dict:
    if not report or not report.exists():
        return {"path": None, "pass": 0, "fail": 0}
    txt = report.read_text(errors="ignore")
    return {
        "path": str(report),
        "pass": len(re.findall(r"- Status: PASS", txt)),
        "fail": len(re.findall(r"- Status: FAIL", txt)),
    }


def cost_summary(window: str) -> str:
    if not COST_RUNTIME.exists():
        return "cost runtime missing"
    try:
        cp = subprocess.run(
            ["python3", str(COST_RUNTIME), "summary", "--window", window],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if cp.returncode == 0 and cp.stdout.strip():
            return cp.stdout.strip()
        return (cp.stderr or cp.stdout or "cost summary failed").strip()
    except Exception as e:
        return f"cost summary exception: {e}"


def main() -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    teams = list_teams()
    weekly_recover = parse_recover_report(latest_report("team-recover-hard-weekly"))
    all_recover = parse_recover_report(latest_report("team-recover-hard-all"))
    lock_summary = lock_contention_summary()
    lines = [
        "# Weekly Ops Digest",
        "",
        f"- Generated: {utc_now()}",
        f"- Teams tracked: {len(teams)}",
        "",
        "## Team Runtime",
        "",
        "| Team | Name | State | Members | tmux |",
        "|---|---|---|---:|---|",
    ]
    if teams:
        for t in teams:
            lines.append(
                f"| {t['id']} | {t['name']} | {t['state']} | {t['members']} | {t.get('tmux') or '—'} |"
            )
    else:
        lines.append("| — | — | — | 0 | — |")
    lines += [
        "",
        "## Recovery Sweeps",
        "",
        f"- Weekly recover-hard report: {weekly_recover.get('path') or 'none'} (pass={weekly_recover.get('pass')} fail={weekly_recover.get('fail')})",
        f"- On-demand recover-hard-all report: {all_recover.get('path') or 'none'} (pass={all_recover.get('pass')} fail={all_recover.get('fail')})",
        "",
        "## Reliability (Phase E)",
        "",
        f"- Lock contention samples: {lock_summary['samples']}",
        f"- Lock warnings: {lock_summary['warns']}",
        f"- Lock wait p95/max: {lock_summary['p95WaitSeconds']}s / {lock_summary['maxWaitSeconds']}s",
        "",
        "## Cost (Today)",
        "",
        "```",
        cost_summary("today"),
        "```",
        "",
        "## Cost (Week)",
        "",
        "```",
        cost_summary("week"),
        "```",
        "",
    ]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
