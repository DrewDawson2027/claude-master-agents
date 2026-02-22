#!/usr/bin/env python3
"""Release management: bundle, changelog, verify-bundle."""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / ".claude"
DIST = CLAUDE / "distribution"
RELEASES = DIST / "releases"
MANIFEST = DIST / "manifest.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _resolve_files(manifest: dict[str, Any]) -> list[Path]:
    """Resolve all files from manifest components."""
    files: list[Path] = []
    for comp_name, comp in manifest.get("components", {}).items():
        # Explicit file list
        for f in comp.get("files", []):
            path = CLAUDE / f
            if path.exists():
                files.append(path)

        # Glob pattern
        pattern = comp.get("pattern")
        if pattern:
            for match in sorted(CLAUDE.glob(pattern)):
                if match.is_file():
                    files.append(match)

    return sorted(set(files))


def cmd_bundle(args: argparse.Namespace) -> int:
    RELEASES.mkdir(parents=True, exist_ok=True)

    manifest = read_json(MANIFEST)
    if not manifest:
        print("Error: manifest.json not found or invalid", file=sys.stderr)
        return 1

    version = manifest.get("version", "0.0.0")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bundle_name = f"claude-parity-{version}-{stamp}.tar.gz"
    bundle_path = RELEASES / bundle_name

    files = _resolve_files(manifest)
    if not files:
        print("Error: no files resolved from manifest", file=sys.stderr)
        return 1

    # Also include key meta files
    for extra in [MANIFEST, DIST / "compatibility.md", CLAUDE / "CLAUDE.md"]:
        if extra.exists() and extra not in files:
            files.append(extra)

    with tarfile.open(bundle_path, "w:gz") as tar:
        for f in files:
            arcname = str(f.relative_to(CLAUDE))
            tar.add(f, arcname=arcname)

    size_mb = bundle_path.stat().st_size / (1024 * 1024)
    result = {
        "status": "bundled",
        "version": version,
        "path": str(bundle_path),
        "files": len(files),
        "size_mb": round(size_mb, 2),
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_changelog(args: argparse.Namespace) -> int:
    DIST.mkdir(parents=True, exist_ok=True)

    # Try to get git log
    try:
        # Find latest tag or use last 20 commits
        tag_result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True, text=True, timeout=10, check=False,
            cwd=str(HOME),
        )
        since = tag_result.stdout.strip() if tag_result.returncode == 0 else None

        log_cmd = ["git", "log", "--oneline", "--no-merges", "-n", "50"]
        if since:
            log_cmd.append(f"{since}..HEAD")

        log_result = subprocess.run(
            log_cmd, capture_output=True, text=True, timeout=10, check=False,
            cwd=str(HOME),
        )
        commits = log_result.stdout.strip().splitlines() if log_result.returncode == 0 else []
    except Exception:
        commits = []

    # Categorize commits
    features = []
    fixes = []
    other = []
    for c in commits:
        lower = c.lower()
        if any(w in lower for w in ("add ", "feat", "implement", "new ", "create")):
            features.append(c)
        elif any(w in lower for w in ("fix", "bug", "repair", "patch")):
            fixes.append(c)
        else:
            other.append(c)

    manifest = read_json(MANIFEST, {})
    version = manifest.get("version", "0.0.0")

    lines = [
        f"# Changelog — v{version}",
        "",
        f"Generated: {utc_now()}",
        "",
    ]

    if features:
        lines.append("## Features")
        lines.append("")
        lines.extend(f"- {c}" for c in features)
        lines.append("")

    if fixes:
        lines.append("## Fixes")
        lines.append("")
        lines.extend(f"- {c}" for c in fixes)
        lines.append("")

    if other:
        lines.append("## Other")
        lines.append("")
        lines.extend(f"- {c}" for c in other)
        lines.append("")

    if not commits:
        lines.append("No commits found since last release.")

    out = DIST / "CHANGELOG.md"
    out.write_text("\n".join(lines) + "\n")
    print(f"Changelog written to: {out}")
    print(f"  Features: {len(features)}, Fixes: {len(fixes)}, Other: {len(other)}")
    return 0


def cmd_verify_bundle(args: argparse.Namespace) -> int:
    bundle_path = Path(args.bundle)
    if not bundle_path.exists():
        print(f"Bundle not found: {bundle_path}", file=sys.stderr)
        return 1

    checks: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            with tarfile.open(bundle_path, "r:gz") as tar:
                tar.extractall(tmpdir)
            checks.append({"name": "extract", "ok": True, "detail": "extracted successfully"})
        except Exception as e:
            checks.append({"name": "extract", "ok": False, "detail": str(e)})
            print(json.dumps({"status": "FAIL", "checks": checks}, indent=2))
            return 1

        # Check manifest
        manifest_path = Path(tmpdir) / "distribution" / "manifest.json"
        if manifest_path.exists():
            manifest = read_json(manifest_path, {})
            checks.append({"name": "manifest", "ok": True, "detail": f"version {manifest.get('version', '?')}"})
        else:
            checks.append({"name": "manifest", "ok": False, "detail": "manifest.json missing"})

        # Check required components
        if manifest_path.exists() and manifest:
            for comp_name, comp in manifest.get("components", {}).items():
                if not comp.get("required"):
                    continue
                for f in comp.get("files", []):
                    fpath = Path(tmpdir) / f
                    ok = fpath.exists()
                    checks.append({"name": f"file:{f}", "ok": ok, "detail": "present" if ok else "MISSING"})

        # Count files
        extracted_files = []
        for root, dirs, fnames in os.walk(tmpdir):
            for fname in fnames:
                extracted_files.append(os.path.join(root, fname))
        checks.append({"name": "file_count", "ok": len(extracted_files) > 0, "detail": f"{len(extracted_files)} files"})

    ok_count = sum(1 for c in checks if c["ok"])
    total = len(checks)
    status = "PASS" if ok_count == total else "FAIL"

    result = {"status": status, "ok": ok_count, "total": total, "checks": checks}
    print(json.dumps(result, indent=2))
    return 0 if status == "PASS" else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="release", description="Release management")
    sub = p.add_subparsers(dest="command")

    sub.add_parser("bundle", help="Create release bundle tarball")
    sub.add_parser("changelog", help="Generate changelog from git history")

    vb = sub.add_parser("verify-bundle", help="Verify a release bundle")
    vb.add_argument("bundle", help="Path to bundle tarball")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "bundle": cmd_bundle,
        "changelog": cmd_changelog,
        "verify-bundle": cmd_verify_bundle,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
