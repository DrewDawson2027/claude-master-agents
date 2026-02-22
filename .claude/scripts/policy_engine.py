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
import subprocess

HOME = Path.home()
CLAUDE = HOME / ".claude"
GOV = CLAUDE / "governance"
COST = CLAUDE / "cost"
TEAM_POLICIES = GOV / "team-policies"
POLICIES_DIR = CLAUDE / "policies"
TEAM_POLICY_PROFILES = POLICIES_DIR / "team-profiles"
REPORTS = CLAUDE / "reports"
POLICY_DECISIONS_LOG = REPORTS / "policy-decisions.jsonl"
POLICY_CHANGE_HISTORY = REPORTS / "policy-change-history.jsonl"

USERNAME = os.environ.get("USER") or os.environ.get("USERNAME") or "user"
DEFAULT_GATE_MODE = "deny"


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                out.append(row)
        except Exception:
            continue
    return out


def _read_policy_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    if path.suffix.lower() == ".json":
        data = read_json(path)
        return data if isinstance(data, dict) else None
    # YAML optional support (Phase F target) with safe fallback if PyYAML isn't installed.
    if path.suffix.lower() in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(path.read_text())
            return data if isinstance(data, dict) else None
        except Exception:
            return None
    return None


def _iter_team_policy_files() -> list[Path]:
    files: list[Path] = []
    for root in (TEAM_POLICIES, TEAM_POLICY_PROFILES):
        if root.exists():
            files.extend(sorted(root.glob("*.json")))
            files.extend(sorted(root.glob("*.yaml")))
            files.extend(sorted(root.glob("*.yml")))
    # de-dupe preserving order
    seen = set()
    out = []
    for p in files:
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _policy_hash(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _record_policy_change_history() -> dict[str, Any]:
    files = [p for p in _iter_team_policy_files() if p.exists()]
    snapshot = {
        "ts": utc_now(),
        "files": [
            {
                "path": str(p),
                "sha256": _policy_hash(p),
                "size": p.stat().st_size,
                "mtime": int(p.stat().st_mtime),
            }
            for p in files
        ],
    }
    current_map = {f["path"]: f["sha256"] for f in snapshot["files"]}
    history = read_jsonl(POLICY_CHANGE_HISTORY)
    last = history[-1] if history else {}
    last_map = {f["path"]: f["sha256"] for f in (last.get("files") or []) if isinstance(f, dict)}
    changed = []
    for pth, sha in current_map.items():
        if last_map.get(pth) != sha:
            changed.append(pth)
    removed = [pth for pth in last_map if pth not in current_map]
    snapshot["changed"] = changed
    snapshot["removed"] = removed
    if changed or removed or not history:
        append_jsonl(POLICY_CHANGE_HISTORY, snapshot)
        snapshot["recorded"] = True
    else:
        snapshot["recorded"] = False
    return snapshot


def _log_policy_decision(kind: str, team_id: str | None, subject: str, result: dict[str, Any]) -> None:
    append_jsonl(
        POLICY_DECISIONS_LOG,
        {
            "ts": utc_now(),
            "kind": kind,
            "team_id": team_id,
            "subject": subject,
            "result": result,
            "user": USERNAME,
        },
    )


# ============================================================
# lint
# ============================================================


def _lint_check(name: str, ok: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "ok": ok, "detail": detail}


def _validate_json_file(
    path: Path, required_keys: list[str] | None = None
) -> dict[str, Any]:
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
            bad = [
                i
                for i, a in enumerate(approved)
                if not isinstance(a, dict) or "plugin" not in a
            ]
            if bad:
                checks.append(
                    _lint_check(
                        "tier2-approvals.json",
                        False,
                        f"entries at indices {bad} missing 'plugin' field",
                    )
                )
            else:
                checks.append(
                    _lint_check(
                        "tier2-approvals.json", True, f"{len(approved)} approvals"
                    )
                )
    else:
        checks.append(_lint_check("tier2-approvals.json", False, "file not found"))

    # marketplace-channels.json
    checks.append(_validate_json_file(GOV / "marketplace-channels.json"))
    checks.append(_validate_json_file(GOV / "slo-thresholds.json"))

    # parity-rubric.json
    rubric = GOV / "parity-rubric.json"
    if rubric.exists():
        data = read_json(rubric)
        if data is None:
            checks.append(_lint_check("parity-rubric.json", False, "invalid JSON"))
        else:
            cats = data.get("categories", {})
            bad_cats = [
                c for c, v in cats.items() if not isinstance(v.get("required"), list)
            ]
            if bad_cats:
                checks.append(
                    _lint_check(
                        "parity-rubric.json",
                        False,
                        f"categories without 'required' arrays: {bad_cats}",
                    )
                )
            else:
                checks.append(
                    _lint_check("parity-rubric.json", True, f"{len(cats)} categories")
                )
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
            checks.append(
                _lint_check("team-preset-profiles.json", False, "invalid JSON")
            )
        else:
            checks.append(
                _lint_check("team-preset-profiles.json", True, f"{len(data)} profiles")
            )
    else:
        checks.append(_lint_check("team-preset-profiles.json", False, "file not found"))

    # Team policy profiles
    for pf in _iter_team_policy_files():
        data = _read_policy_file(pf)
        label = f"team-policy:{pf.stem}"
        if data is None:
            checks.append(_lint_check(label, False, f"invalid policy file: {pf.suffix}"))
            continue
        if "team_id" not in data:
            checks.append(_lint_check(label, False, "missing 'team_id'"))
            continue
        checks.append(_lint_check(label, True, f"policy for {data['team_id']}"))

    # Policy engine metadata / history
    checks.append(_lint_check("policy-default-gate", DEFAULT_GATE_MODE == "deny", DEFAULT_GATE_MODE))
    changes = _record_policy_change_history()
    checks.append(
        _lint_check(
            "policy-change-history",
            True,
            f"files={len(changes.get('files', []))} changed={len(changes.get('changed', []))} removed={len(changes.get('removed', []))}",
        )
    )

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
    candidates = [
        TEAM_POLICIES / f"{team_id}.json",
        TEAM_POLICY_PROFILES / f"{team_id}.json",
        TEAM_POLICY_PROFILES / f"{team_id}.yaml",
        TEAM_POLICY_PROFILES / f"{team_id}.yml",
    ]
    for path in candidates:
        data = _read_policy_file(path)
        if isinstance(data, dict):
            data.setdefault("_policyPath", str(path))
            return data
    return None


def _plugin_tier(tool: str) -> str | None:
    if "@" not in tool:
        return None
    _, source = tool.rsplit("@", 1)
    if source == "claude-plugins-official":
        return "tier1"
    return "tier2"


def cmd_check_action(args: argparse.Namespace) -> int:
    action = args.action
    team_id = getattr(args, "team", None)

    policy = _load_team_policy(team_id) if team_id else None
    if not policy:
        result = {
            "approved": False,
            "reason": "no team policy defined (deny-by-default)",
            "gate": "deny_by_default",
            "team": team_id,
        }
        _log_policy_decision("action", team_id, action, result)
        print(json.dumps(result, indent=2))
        return 2

    sensitive = policy.get("sensitive_commands", {})
    gate = sensitive.get(action)

    if gate == "deny":
        result = {
            "approved": False,
            "reason": f"action '{action}' is denied by team policy",
            "gate": "deny",
        }
    elif gate == "require_lead_approval":
        result = {
            "approved": False,
            "reason": f"action '{action}' requires lead approval",
            "gate": "require_lead_approval",
        }
    elif gate:
        result = {
            "approved": False,
            "reason": f"action '{action}' gated: {gate}",
            "gate": str(gate),
        }
    else:
        result = {"approved": True, "reason": "action not restricted"}

    result["policy_path"] = policy.get("_policyPath")
    _log_policy_decision("action", team_id, action, result)
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
        result = {
            "allowed": False,
            "reason": "no team policy defined (deny-by-default)",
            "gate": "deny_by_default",
            "team": team_id,
        }
        _log_policy_decision("tool", team_id, tool, result)
        print(json.dumps(result))
        return 2

    # Check model restrictions
    blocked_models = policy.get("blocked_models", [])
    allowed_models = policy.get("allowed_models", [])

    # Check plugin restrictions
    blocked_plugins = policy.get("blocked_plugins", [])
    allowed_plugins = policy.get("allowed_plugins", ["*"])

    # Check tier2 policy
    tier2_policy = policy.get("tier2_policy", "allow")
    allowed_tier2 = set(policy.get("allowed_tier2_plugins", []) or [])
    blocked_tier2 = set(policy.get("blocked_tier2_plugins", []) or [])
    tier = _plugin_tier(tool)

    if tool in blocked_plugins:
        result = {"allowed": False, "reason": f"tool '{tool}' is blocked by team policy"}
        _log_policy_decision("tool", team_id, tool, result)
        print(json.dumps(result))
        return 2

    if tool in blocked_models:
        result = {"allowed": False, "reason": f"model '{tool}' is blocked by team policy"}
        _log_policy_decision("tool", team_id, tool, result)
        print(json.dumps(result))
        return 2

    if (
        allowed_models
        and tool in ("opus", "sonnet", "haiku")
        and tool not in allowed_models
    ):
        result = {"allowed": False, "reason": f"model '{tool}' not in allowed list: {allowed_models}"}
        _log_policy_decision("tool", team_id, tool, result)
        print(json.dumps(result))
        return 2

    if "*" not in allowed_plugins and tool not in allowed_plugins:
        result = {"allowed": False, "reason": f"tool '{tool}' not in allowed list"}
        _log_policy_decision("tool", team_id, tool, result)
        print(json.dumps(result))
        return 2

    if tier == "tier2":
        if tool in blocked_tier2:
            result = {"allowed": False, "reason": f"tier2 plugin '{tool}' blocked by team policy"}
            _log_policy_decision("tool", team_id, tool, result)
            print(json.dumps(result))
            return 2
        if tier2_policy == "deny":
            result = {"allowed": False, "reason": "tier2 plugins denied by team policy", "gate": "tier2_deny"}
            _log_policy_decision("tool", team_id, tool, result)
            print(json.dumps(result))
            return 2
        if tier2_policy == "allowlist" and tool not in allowed_tier2:
            result = {
                "allowed": False,
                "reason": f"tier2 plugin '{tool}' not in allowlist",
                "gate": "tier2_allowlist",
            }
            _log_policy_decision("tool", team_id, tool, result)
            print(json.dumps(result))
            return 2

    result = {"allowed": True, "reason": "tool permitted", "policy_path": policy.get("_policyPath"), "tier": tier}
    _log_policy_decision("tool", team_id, tool, result)
    print(json.dumps(result))
    return 0


# ============================================================
# redact
# ============================================================

SECRET_PATTERNS = [
    (
        re.compile(
            r"(API_KEY|api_key|apikey|API_SECRET|api_secret)\s*[=:]\s*\S+",
            re.IGNORECASE,
        ),
        r"\1=***REDACTED***",
    ),
    (re.compile(r"(token|TOKEN|Token)\s*[=:]\s*\S+"), r"\1=***REDACTED***"),
    (
        re.compile(r"(password|passwd|pwd)\s*[=:]\s*\S+", re.IGNORECASE),
        r"\1=***REDACTED***",
    ),
    (re.compile(r"(AKIA[0-9A-Z]{16})"), "***AWS_KEY_REDACTED***"),
    (re.compile(r"(sk-[a-zA-Z0-9]{20,})"), "***SK_KEY_REDACTED***"),
    (re.compile(r"(ghp_[a-zA-Z0-9]{36,})"), "***GH_TOKEN_REDACTED***"),
    (re.compile(r"(github_pat_[a-zA-Z0-9_]{20,})"), "***GH_PAT_REDACTED***"),
    (re.compile(r"(Bearer\s+\S+)"), "Bearer ***REDACTED***"),
    (re.compile(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----"), "***PRIVATE_KEY_REDACTED***"),
    (
        re.compile(r"([\"']?(?:apiKey|api_key|secret|client_secret|access_token|refresh_token|password)[\"']?\s*:\s*[\"']).+?([\"'])", re.IGNORECASE),
        r"\1***REDACTED***\2",
    ),
    (
        re.compile(r"([\"']?(?:apiKey|api_key|secret|client_secret|access_token|refresh_token|password)[\"']?\s*=\s*[\"']).+?([\"'])", re.IGNORECASE),
        r"\1***REDACTED***\2",
    ),
    (
        re.compile(r"(postgres(?:ql)?://[^:\s]+:)([^@/\s]+)(@)"),
        r"\1***REDACTED***\3",
    ),
]


def _redact_paths(text: str) -> str:
    home_str = str(HOME)
    text = text.replace(home_str, "~")
    # Also catch /Users/otheruser patterns
    text = re.sub(r"/Users/[a-zA-Z0-9._-]+", "~", text)
    text = re.sub(r"(/[A-Za-z0-9._-]+){3,}", "/.../REDACTED_PATH", text)
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
# validate / explain-gate
# ============================================================


def cmd_validate(args: argparse.Namespace) -> int:
    # validate is lint + policy change snapshot for explicit Phase F API name
    return cmd_lint(args)


def cmd_explain_gate(args: argparse.Namespace) -> int:
    team_id = getattr(args, "team", None)
    mode = "action" if getattr(args, "action", None) else "tool"
    policy = _load_team_policy(team_id) if team_id else None

    if not policy:
        result = {
            "approved": False,
            "mode": mode,
            "team": team_id,
            "reason": "no team policy defined (deny-by-default)",
            "gate": "deny_by_default",
            "policy_path": None,
        }
        print(json.dumps(result, indent=2))
        return 2

    if mode == "action":
        action = args.action
        sensitive = policy.get("sensitive_commands", {})
        gate = sensitive.get(action)
        approved = gate is None
        result = {
            "mode": "action",
            "team": team_id,
            "subject": action,
            "approved": approved,
            "gate": gate or "allow",
            "reason": (
                "action not restricted"
                if approved
                else f"action '{action}' gated by team policy"
            ),
            "policy_path": policy.get("_policyPath"),
            "matched_policy_fields": {
                "sensitive_commands": sensitive if gate is not None else {},
            },
        }
        print(json.dumps(result, indent=2))
        return 0 if approved else 2

    tool = args.tool
    tier = _plugin_tier(tool)
    blocked_models = policy.get("blocked_models", [])
    allowed_models = policy.get("allowed_models", [])
    blocked_plugins = policy.get("blocked_plugins", [])
    allowed_plugins = policy.get("allowed_plugins", ["*"])
    tier2_policy = policy.get("tier2_policy", "allow")
    allowed_tier2 = set(policy.get("allowed_tier2_plugins", []) or [])
    blocked_tier2 = set(policy.get("blocked_tier2_plugins", []) or [])

    reasons: list[str] = []
    approved = True
    gate = "allow"
    if tool in blocked_plugins or tool in blocked_models:
        approved = False
        gate = "blocked"
        reasons.append("listed in blocked_* policy")
    if allowed_models and tool in ("opus", "sonnet", "haiku") and tool not in allowed_models:
        approved = False
        gate = "model_allowlist"
        reasons.append("model not in allowed_models")
    if "*" not in allowed_plugins and tool not in allowed_plugins:
        approved = False
        gate = "plugin_allowlist"
        reasons.append("tool not in allowed_plugins")
    if tier == "tier2":
        if tool in blocked_tier2:
            approved = False
            gate = "tier2_blocked"
            reasons.append("tier2 plugin blocked explicitly")
        elif tier2_policy == "deny":
            approved = False
            gate = "tier2_deny"
            reasons.append("tier2 policy denies all")
        elif tier2_policy == "allowlist" and tool not in allowed_tier2:
            approved = False
            gate = "tier2_allowlist"
            reasons.append("tier2 plugin not in allowlist")

    result = {
        "mode": "tool",
        "team": team_id,
        "subject": tool,
        "approved": approved,
        "tier": tier,
        "gate": gate,
        "reason": "tool permitted" if approved else "; ".join(reasons),
        "policy_path": policy.get("_policyPath"),
        "matched_policy_fields": {
            "blocked_models": blocked_models,
            "allowed_models": allowed_models,
            "blocked_plugins": blocked_plugins,
            "allowed_plugins": allowed_plugins,
            "tier2_policy": tier2_policy,
            "allowed_tier2_plugins": sorted(allowed_tier2),
            "blocked_tier2_plugins": sorted(blocked_tier2),
        },
    }
    print(json.dumps(result, indent=2))
    return 0 if approved else 2


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
    print(
        json.dumps(
            {"status": "signed", "sha256": digest, "sig_path": str(sig_path)}, indent=2
        )
    )
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
        print(
            json.dumps(
                {
                    "status": "PASS",
                    "sha256": current_hash,
                    "signed_at": sig.get("signed_at"),
                }
            )
        )
        return 0
    else:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "reason": "hash mismatch",
                    "expected": expected_hash,
                    "actual": current_hash,
                }
            )
        )
        return 1


# ============================================================
# CLI
# ============================================================


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="policy_engine", description="Governance policy engine"
    )
    sub = p.add_subparsers(dest="command")

    lt = sub.add_parser("lint", help="Validate all governance and cost configs")
    lt.add_argument("--json", action="store_true")
    vd = sub.add_parser("validate", help="Phase F policy validate alias (lint + version snapshot)")
    vd.add_argument("--json", action="store_true")

    ca = sub.add_parser(
        "check-action", help="Check if action is allowed by team policy"
    )
    ca.add_argument(
        "--action",
        required=True,
        help="Action to check (deploy, prod_push, force_push, destructive_delete)",
    )
    ca.add_argument("--team", help="Team ID")

    ct = sub.add_parser(
        "check-tools", help="Check if tool/model is allowed by team policy"
    )
    ct.add_argument("--team", required=True, help="Team ID")
    ct.add_argument("--tool", required=True, help="Tool or model name")

    rd = sub.add_parser("redact", help="Redact sensitive content from files")
    rd.add_argument("--input", required=True, help="Input file path")
    rd.add_argument(
        "--mode",
        choices=["paths", "secrets", "full"],
        default="full",
        help="Redaction mode",
    )
    rd.add_argument("--output", help="Output file path (default: stdout)")

    sg = sub.add_parser("sign", help="Sign a file with SHA-256 checksum")
    sg.add_argument("--file", required=True, help="File to sign")

    vf = sub.add_parser("verify", help="Verify a signed file")
    vf.add_argument("--file", required=True, help="File to verify")

    eg = sub.add_parser("explain-gate", help="Explain why an action/tool is allowed or denied")
    eg_mode = eg.add_mutually_exclusive_group(required=True)
    eg_mode.add_argument("--action", help="Action to explain")
    eg_mode.add_argument("--tool", help="Tool/model/plugin to explain")
    eg.add_argument("--team", required=True, help="Team ID")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "lint": cmd_lint,
        "validate": cmd_validate,
        "check-action": cmd_check_action,
        "check-tools": cmd_check_tools,
        "explain-gate": cmd_explain_gate,
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
