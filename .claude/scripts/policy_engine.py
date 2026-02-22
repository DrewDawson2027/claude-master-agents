#!/usr/bin/env python3
"""Policy engine: governance lint, action gates, tool checks, redaction, signed artifacts."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
GOV = CLAUDE / "governance"
COST = CLAUDE / "cost"
TEAM_POLICIES = GOV / "team-policies"
REPORTS = CLAUDE / "reports"

USERNAME = os.environ.get("USER") or os.environ.get("USERNAME") or "user"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


# ============================================================
# lint
# ============================================================

def _lint_check(name: str, ok: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "ok": ok, "detail": detail}


def _validate_json_file(path: Path, required_keys: list[str] | None = None) -> dict[str, Any]:
    if not path.exists():
        return _lint_check(path.name, False, "file not found")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return _lint_check(path.name, False, f"invalid JSON: {e}")
    if required_keys:
        missing = [k for k in required_keys if k not in data]
        if missing:
            return _lint_check(path.name, False, f"missing keys: {', '.join(missing)}")
    return _lint_check(path.name, True, "valid")


def cmd_lint(args: argparse.Namespace) -> int:
    checks: list[dict[str, Any]] = []

    # Governance files
    trust_md = GOV / "TRUST_TIERS.md"
    checks.append(_lint_check("TRUST_TIERS.md", trust_md.exists(), str(trust_md)))

    # tier2-approvals.json
    tier2 = GOV / "tier2-approvals.json"
    if tier2.exists():
        data = read_json(tier2)
        if data is None:
            checks.append(_lint_check("tier2-approvals.json", False, "invalid JSON"))
        else:
            approved = data.get("approved", [])
            bad = [i for i, a in enumerate(approved) if not isinstance(a, dict) or "plugin" not in a]
            if bad:
                checks.append(_lint_check("tier2-approvals.json", False, f"entries at indices {bad} missing 'plugin' field"))
            else:
                checks.append(_lint_check("tier2-approvals.json", True, f"{len(approved)} approvals"))
    else:
        checks.append(_lint_check("tier2-approvals.json", False, "file not found"))

    # marketplace-channels.json
    checks.append(_validate_json_file(GOV / "marketplace-channels.json"))

    # parity-rubric.json
    rubric = GOV / "parity-rubric.json"
    if rubric.exists():
        data = read_json(rubric)
        if data is None:
            checks.append(_lint_check("parity-rubric.json", False, "invalid JSON"))
        else:
            cats = data.get("categories", {})
            bad_cats = [c for c, v in cats.items() if not isinstance(v.get("required"), list)]
            if bad_cats:
                checks.append(_lint_check("parity-rubric.json", False, f"categories without 'required' arrays: {bad_cats}"))
            else:
                checks.append(_lint_check("parity-rubric.json", True, f"{len(cats)} categories"))
    else:
        checks.append(_lint_check("parity-rubric.json", False, "file not found"))

    # Cost configs
    budgets = COST / "budgets.json"
    if budgets.exists():
        data = read_json(budgets)
        if data is None:
            checks.append(_lint_check("budgets.json", False, "invalid JSON"))
        else:
            checks.append(_lint_check("budgets.json", True, "valid"))
    else:
        checks.append(_lint_check("budgets.json", False, "file not found"))

    presets = COST / "team-preset-profiles.json"
    if presets.exists():
        data = read_json(presets)
        if data is None:
            checks.append(_lint_check("team-preset-profiles.json", False, "invalid JSON"))
        else:
            checks.append(_lint_check("team-preset-profiles.json", True, f"{len(data)} profiles"))
    else:
        checks.append(_lint_check("team-preset-profiles.json", False, "file not found"))

    # Team policy profiles
    if TEAM_POLICIES.exists():
        for pf in sorted(TEAM_POLICIES.glob("*.json")):
            data = read_json(pf)
            if data is None:
                checks.append(_lint_check(f"team-policy:{pf.stem}", False, "invalid JSON"))
            elif "team_id" not in data:
                checks.append(_lint_check(f"team-policy:{pf.stem}", False, "missing 'team_id'"))
            else:
                checks.append(_lint_check(f"team-policy:{pf.stem}", True, f"policy for {data['team_id']}"))

    ok_count = sum(1 for c in checks if c["ok"])
    total = len(checks)
    status = "PASS" if ok_count == total else "WARN"

    result = {"status": status, "ok": ok_count, "total": total, "checks": checks}

    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    else:
        print(f"Policy Lint: {status} ({ok_count}/{total})")
        for c in checks:
            mark = "PASS" if c["ok"] else "FAIL"
            print(f"  [{mark}] {c['name']}: {c['detail']}")

    return 0 if status == "PASS" else 1


# ============================================================
# check-action
# ============================================================

def _load_team_policy(team_id: str) -> dict[str, Any] | None:
    path = TEAM_POLICIES / f"{team_id}.json"
    return read_json(path)


def cmd_check_action(args: argparse.Namespace) -> int:
    action = args.action
    team_id = getattr(args, "team", None)

    policy = _load_team_policy(team_id) if team_id else None
    if not policy:
        # No policy = allowed by default
        result = {"approved": True, "reason": "no team policy defined"}
        print(json.dumps(result, indent=2))
        return 0

    sensitive = policy.get("sensitive_commands", {})
    gate = sensitive.get(action)

    if gate == "deny":
        result = {"approved": False, "reason": f"action '{action}' is denied by team policy", "gate": "deny"}
    elif gate == "require_lead_approval":
        result = {"approved": False, "reason": f"action '{action}' requires lead approval", "gate": "require_lead_approval"}
    elif gate:
        result = {"approved": False, "reason": f"action '{action}' gated: {gate}", "gate": str(gate)}
    else:
        result = {"approved": True, "reason": "action not restricted"}

    print(json.dumps(result, indent=2))
    return 0 if result["approved"] else 2


# ============================================================
# check-tools
# ============================================================

def cmd_check_tools(args: argparse.Namespace) -> int:
    team_id = args.team
    tool = args.tool

    policy = _load_team_policy(team_id)
    if not policy:
        print(json.dumps({"allowed": True, "reason": "no team policy"}))
        return 0

    # Check model restrictions
    blocked_models = policy.get("blocked_models", [])
    allowed_models = policy.get("allowed_models", [])

    # Check plugin restrictions
    blocked_plugins = policy.get("blocked_plugins", [])
    allowed_plugins = policy.get("allowed_plugins", ["*"])

    # Check tier2 policy
    tier2_policy = policy.get("tier2_policy", "allow")

    if tool in blocked_plugins:
        print(json.dumps({"allowed": False, "reason": f"tool '{tool}' is blocked by team policy"}))
        return 2

    if tool in blocked_models:
        print(json.dumps({"allowed": False, "reason": f"model '{tool}' is blocked by team policy"}))
        return 2

    if allowed_models and tool in ("opus", "sonnet", "haiku") and tool not in allowed_models:
        print(json.dumps({"allowed": False, "reason": f"model '{tool}' not in allowed list: {allowed_models}"}))
        return 2

    if "*" not in allowed_plugins and tool not in allowed_plugins:
        print(json.dumps({"allowed": False, "reason": f"tool '{tool}' not in allowed list"}))
        return 2

    print(json.dumps({"allowed": True, "reason": "tool permitted"}))
    return 0


# ============================================================
# redact
# ============================================================

SECRET_PATTERNS = [
    (re.compile(r"(API_KEY|api_key|apikey|API_SECRET|api_secret)\s*[=:]\s*\S+", re.IGNORECASE), r"\1=***REDACTED***"),
    (re.compile(r"(token|TOKEN|Token)\s*[=:]\s*\S+"), r"\1=***REDACTED***"),
    (re.compile(r"(password|passwd|pwd)\s*[=:]\s*\S+", re.IGNORECASE), r"\1=***REDACTED***"),
    (re.compile(r"(AKIA[0-9A-Z]{16})"), "***AWS_KEY_REDACTED***"),
    (re.compile(r"(sk-[a-zA-Z0-9]{20,})"), "***SK_KEY_REDACTED***"),
    (re.compile(r"(ghp_[a-zA-Z0-9]{36,})"), "***GH_TOKEN_REDACTED***"),
    (re.compile(r"(Bearer\s+\S+)"), "Bearer ***REDACTED***"),
]


def _redact_paths(text: str) -> str:
    home_str = str(HOME)
    text = text.replace(home_str, "~")
    # Also catch /Users/otheruser patterns
    text = re.sub(r"/Users/[a-zA-Z0-9._-]+", "~/", text)
    return text


def _redact_secrets(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def cmd_redact(args: argparse.Namespace) -> int:
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"File not found: {input_path}", file=sys.stderr)
        return 1

    text = input_path.read_text(errors="ignore")
    mode = args.mode

    if mode in ("paths", "full"):
        text = _redact_paths(text)
    if mode in ("secrets", "full"):
        text = _redact_secrets(text)

    output_path = getattr(args, "output", None)
    if output_path:
        Path(output_path).write_text(text)
        print(f"Redacted output written to: {output_path}")
    else:
        print(text)
    return 0


# ============================================================
# sign / verify
# ============================================================

def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def cmd_sign(args: argparse.Namespace) -> int:
    file_path = Path(args.file)
    if not file_path.exists():
        print(f"File not found: {file_path}", file=sys.stderr)
        return 1

    digest = _sha256(file_path)
    sig = {
        "file": str(file_path),
        "sha256": digest,
        "signed_at": utc_now(),
        "signed_by": "system",
        "file_size": file_path.stat().st_size,
    }

    sig_path = Path(str(file_path) + ".sig")
    sig_path.write_text(json.dumps(sig, indent=2) + "\n")
    print(json.dumps({"status": "signed", "sha256": digest, "sig_path": str(sig_path)}, indent=2))
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    file_path = Path(args.file)
    sig_path = Path(str(file_path) + ".sig")

    if not file_path.exists():
        print(json.dumps({"status": "FAIL", "reason": "file not found"}))
        return 1
    if not sig_path.exists():
        print(json.dumps({"status": "FAIL", "reason": "signature file not found"}))
        return 1

    sig = read_json(sig_path)
    if not sig:
        print(json.dumps({"status": "FAIL", "reason": "invalid signature file"}))
        return 1

    current_hash = _sha256(file_path)
    expected_hash = sig.get("sha256", "")

    if current_hash == expected_hash:
        print(json.dumps({"status": "PASS", "sha256": current_hash, "signed_at": sig.get("signed_at")}))
        return 0
    else:
        print(json.dumps({"status": "FAIL", "reason": "hash mismatch", "expected": expected_hash, "actual": current_hash}))
        return 1


# ============================================================
# CLI
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="policy_engine", description="Governance policy engine")
    sub = p.add_subparsers(dest="command")

    lt = sub.add_parser("lint", help="Validate all governance and cost configs")
    lt.add_argument("--json", action="store_true")

    ca = sub.add_parser("check-action", help="Check if action is allowed by team policy")
    ca.add_argument("--action", required=True, help="Action to check (deploy, prod_push, force_push, destructive_delete)")
    ca.add_argument("--team", help="Team ID")

    ct = sub.add_parser("check-tools", help="Check if tool/model is allowed by team policy")
    ct.add_argument("--team", required=True, help="Team ID")
    ct.add_argument("--tool", required=True, help="Tool or model name")

    rd = sub.add_parser("redact", help="Redact sensitive content from files")
    rd.add_argument("--input", required=True, help="Input file path")
    rd.add_argument("--mode", choices=["paths", "secrets", "full"], default="full", help="Redaction mode")
    rd.add_argument("--output", help="Output file path (default: stdout)")

    sg = sub.add_parser("sign", help="Sign a file with SHA-256 checksum")
    sg.add_argument("--file", required=True, help="File to sign")

    vf = sub.add_parser("verify", help="Verify a signed file")
    vf.add_argument("--file", required=True, help="File to verify")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "lint": cmd_lint,
        "check-action": cmd_check_action,
        "check-tools": cmd_check_tools,
        "redact": cmd_redact,
        "sign": cmd_sign,
        "verify": cmd_verify,
    }
    fn = dispatch.get(args.command)
    if not fn:
        parser.print_help()
        return 1
    return fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
