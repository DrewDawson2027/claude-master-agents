#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
TEAMS_DIR = CLAUDE_DIR / "teams"


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class Migration:
    version: str
    description: str
    apply: Callable[[sqlite3.Connection, Path], list[str]]


def _ensure_base_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL,
          description TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migration_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()


def _m001_shadow_singletons(conn: sqlite3.Connection, team_root: Path) -> list[str]:
    actions: list[str] = []
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS config_doc_shadow (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS runtime_doc_shadow (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metrics_doc_shadow (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    actions.append("ensure_singleton_shadow_tables")
    return actions


def _m002_shadow_indexes(conn: sqlite3.Connection, team_root: Path) -> list[str]:
    stmts = [
        "CREATE INDEX IF NOT EXISTS idx_messages_shadow_message_id ON messages_shadow(message_id)",
        "CREATE INDEX IF NOT EXISTS idx_messages_shadow_ts ON messages_shadow(ts)",
        "CREATE INDEX IF NOT EXISTS idx_events_shadow_ts ON events_shadow(ts)",
        "CREATE INDEX IF NOT EXISTS idx_tasks_shadow_status ON tasks_shadow(status)",
        "CREATE INDEX IF NOT EXISTS idx_claims_shadow_status ON claims_shadow(status)",
        "CREATE INDEX IF NOT EXISTS idx_workers_shadow_task_id ON workers_shadow(task_id)",
    ]
    actions: list[str] = []
    for s in stmts:
        try:
            conn.execute(s)
            actions.append(s.split(" ON ")[0].replace("CREATE INDEX IF NOT EXISTS ", "index:"))
        except sqlite3.OperationalError:
            # Table may not exist yet on older teams; this migration is intentionally best-effort.
            actions.append("skip_missing_table_index")
    return actions


def _m003_seed_metrics_file_and_shadow(conn: sqlite3.Connection, team_root: Path) -> list[str]:
    actions: list[str] = []
    metrics_file = team_root / "metrics.json"
    if not metrics_file.exists():
        metrics_file.write_text(
            json.dumps(
                {"snapshots": [], "checkpoints": [], "repairs": [], "replays": []},
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        actions.append("create_metrics_json")
    try:
        payload = json.loads(metrics_file.read_text(encoding="utf-8"))
    except Exception:
        payload = {"snapshots": [], "checkpoints": [], "repairs": [], "replays": []}
    if not isinstance(payload, dict):
        payload = {"snapshots": [], "checkpoints": [], "repairs": [], "replays": []}
    for k in ("snapshots", "checkpoints", "repairs", "replays"):
        if not isinstance(payload.get(k), list):
            payload[k] = []
    conn.execute(
        """
        INSERT OR REPLACE INTO metrics_doc_shadow(singleton_id, payload_json, updated_at)
        VALUES(1, ?, ?)
        """,
        (json.dumps(payload, sort_keys=True, separators=(",", ":")), utc_now()),
    )
    actions.append("seed_metrics_shadow")
    return actions


MIGRATIONS: list[Migration] = [
    Migration("001", "Ensure singleton shadow tables exist", _m001_shadow_singletons),
    Migration("002", "Add/repair common shadow indexes", _m002_shadow_indexes),
    Migration("003", "Seed metrics.json and metrics shadow doc", _m003_seed_metrics_file_and_shadow),
]


def team_dirs(team_id: str | None = None) -> list[Path]:
    if team_id:
        p = TEAMS_DIR / team_id
        return [p] if p.exists() and p.is_dir() else []
    if not TEAMS_DIR.exists():
        return []
    return sorted([d for d in TEAMS_DIR.iterdir() if d.is_dir()])


def shadow_db_path(team_root: Path) -> Path:
    return team_root / "shadow.sqlite3"


def _applied_versions(conn: sqlite3.Connection) -> set[str]:
    _ensure_base_tables(conn)
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {str(r[0]) for r in rows}


def _record_migration(conn: sqlite3.Connection, migration: Migration) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations(version, applied_at, description) VALUES(?, ?, ?)",
        (migration.version, utc_now(), migration.description),
    )
    conn.execute(
        "INSERT OR REPLACE INTO migration_meta(key, value, updated_at) VALUES(?, ?, ?)",
        ("last_version", migration.version, utc_now()),
    )


def migrate_team(team_root: Path, dry_run: bool) -> dict:
    db_path = shadow_db_path(team_root)
    team_id = team_root.name
    report = {
        "team_id": team_id,
        "shadow_db": str(db_path),
        "exists": db_path.exists(),
        "dry_run": bool(dry_run),
        "pending": [],
        "applied": [],
        "ok": True,
        "error": None,
        "backup": None,
    }
    try:
        if not dry_run and not db_path.exists():
            db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _ensure_base_tables(conn)
        applied = _applied_versions(conn)
        pending = [m for m in MIGRATIONS if m.version not in applied]
        report["pending"] = [
            {"version": m.version, "description": m.description} for m in pending
        ]
        if dry_run:
            conn.close()
            return report
        if pending and db_path.exists():
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = db_path.with_suffix(f".sqlite3.migrate-{ts}.bak")
            try:
                shutil.copy2(db_path, backup)
                report["backup"] = str(backup)
            except Exception:
                report["backup"] = None
        for m in pending:
            actions = m.apply(conn, team_root)
            _record_migration(conn, m)
            conn.commit()
            report["applied"].append(
                {"version": m.version, "description": m.description, "actions": actions}
            )
        conn.close()
        return report
    except Exception as e:
        report["ok"] = False
        report["error"] = str(e)
        return report


def status_team(team_root: Path) -> dict:
    db_path = shadow_db_path(team_root)
    report = {
        "team_id": team_root.name,
        "shadow_db": str(db_path),
        "exists": db_path.exists(),
        "applied": [],
        "pending": [],
        "ok": True,
        "error": None,
    }
    try:
        if not db_path.exists():
            report["pending"] = [
                {"version": m.version, "description": m.description} for m in MIGRATIONS
            ]
            return report
        conn = sqlite3.connect(db_path)
        _ensure_base_tables(conn)
        applied = _applied_versions(conn)
        rows = conn.execute(
            "SELECT version, applied_at, description FROM schema_migrations ORDER BY version"
        ).fetchall()
        report["applied"] = [
            {"version": str(v), "applied_at": str(ts), "description": str(desc)}
            for (v, ts, desc) in rows
        ]
        report["pending"] = [
            {"version": m.version, "description": m.description}
            for m in MIGRATIONS
            if m.version not in applied
        ]
        conn.close()
        return report
    except Exception as e:
        report["ok"] = False
        report["error"] = str(e)
        return report


def cmd_list(args: argparse.Namespace) -> str:
    payload = [{"version": m.version, "description": m.description} for m in MIGRATIONS]
    if args.json:
        return json.dumps({"migrations": payload}, indent=2)
    lines = ["## Runtime Migrations"]
    for m in payload:
        lines.append(f"- {m['version']}: {m['description']}")
    return "\n".join(lines)


def cmd_status(args: argparse.Namespace) -> str:
    teams = team_dirs(getattr(args, "team_id", None))
    reports = [status_team(t) for t in teams]
    payload = {
        "ts": utc_now(),
        "count": len(reports),
        "teams": reports,
        "ok": all(r.get("ok") for r in reports),
    }
    if args.json:
        return json.dumps(payload, indent=2)
    lines = ["## Runtime Migration Status", f"- Teams: {len(reports)}"]
    for r in reports:
        lines.append(
            f"- {r['team_id']}: ok={r['ok']} applied={len(r['applied'])} pending={len(r['pending'])}"
        )
        if r.get("error"):
            lines.append(f"  - error: {r['error']}")
    return "\n".join(lines)


def cmd_migrate(args: argparse.Namespace) -> str:
    teams = team_dirs(getattr(args, "team_id", None))
    reports = [migrate_team(t, bool(args.dry_run)) for t in teams]
    payload = {
        "ts": utc_now(),
        "dry_run": bool(args.dry_run),
        "count": len(reports),
        "ok": all(r.get("ok") for r in reports),
        "teams": reports,
    }
    if args.json:
        return json.dumps(payload, indent=2)
    mode = "DRY RUN" if args.dry_run else "APPLY"
    lines = [f"## Runtime Migrations ({mode})", f"- Teams: {len(reports)}"]
    for r in reports:
        lines.append(
            f"- {r['team_id']}: ok={r['ok']} pending={len(r['pending'])} applied={len(r['applied'])}"
        )
        if r.get("backup"):
            lines.append(f"  - backup: {r['backup']}")
        if r.get("error"):
            lines.append(f"  - error: {r['error']}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Runtime schema migration framework")
    sp = p.add_subparsers(dest="cmd", required=True)
    c_list = sp.add_parser("list")
    c_list.add_argument("--json", action="store_true")
    c_status = sp.add_parser("status")
    c_status.add_argument("--team-id")
    c_status.add_argument("--json", action="store_true")
    c_mig = sp.add_parser("migrate")
    c_mig.add_argument("--team-id")
    c_mig.add_argument("--dry-run", action="store_true")
    c_mig.add_argument("--json", action="store_true")
    return p


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.cmd == "list":
            out = cmd_list(args)
        elif args.cmd == "status":
            out = cmd_status(args)
        elif args.cmd == "migrate":
            out = cmd_migrate(args)
        else:
            raise SystemExit(f"unknown cmd: {args.cmd}")
        if out:
            print(out)
        return 0
    except Exception as e:
        print(f"runtime_migrations error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
