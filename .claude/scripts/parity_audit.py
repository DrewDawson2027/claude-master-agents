#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
REPORTS = CLAUDE / "reports"
GOV = CLAUDE / "governance"
REPORTS.mkdir(parents=True, exist_ok=True)
GOV.mkdir(parents=True, exist_ok=True)

RUBRIC_PATH = GOV / "parity-rubric.json"

DEFAULT_RUBRIC = {
    "categories": {
        "runtime_orchestration": {
            "required": [
                "coord_team_bootstrap",
                "coord_team_teardown",
                "coord_team_resume",
                "coord_team_doctor",
                "coord_team_spawn_teammate",
                "coord_team_focus",
                "coord_team_interrupt",
            ]
        },
        "context_communication": {
            "required": [
                "coord_team_send_peer",
                "coord_team_ack_message",
                "coord_team_check_events",
            ]
        },
        "task_coordination": {
            "required": [
                "coord_team_add_task",
                "coord_team_claim_task",
                "coord_team_update_task",
                "coord_team_release_claim",
                "coord_team_dashboard",
            ]
        },
        "cost_observability": {
            "required": [
                "coord_cost_summary",
                "coord_cost_statusline",
                "coord_cost_team",
                "coord_cost_budget_status",
                "coord_cost_set_budget",
            ]
        },
        "reliability": {
            "required": ["team_runtime.py", "cost_runtime.py", "check-inbox.sh"]
        },
        "onboarding_repeatability": {
            "required": ["ONBOARDING.md", "ops-team-bootstrap.md", "ops-cost.md"]
        },
        "governance_security": {
            "required": [
                "TRUST_TIERS.md",
                "marketplace-channels.json",
                "tier2-approvals.json",
            ]
        },
        "ecosystem_distribution_local": {
            "required": [
                "sync_marketplaces.py",
                "snapshot_lock.py",
                "dead_capability_review.py",
            ]
        },
    }
}

if not RUBRIC_PATH.exists():
    RUBRIC_PATH.write_text(json.dumps(DEFAULT_RUBRIC, indent=2) + "\n")

rubric = json.loads(RUBRIC_PATH.read_text())
coord_path = CLAUDE / "mcp-coordinator" / "index.js"
coord_text = coord_path.read_text(errors="ignore") if coord_path.exists() else ""
coordinator_tools = set(re.findall(r'name:\s+"([^"]+)"', coord_text))


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def run_check(name: str, argv: list[str], timeout: int = 45) -> dict[str, Any]:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        out = (cp.stdout or "") + (cp.stderr or "")
        return {
            "name": name,
            "ok": cp.returncode == 0,
            "returncode": cp.returncode,
            "cmd": argv,
            "preview": out[:2000],
        }
    except subprocess.TimeoutExpired as e:
        return {
            "name": name,
            "ok": False,
            "returncode": None,
            "cmd": argv,
            "error": "timeout",
            "preview": ((e.stdout or "") + (e.stderr or ""))[:1000],
        }
    except Exception as e:
        return {"name": name, "ok": False, "returncode": None, "cmd": argv, "error": str(e)}


def grade_from_ratio(ratio: float) -> str:
    if ratio >= 1.0:
        return "A"
    if ratio >= 0.75:
        return "B"
    if ratio >= 0.5:
        return "C"
    return "D"


def downgrade_grade(g: str) -> str:
    order = ["A", "B", "C", "D", "F"]
    try:
        return order[min(order.index(g) + 1, len(order) - 1)]
    except Exception:
        return g


def pick_team_id() -> str | None:
    root = CLAUDE / "teams"
    if not root.exists():
        return None
    for d in sorted(root.iterdir()):
        if d.is_dir() and (d / "config.json").exists():
            return d.name
    return None


checks = {
    "files": {
        "team_runtime.py": (CLAUDE / "scripts" / "team_runtime.py").exists(),
        "cost_runtime.py": (CLAUDE / "scripts" / "cost_runtime.py").exists(),
        "check-inbox.sh": (CLAUDE / "hooks" / "check-inbox.sh").exists(),
        "ONBOARDING.md": (CLAUDE / "ONBOARDING.md").exists(),
        "ops-team-bootstrap.md": (CLAUDE / "commands" / "ops-team-bootstrap.md").exists(),
        "ops-cost.md": (CLAUDE / "commands" / "ops-cost.md").exists(),
        "TRUST_TIERS.md": (CLAUDE / "governance" / "TRUST_TIERS.md").exists(),
        "marketplace-channels.json": (CLAUDE / "governance" / "marketplace-channels.json").exists(),
        "tier2-approvals.json": (CLAUDE / "governance" / "tier2-approvals.json").exists(),
        "sync_marketplaces.py": (CLAUDE / "scripts" / "sync_marketplaces.py").exists(),
        "snapshot_lock.py": (CLAUDE / "scripts" / "snapshot_lock.py").exists(),
        "dead_capability_review.py": (CLAUDE / "scripts" / "dead_capability_review.py").exists(),
    }
}

category_results: dict[str, Any] = {}
for cat, spec in rubric.get("categories", {}).items():
    required = spec.get("required", [])
    missing = []
    for item in required:
        if item.startswith("coord_"):
            if item not in coordinator_tools:
                missing.append(item)
        elif not checks["files"].get(item, False):
            missing.append(item)
    score = len(required) - len(missing)
    ratio = (score / len(required)) if required else 1.0
    category_results[cat] = {
        "requiredCount": len(required),
        "presentCount": score,
        "missing": missing,
        "grade": grade_from_ratio(ratio),
        "verification": {"checked": False, "ok": True, "failedChecks": []},
    }

team_id = pick_team_id()
team_parity_check = run_check(
    "team_sqlite_parity",
    ["python3", str(CLAUDE / "scripts" / "team_runtime.py"), "admin", "sqlite-parity", "--all", "--json"],
    120,
)
team_selftest_check = (
    run_check("team_selftest", ["python3", str(CLAUDE / "scripts" / "team_runtime.py"), "admin", "selftest", "--team-id", team_id], 120)
    if team_id
    else {"name": "team_selftest", "ok": True, "returncode": 0, "cmd": [], "preview": "skipped (no teams)"}  # nosec - local audit metadata
)

script_checks = [
    run_check("cost_doctor", ["python3", str(CLAUDE / "scripts" / "cost_doctor.py")], 30),
    run_check("policy_lint", ["python3", str(CLAUDE / "scripts" / "policy_engine.py"), "lint", "--json"], 20),
    run_check("policy_validate", ["python3", str(CLAUDE / "scripts" / "policy_engine.py"), "validate", "--json"], 20),
    run_check("obs_health", ["python3", str(CLAUDE / "scripts" / "observability.py"), "health-report", "--json"], 60),
    run_check("obs_slo_status", ["python3", str(CLAUDE / "scripts" / "observability.py"), "slo", "--report", "--json"], 40),
    run_check("obs_alerts_status", ["python3", str(CLAUDE / "scripts" / "observability.py"), "alerts", "status", "--json"], 20),
    team_parity_check,
    team_selftest_check,
]
check_map = {c["name"]: c for c in script_checks}

category_verification_map = {
    "runtime_orchestration": ["team_sqlite_parity"],
    "context_communication": ["team_sqlite_parity"],
    "task_coordination": ["team_sqlite_parity"],
    "cost_observability": ["cost_doctor", "obs_slo_status", "obs_alerts_status"],
    "reliability": ["team_sqlite_parity"],
    "governance_security": ["policy_lint", "policy_validate"],
    "onboarding_repeatability": ["obs_health"],
}

for cat, req_checks in category_verification_map.items():
    if cat not in category_results:
        continue
    failed = [name for name in req_checks if not check_map.get(name, {}).get("ok")]
    category_results[cat]["verification"] = {
        "checked": True,
        "ok": not failed,
        "failedChecks": failed,
    }
    if failed:
        category_results[cat]["grade"] = downgrade_grade(category_results[cat]["grade"])

extra = {
    "workingChecks": {
        "total": len(script_checks),
        "passed": sum(1 for c in script_checks if c.get("ok")),
        "checks": script_checks,
    }
}

payload = {
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "rubricPath": str(RUBRIC_PATH),
    "coordinatorToolCount": len(coordinator_tools),
    "categories": category_results,
    "extra": extra,
}

json_out = REPORTS / "parity-audit-latest.json"
md_out = REPORTS / "parity-audit-latest.md"
json_out.write_text(json.dumps(payload, indent=2) + "\n")

lines = ["# Parity Audit", "", f"Generated: {payload['generatedAt']}", ""]
for cat, v in category_results.items():
    lines.append(f"## {cat}")
    lines.append(f"- Grade: {v['grade']}")
    lines.append(f"- Present: {v['presentCount']}/{v['requiredCount']}")
    ver = v.get("verification", {})
    if ver.get("checked"):
        lines.append(f"- Verification: {'PASS' if ver.get('ok') else 'FAIL'}")
        if ver.get("failedChecks"):
            lines.append(f"- Failed Checks: {', '.join(ver['failedChecks'])}")
    if v["missing"]:
        lines.append(f"- Missing: {', '.join(v['missing'])}")
    lines.append("")

wk = extra["workingChecks"]
lines += [
    "## Working Checks",
    "",
    f"- Passed: {wk['passed']}/{wk['total']}",
    "",
    "| Check | Status | Notes |",
    "|------|--------|-------|",
]
for c in wk["checks"]:
    status = "PASS" if c.get("ok") else "FAIL"
    note = c.get("error") or f"rc={c.get('returncode')}"
    lines.append(f"| {c['name']} | {status} | {str(note).replace('|','/')} |")

md_out.write_text("\n".join(lines) + "\n")
print(str(json_out))
print(str(md_out))
