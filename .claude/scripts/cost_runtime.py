#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import deque
import csv
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
CLAUDE = HOME / '.claude'
COST_DIR = CLAUDE / 'cost'
PROJECTS_DIR = CLAUDE / 'projects'
TEAMS_DIR = CLAUDE / 'teams'
TERMINALS_DIR = CLAUDE / 'terminals'
REPORTS_DIR = CLAUDE / 'reports'
CONFIG_FILE = COST_DIR / 'config.json'
BUDGETS_FILE = COST_DIR / 'budgets.json'
CACHE_FILE = COST_DIR / 'cache.json'
USAGE_INDEX_FILE = COST_DIR / 'usage-index.json'
PRICING_CACHE_FILE = COST_DIR / 'pricing-cache.json'
STATUSLINE_CACHE_FILE = COST_DIR / 'statusline-cache.json'
SAFE_ID = re.compile(r'^[A-Za-z0-9._-]+$')


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def ensure_dirs() -> None:
    COST_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f'.{os.getpid()}.{int(time.time() * 1000)}.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    tmp.replace(path)


def safe_id(v: str, label: str) -> str:
    if not isinstance(v, str) or not v or len(v) > 120 or not SAFE_ID.match(v):
        raise SystemExit(f'Invalid {label}')
    return v


def parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return None


def load_or_init_files() -> None:
    ensure_dirs()
    if not CONFIG_FILE.exists():
        write_json(CONFIG_FILE, {
            'backend': 'ccusage',
            'offlineDefault': True,
            'costSourceDefault': 'both',
            'statusline': {
                'enabled': True,
                'fallbackHookPrint': True,
                'hookCooldownSeconds': 30,
                'showOnlyOnChange': True,
            },
            'timeouts': {
                'ccusageSeconds': 10,
                'statuslineSeconds': 4,
            },
        })
    if not BUDGETS_FILE.exists():
        write_json(BUDGETS_FILE, {
            'global': {'dailyUSD': 0, 'weeklyUSD': 0, 'monthlyUSD': 0},
            'teams': {},
            'projects': {},
            'thresholds': {'warnPct': 80, 'critPct': 95},
        })
    if not CACHE_FILE.exists():
        write_json(CACHE_FILE, {'generatedAt': utc_now(), 'source': 'local', 'windows': {}})
    if not USAGE_INDEX_FILE.exists():
        write_json(USAGE_INDEX_FILE, {'generatedAt': utc_now(), 'fingerprint': {}, 'windows': {}})
    if not PRICING_CACHE_FILE.exists():
        write_json(PRICING_CACHE_FILE, {'generatedAt': utc_now(), 'note': 'reserved for local pricing metadata mirror'})


@dataclass
class UsageRecord:
    ts: datetime
    session_id: str | None
    agent_id: str | None
    model: str | None
    project_path: str | None
    project_name: str | None
    message_type: str | None
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    cost_usd: float | None
    raw: dict[str, Any]


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0


def _float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None


def iter_usage_records(since_hint: datetime | None = None) -> list[UsageRecord]:
    rows: list[UsageRecord] = []
    if not PROJECTS_DIR.exists():
        return rows
    recent_mode = False
    if since_hint is not None:
        recent_mode = (datetime.now(timezone.utc) - since_hint) <= timedelta(days=8)
    for fp in PROJECTS_DIR.rglob('*.jsonl'):
        try:
            if since_hint is not None:
                try:
                    mtime = datetime.fromtimestamp(fp.stat().st_mtime, tz=timezone.utc)
                    if mtime + timedelta(days=1) < since_hint:
                        continue
                except Exception:
                    pass
            lines_iter = None
            if recent_mode:
                try:
                    size = fp.stat().st_size
                except Exception:
                    size = 0
                if size > 2_000_000:
                    dq: deque[str] = deque(maxlen=5000)
                    with fp.open('r', encoding='utf-8', errors='ignore') as f:
                        for line in f:
                            dq.append(line)
                    lines_iter = list(dq)
            with fp.open('r', encoding='utf-8', errors='ignore') as f:
                source_iter = lines_iter if lines_iter is not None else f
                for line in source_iter:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    msg = d.get('message') or {}
                    usage = msg.get('usage')
                    if not isinstance(usage, dict):
                        continue
                    ts = parse_ts(d.get('timestamp') or d.get('createdAt'))
                    if ts is None:
                        # Some records store ms epoch numeric timestamp
                        try:
                            ts_val = d.get('timestamp')
                            if isinstance(ts_val, (int, float)):
                                ts = datetime.fromtimestamp(float(ts_val) / (1000 if ts_val > 10_000_000_000 else 1), tz=timezone.utc)
                        except Exception:
                            ts = None
                    if ts is None:
                        continue
                    rows.append(UsageRecord(
                        ts=ts,
                        session_id=(d.get('sessionId') or '')[:8] or None,
                        agent_id=d.get('agentId'),
                        model=msg.get('model'),
                        project_path=d.get('cwd'),
                        project_name=Path(d.get('cwd') or '').name if d.get('cwd') else None,
                        message_type=msg.get('type'),
                        input_tokens=_int(usage.get('input_tokens')),
                        output_tokens=_int(usage.get('output_tokens')),
                        cache_creation_input_tokens=_int(usage.get('cache_creation_input_tokens')),
                        cache_read_input_tokens=_int(usage.get('cache_read_input_tokens')),
                        cost_usd=_float(usage.get('costUSD') or usage.get('cost_usd') or usage.get('total_cost_usd')),
                        raw=d,
                    ))
        except Exception:
            continue
    return rows


def team_membership_maps() -> tuple[dict[str, str], dict[str, str], dict[str, dict[str, str]]]:
    session_to_team: dict[str, str] = {}
    session_to_member: dict[str, str] = {}
    member_meta: dict[str, dict[str, str]] = {}
    if not TEAMS_DIR.exists():
        return session_to_team, session_to_member, member_meta
    for cfg in TEAMS_DIR.glob('*/config.json'):
        team_id = cfg.parent.name
        data = read_json(cfg, {}) or {}
        for m in data.get('members', []):
            sid = (m.get('sessionId') or '')[:8]
            mid = m.get('memberId')
            if sid and mid:
                session_to_team[sid] = team_id
                session_to_member[sid] = mid
            if mid:
                member_meta[f'{team_id}:{mid}'] = {
                    'role': str(m.get('role') or ''),
                    'kind': str(m.get('kind') or ''),
                    'sessionId': sid,
                }
    return session_to_team, session_to_member, member_meta


def project_usage_fingerprint() -> dict[str, Any]:
    count = 0
    total_size = 0
    latest_mtime = 0.0
    if PROJECTS_DIR.exists():
        for fp in PROJECTS_DIR.rglob('*.jsonl'):
            try:
                st = fp.stat()
            except Exception:
                continue
            count += 1
            total_size += int(getattr(st, 'st_size', 0) or 0)
            latest_mtime = max(latest_mtime, float(getattr(st, 'st_mtime', 0.0) or 0.0))
    return {'fileCount': count, 'totalSize': total_size, 'latestMtime': round(latest_mtime, 3)}


def load_usage_index() -> dict[str, Any]:
    return read_json(USAGE_INDEX_FILE, {'generatedAt': None, 'fingerprint': {}, 'windows': {}}) or {'generatedAt': None, 'fingerprint': {}, 'windows': {}}


def _summary_index_eligible(window: str, since: str | None, until: str | None, team_id: str | None, session_id: str | None, project: str | None, breakdown: bool) -> bool:
    return (
        window in {'today', 'week', 'month'}
        and not since and not until and not team_id and not session_id and not project
        and not breakdown
    )


def in_window(ts: datetime, since: datetime | None, until: datetime | None) -> bool:
    if since and ts < since:
        return False
    if until and ts > until:
        return False
    return True


def parse_window(window: str, since: str | None, until: str | None) -> tuple[datetime | None, datetime | None]:
    now = datetime.now(timezone.utc)
    if since or until:
        sdt = parse_ts(since + 'T00:00:00Z') if since and len(since) == 10 else parse_ts(since)
        udt = parse_ts(until + 'T23:59:59Z') if until and len(until) == 10 else parse_ts(until)
        return sdt, udt
    if window == 'today':
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        return start, None
    if window == 'week':
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) - timedelta(days=6)
        return start, None
    if window == 'month':
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        return start, None
    if window == 'active_block':
        return now - timedelta(hours=5), None
    return None, None


def aggregate_local(records: list[UsageRecord], *, team_id: str | None = None, session_id: str | None = None, project: str | None = None, since: datetime | None = None, until: datetime | None = None) -> dict[str, Any]:
    s2t, s2m, _ = team_membership_maps()
    totals = {
        'inputTokens': 0,
        'outputTokens': 0,
        'cacheCreationTokens': 0,
        'cacheReadTokens': 0,
        'localCostUSD': 0.0,
        'localCostKnown': True,
        'messages': 0,
    }
    models: dict[str, dict[str, Any]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    teams: dict[str, dict[str, Any]] = {}
    members: dict[str, dict[str, Any]] = {}
    filtered = 0
    for r in records:
        if not in_window(r.ts, since, until):
            continue
        sid = (r.session_id or '')[:8] or None
        r_team = s2t.get(sid or '') if sid else None
        r_member = s2m.get(sid or '') if sid and r_team else None
        if team_id and r_team != team_id:
            continue
        if session_id and sid != session_id[:8]:
            continue
        if project and (r.project_name or '').lower() != project.lower() and (r.project_path or '').lower() != project.lower():
            continue
        filtered += 1
        totals['messages'] += 1
        totals['inputTokens'] += r.input_tokens
        totals['outputTokens'] += r.output_tokens
        totals['cacheCreationTokens'] += r.cache_creation_input_tokens
        totals['cacheReadTokens'] += r.cache_read_input_tokens
        if r.cost_usd is not None:
            totals['localCostUSD'] += r.cost_usd
        else:
            totals['localCostKnown'] = False
        mk = r.model or 'unknown'
        m = models.setdefault(mk, {'messages': 0, 'inputTokens': 0, 'outputTokens': 0, 'cacheCreationTokens': 0, 'cacheReadTokens': 0, 'localCostUSD': 0.0, 'localCostKnown': True})
        m['messages'] += 1
        m['inputTokens'] += r.input_tokens
        m['outputTokens'] += r.output_tokens
        m['cacheCreationTokens'] += r.cache_creation_input_tokens
        m['cacheReadTokens'] += r.cache_read_input_tokens
        if r.cost_usd is not None:
            m['localCostUSD'] += r.cost_usd
        else:
            m['localCostKnown'] = False
        if sid:
            s = sessions.setdefault(sid, {'messages': 0, 'modelSet': set(), 'inputTokens': 0, 'outputTokens': 0, 'cacheCreationTokens': 0, 'cacheReadTokens': 0, 'teamId': r_team, 'memberId': r_member})
            s['messages'] += 1
            s['modelSet'].add(mk)
            s['inputTokens'] += r.input_tokens
            s['outputTokens'] += r.output_tokens
            s['cacheCreationTokens'] += r.cache_creation_input_tokens
            s['cacheReadTokens'] += r.cache_read_input_tokens
        if r_team:
            t = teams.setdefault(r_team, {'messages': 0, 'inputTokens': 0, 'outputTokens': 0, 'cacheCreationTokens': 0, 'cacheReadTokens': 0})
            t['messages'] += 1
            t['inputTokens'] += r.input_tokens
            t['outputTokens'] += r.output_tokens
            t['cacheCreationTokens'] += r.cache_creation_input_tokens
            t['cacheReadTokens'] += r.cache_read_input_tokens
        if r_team and r_member:
            key = f'{r_team}:{r_member}'
            mm = members.setdefault(key, {'teamId': r_team, 'memberId': r_member, 'messages': 0, 'inputTokens': 0, 'outputTokens': 0})
            mm['messages'] += 1
            mm['inputTokens'] += r.input_tokens
            mm['outputTokens'] += r.output_tokens

    for s in sessions.values():
        s['models'] = sorted(s.pop('modelSet'))

    return {
        'source': 'local',
        'filteredMessages': filtered,
        'totals': totals,
        'models': models,
        'sessions': sessions,
        'teams': teams,
        'members': members,
    }


def run_ccusage(args: list[str], timeout_sec: int = 10) -> tuple[bool, str, Any | None]:
    cmd = ['ccusage', *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
        out = (proc.stdout or '').strip()
        if proc.returncode != 0:
            return False, (proc.stderr or out or f'ccusage exited {proc.returncode}').strip(), None
        parsed = None
        if '--json' in args and out:
            try:
                parsed = json.loads(out)
            except Exception:
                parsed = None
        return True, out, parsed
    except Exception as e:
        return False, str(e), None


def _find_numeric_fields(obj: Any, acc: dict[str, list[float]], path: str = '') -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f'{path}.{k}' if path else k
            if isinstance(v, (int, float)):
                acc.setdefault(k, []).append(float(v))
                acc.setdefault(p, []).append(float(v))
            else:
                _find_numeric_fields(v, acc, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _find_numeric_fields(v, acc, f'{path}[{i}]')


def extract_ccusage_summary(parsed: Any) -> dict[str, Any]:
    acc: dict[str, list[float]] = {}
    _find_numeric_fields(parsed, acc)
    def pick(*names: str) -> float | None:
        for n in names:
            if n in acc and acc[n]:
                vals = acc[n]
                return max(vals) if len(vals) > 1 else vals[0]
        return None
    return {
        'totalUSD': pick('totalCostUsd', 'costUSD', 'costUsd', 'totalUsd'),
        'inputTokens': pick('inputTokens', 'input_tokens', 'totalInputTokens'),
        'outputTokens': pick('outputTokens', 'output_tokens', 'totalOutputTokens'),
        'cacheCreationTokens': pick('cacheCreationInputTokens', 'cache_creation_input_tokens'),
        'cacheReadTokens': pick('cacheReadInputTokens', 'cache_read_input_tokens'),
        'raw': parsed,
    }


def budgets() -> dict[str, Any]:
    load_or_init_files()
    return read_json(BUDGETS_FILE, {}) or {}


def compute_budget_status(*, amount_usd: float | None, team_id: str | None = None, project: str | None = None, period: str = 'daily') -> dict[str, Any]:
    b = budgets()
    key = {'daily': 'dailyUSD', 'weekly': 'weeklyUSD', 'monthly': 'monthlyUSD'}[period]
    threshold = b.get('thresholds', {'warnPct': 80, 'critPct': 95})
    limit = None
    scope = 'global'
    if team_id:
        limit = ((b.get('teams') or {}).get(team_id) or {}).get(key)
        if limit:
            scope = f'team:{team_id}'
    if project and not limit:
        limit = ((b.get('projects') or {}).get(project) or {}).get(key)
        if limit:
            scope = f'project:{project}'
    if not limit:
        limit = ((b.get('global') or {}).get(key) or 0)
    if not limit or amount_usd is None:
        return {'scope': scope, 'period': period, 'limitUSD': limit or 0, 'currentUSD': amount_usd, 'pct': None, 'level': 'none'}
    pct = (amount_usd / float(limit)) * 100.0 if limit else None
    level = 'ok'
    if pct is not None and pct >= float(threshold.get('critPct', 95)):
        level = 'critical'
    elif pct is not None and pct >= float(threshold.get('warnPct', 80)):
        level = 'warning'
    return {'scope': scope, 'period': period, 'limitUSD': float(limit), 'currentUSD': float(amount_usd), 'pct': round(pct or 0, 2), 'level': level}


def summarize(window: str, since: str | None, until: str | None, team_id: str | None, session_id: str | None, project: str | None, mode: str | None, breakdown: bool, *, use_index: bool = True) -> dict[str, Any]:
    load_or_init_files()
    if use_index and _summary_index_eligible(window, since, until, team_id, session_id, project, breakdown):
        idx = load_usage_index()
        if idx.get('fingerprint') == project_usage_fingerprint():
            cached = ((idx.get('windows') or {}).get(window))
            if isinstance(cached, dict):
                return cached
    sdt, udt = parse_window(window, since, until)
    recs = iter_usage_records(sdt)
    local = aggregate_local(recs, team_id=team_id, session_id=session_id, project=project, since=sdt, until=udt)

    cfg = read_json(CONFIG_FILE, {}) or {}
    offline = bool(cfg.get('offlineDefault', True))
    cc_cmd = 'daily'
    cc_args = [cc_cmd, '--json']
    if offline:
        cc_args.append('--offline')
    # limit query range when possible
    if sdt:
        cc_args += ['--since', sdt.strftime('%Y%m%d')]
    if udt:
        cc_args += ['--until', udt.strftime('%Y%m%d')]
    if project:
        cc_args += ['--project', project]
    ok, cc_text, cc_parsed = run_ccusage(cc_args, timeout_sec=int((cfg.get('timeouts') or {}).get('ccusageSeconds', 10)))
    cc_summary = extract_ccusage_summary(cc_parsed) if cc_parsed is not None else {'totalUSD': None, 'raw': None}

    total_usd = cc_summary.get('totalUSD')
    local_usd = local['totals']['localCostUSD'] if local['totals']['localCostKnown'] else None
    provenance = 'hybrid' if ok else 'local'
    budget = compute_budget_status(amount_usd=total_usd if total_usd is not None else local_usd, team_id=team_id, project=project, period='daily' if window in {'today','active_block'} else ('weekly' if window == 'week' else 'monthly'))

    result = {
        'generatedAt': utc_now(),
        'window': window,
        'filters': {'since': since, 'until': until, 'team_id': team_id, 'session_id': session_id, 'project': project},
        'source': provenance,
        'ccusage': {'ok': ok, 'summary': cc_summary if ok else None, 'error': None if ok else cc_text},
        'local': local,
        'totals': {
            'totalUSD': total_usd,
            'localCostUSD': local_usd,
            'inputTokens': local['totals']['inputTokens'],
            'outputTokens': local['totals']['outputTokens'],
            'cacheCreationTokens': local['totals']['cacheCreationTokens'],
            'cacheReadTokens': local['totals']['cacheReadTokens'],
            'messages': local['totals']['messages'],
        },
        'budget': budget,
    }
    cache = read_json(CACHE_FILE, {'windows': {}}) or {'windows': {}}
    cache['generatedAt'] = result['generatedAt']
    cache['source'] = result['source']
    key = window if not team_id and not session_id and not project else f"{window}|team={team_id or ''}|session={session_id or ''}|project={project or ''}"
    cache.setdefault('windows', {})[key] = result
    write_json(CACHE_FILE, cache)
    return result


def refresh_usage_index_cache(force: bool = False) -> dict[str, Any]:
    load_or_init_files()
    fp = project_usage_fingerprint()
    idx = load_usage_index()
    if not force and idx.get('fingerprint') == fp and isinstance(idx.get('windows'), dict) and all(k in idx.get('windows', {}) for k in ('today', 'week', 'month')):
        return idx
    windows: dict[str, Any] = {}
    for w in ('today', 'week', 'month'):
        windows[w] = summarize(w, None, None, None, None, None, None, False, use_index=False)
        windows[w]['source'] = str(windows[w].get('source') or 'local') + '+indexed'
    idx = {'generatedAt': utc_now(), 'fingerprint': fp, 'windows': windows}
    write_json(USAGE_INDEX_FILE, idx)
    return idx


def _burn_rate_projection(today_res: dict[str, Any], active_block_res: dict[str, Any]) -> dict[str, Any]:
    t_total = (today_res.get('totals') or {}).get('totalUSD')
    if t_total is None:
        t_total = (today_res.get('totals') or {}).get('localCostUSD')
    ab_total = (active_block_res.get('totals') or {}).get('totalUSD')
    if ab_total is None:
        ab_total = (active_block_res.get('totals') or {}).get('localCostUSD')
    rate = None
    projected = None
    if ab_total is not None:
        rate = float(ab_total) / 5.0
        projected = rate * 24.0
    return {'todayUSD': t_total, 'activeBlockUSD': ab_total, 'hourlyUSD': rate, 'projectedDailyUSD': projected}


def format_money(v: float | None) -> str:
    return 'n/a' if v is None else f'${v:,.2f}'


def render_summary(res: dict[str, Any], breakdown: bool = False) -> str:
    t = res['totals']
    lines = [
        f"## Cost Summary ({res['window']})",
        f"- Source: {res['source']}",
        f"- Total Cost: {format_money(t.get('totalUSD'))} (local-known: {format_money(t.get('localCostUSD'))})",
        f"- Tokens: in={t['inputTokens']:,} out={t['outputTokens']:,} cache_create={t['cacheCreationTokens']:,} cache_read={t['cacheReadTokens']:,}",
        f"- Messages: {t['messages']:,}",
    ]
    b = res.get('budget') or {}
    if b.get('limitUSD'):
        lines.append(f"- Budget ({b.get('scope')} {b.get('period')}): {format_money(b.get('currentUSD'))} / {format_money(b.get('limitUSD'))} [{b.get('level')}] ({b.get('pct')}%)")
    elif b.get('level') != 'none':
        lines.append(f"- Budget: {b}")
    if breakdown:
        models = res.get('local', {}).get('models', {})
        if models:
            lines.append('\n### Models (local token breakdown)')
            for model, m in sorted(models.items(), key=lambda kv: kv[1].get('inputTokens',0)+kv[1].get('outputTokens',0), reverse=True)[:20]:
                lines.append(f"- {model}: msgs={m['messages']} in={m['inputTokens']:,} out={m['outputTokens']:,}")
        teams = res.get('local', {}).get('teams', {})
        if teams:
            lines.append('\n### Teams (local token breakdown)')
            for team, m in sorted(teams.items(), key=lambda kv: kv[1].get('inputTokens',0)+kv[1].get('outputTokens',0), reverse=True)[:20]:
                lines.append(f"- {team}: msgs={m['messages']} in={m['inputTokens']:,} out={m['outputTokens']:,}")
    return '\n'.join(lines)


def cmd_summary(args: argparse.Namespace) -> int:
    res = summarize(args.window, args.since, args.until, args.team_id, args.session_id, args.project, args.mode, args.breakdown)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=args.breakdown))
    return 0


def cmd_session(args: argparse.Namespace) -> int:
    sid = safe_id(args.session_id[:8], 'session_id')
    res = summarize(args.window, args.since, args.until, None, sid, None, None, True)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
    return 0


def cmd_team(args: argparse.Namespace) -> int:
    team_id = safe_id(args.team_id, 'team_id')
    res = summarize(args.window, args.since, args.until, team_id, None, None, None, True)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
        if args.include_members:
            members = res.get('local', {}).get('members', {})
            if members:
                print('\n### Members')
                for k, v in sorted(members.items()):
                    print(f"- {k}: msgs={v['messages']} in={v['inputTokens']:,} out={v['outputTokens']:,}")
    return 0


def cmd_active_block(args: argparse.Namespace) -> int:
    res = summarize('active_block', None, None, args.team_id, None, args.project, None, True)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(render_summary(res, breakdown=True))
    return 0


def cmd_statusline(args: argparse.Namespace) -> int:
    cfg = read_json(CONFIG_FILE, {}) or {}
    offline = args.offline if args.offline is not None else bool(cfg.get('offlineDefault', True))
    csrc = args.cost_source or str(cfg.get('costSourceDefault', 'both'))
    cc_args = ['statusline', '--cost-source', csrc]
    if offline:
        cc_args.append('--offline')
    ok, text, _ = run_ccusage(cc_args, timeout_sec=int((cfg.get('timeouts') or {}).get('statuslineSeconds', 4)))
    if ok and text:
        print(text)
        return 0
    # Fallback local compact line
    res = summarize('today', None, None, args.team_id, args.session_id, args.project, None, False)
    b = res.get('budget') or {}
    level = (b.get('level') or 'none').upper()
    print(f"COST today={format_money(res['totals'].get('totalUSD') or res['totals'].get('localCostUSD'))} in={res['totals']['inputTokens']:,} out={res['totals']['outputTokens']:,} budget={level}")
    return 0


def cmd_hook_statusline(args: argparse.Namespace) -> int:
    load_or_init_files()
    cfg = read_json(CONFIG_FILE, {}) or {}
    scfg = cfg.get('statusline') or {}
    cooldown = int(scfg.get('hookCooldownSeconds', 30))
    show_only_on_change = bool(scfg.get('showOnlyOnChange', True))
    cache = read_json(STATUSLINE_CACHE_FILE, {}) or {}
    now = time.time()
    last_ts = float(cache.get('ts') or 0)
    if now - last_ts < cooldown:
        return 0
    # Build line
    cmd = ['python3', str(Path(__file__)), 'statusline']
    if args.team_id:
        cmd += ['--team-id', args.team_id]
    if args.session_id:
        cmd += ['--session-id', args.session_id]
    cp = subprocess.run(cmd, capture_output=True, text=True)
    line = (cp.stdout or '').strip()
    if not line:
        return 0
    if show_only_on_change and cache.get('line') == line:
        cache['ts'] = now
        write_json(STATUSLINE_CACHE_FILE, cache)
        return 0
    print(f"--- COST STATUSLINE ---\n{line}\n--- END COST STATUSLINE ---")
    write_json(STATUSLINE_CACHE_FILE, {'ts': now, 'line': line})
    return 0


def cmd_budget_status(args: argparse.Namespace) -> int:
    period = args.period
    res = summarize({'daily':'today','weekly':'week','monthly':'month'}[period], None, None, args.team_id, None, args.project, None, False)
    b = compute_budget_status(amount_usd=res['totals'].get('totalUSD') or res['totals'].get('localCostUSD'), team_id=args.team_id, project=args.project, period=period)
    if args.json:
        print(json.dumps(b, indent=2))
    else:
        print(f"Budget {b['scope']} {b['period']}: current={format_money(b.get('currentUSD'))} limit={format_money(b.get('limitUSD'))} level={b.get('level')} pct={b.get('pct')}")
    return 0


def cmd_set_budget(args: argparse.Namespace) -> int:
    b = budgets()
    period_key = {'daily':'dailyUSD','weekly':'weeklyUSD','monthly':'monthlyUSD'}[args.period]
    if args.scope == 'global':
        b.setdefault('global', {})[period_key] = float(args.amount_usd)
    elif args.scope == 'team':
        team_id = safe_id(args.team_id, 'team_id')
        b.setdefault('teams', {}).setdefault(team_id, {})[period_key] = float(args.amount_usd)
    elif args.scope == 'project':
        if not args.project:
            raise SystemExit('--project required for project scope')
        b.setdefault('projects', {}).setdefault(args.project, {})[period_key] = float(args.amount_usd)
    write_json(BUDGETS_FILE, b)
    print(f"Updated budget: scope={args.scope} period={args.period} amount={args.amount_usd}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    res = summarize(args.window, args.since, args.until, args.team_id, args.session_id, args.project, None, True)
    fmt = args.format
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    out_path = REPORTS_DIR / f"cost-export-{ts}.{fmt}"
    if fmt == 'json':
        write_json(out_path, res)
    elif fmt == 'md':
        out_path.write_text(render_summary(res, breakdown=True) + '\n')
    elif fmt == 'csv':
        with out_path.open('w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(['scope','id','messages','inputTokens','outputTokens'])
            for sid, v in (res.get('local', {}).get('sessions', {}) or {}).items():
                w.writerow(['session', sid, v.get('messages',0), v.get('inputTokens',0), v.get('outputTokens',0)])
            for tid, v in (res.get('local', {}).get('teams', {}) or {}).items():
                w.writerow(['team', tid, v.get('messages',0), v.get('inputTokens',0), v.get('outputTokens',0)])
    print(f"Exported {fmt}: {out_path}")
    return 0


def cmd_index_refresh(args: argparse.Namespace) -> int:
    idx = refresh_usage_index_cache(force=bool(args.force))
    if args.json:
        print(json.dumps(idx, indent=2))
    else:
        fp = idx.get('fingerprint') or {}
        print(
            "Refreshed usage index: "
            f"generatedAt={idx.get('generatedAt')} "
            f"files={fp.get('fileCount')} size={fp.get('totalSize')} latestMtime={fp.get('latestMtime')}"
        )
    return 0


def _preset_from_budget_pct(pct: float | None, *, no_budget_preset: str = 'standard') -> str:
    if pct is None:
        return no_budget_preset
    if pct <= 40:
        return 'heavy'
    if pct <= 75:
        return 'standard'
    return 'lite'


def cmd_team_budget_recommend(args: argparse.Namespace) -> int:
    # Ensure index exists to speed repeated calls.
    refresh_usage_index_cache(force=False)
    # Budget recommendation should usually use global daily burn unless team budget is set.
    team_id = args.team_id
    bdoc = budgets()
    team_has_budget = bool(team_id and (((bdoc.get('teams') or {}).get(team_id) or {}).get('dailyUSD')))
    today = summarize('today', None, None, team_id if team_has_budget else None, None, args.project, None, False)
    active_block = summarize('active_block', None, None, team_id if team_has_budget else None, None, args.project, None, False, use_index=False)
    budget = today.get('budget') or {}
    projection = _burn_rate_projection(today, active_block)
    preset = _preset_from_budget_pct(budget.get('pct'))
    burn_alert = None
    proj = projection.get('projectedDailyUSD')
    lim = budget.get('limitUSD')
    if proj is not None and lim:
        if float(proj) >= float(lim):
            burn_alert = f"Projected daily burn {proj:.2f} exceeds cap {float(lim):.2f}"
    out = {
        'generatedAt': utc_now(),
        'team_id': team_id,
        'project': args.project,
        'scope': budget.get('scope'),
        'period': budget.get('period'),
        'budget': budget,
        'projection': projection,
        'recommendedPreset': preset,
        'reason': 'budget_pct' if budget.get('pct') is not None else 'no_budget_configured',
        'burnRateAlert': burn_alert,
    }
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        print(
            f"Recommended preset: {preset}\n"
            f"- Scope: {out.get('scope')} period={out.get('period')}\n"
            f"- Budget pct: {budget.get('pct')}\n"
            f"- Today's cost: {projection.get('todayUSD')}\n"
            f"- Active-block hourly burn: {projection.get('hourlyUSD')}\n"
            f"- Projected daily burn: {projection.get('projectedDailyUSD')}\n"
            f"- Alert: {burn_alert or 'none'}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description='Claude cost parity runtime')
    sp = p.add_subparsers(dest='cmd', required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--window', choices=['today','week','month','active_block','custom'], default='today')
    common.add_argument('--since')
    common.add_argument('--until')
    common.add_argument('--team-id')
    common.add_argument('--session-id')
    common.add_argument('--project')
    common.add_argument('--json', action='store_true')
    common.add_argument('--breakdown', action='store_true')
    common.add_argument('--mode')

    sp.add_parser('summary', parents=[common])
    ses = sp.add_parser('session', parents=[common])
    ses.set_defaults(_require_session=True)
    t = sp.add_parser('team', parents=[common])
    t.set_defaults(_require_team=True)
    t.add_argument('--include-members', action='store_true')
    ab = sp.add_parser('active-block', parents=[common])

    sl = sp.add_parser('statusline')
    sl.add_argument('--team-id')
    sl.add_argument('--session-id')
    sl.add_argument('--project')
    sl.add_argument('--cost-source')
    sl.add_argument('--offline', action='store_true', default=None)

    hs = sp.add_parser('hook-statusline')
    hs.add_argument('--session-id')
    hs.add_argument('--team-id')

    bs = sp.add_parser('budget-status')
    bs.add_argument('--team-id')
    bs.add_argument('--project')
    bs.add_argument('--period', choices=['daily','weekly','monthly'], default='daily')
    bs.add_argument('--json', action='store_true')

    sb = sp.add_parser('set-budget')
    sb.add_argument('--scope', choices=['global','team','project'], required=True)
    sb.add_argument('--team-id')
    sb.add_argument('--project')
    sb.add_argument('--period', choices=['daily','weekly','monthly'], required=True)
    sb.add_argument('--amount-usd', type=float, required=True)

    ex = sp.add_parser('export', parents=[common])
    ex.add_argument('--format', choices=['json','md','csv'], required=True)

    ix = sp.add_parser('index-refresh')
    ix.add_argument('--force', action='store_true')
    ix.add_argument('--json', action='store_true')

    br = sp.add_parser('team-budget-recommend')
    br.add_argument('--team-id')
    br.add_argument('--project')
    br.add_argument('--json', action='store_true')
    return p


def main() -> int:
    load_or_init_files()
    args = build_parser().parse_args()
    if args.cmd == 'summary':
        return cmd_summary(args)
    if args.cmd == 'session':
        if not args.session_id:
            print('--session-id is required for session command', file=sys.stderr)
            return 2
        return cmd_session(args)
    if args.cmd == 'team':
        if not args.team_id:
            print('--team-id is required for team command', file=sys.stderr)
            return 2
        return cmd_team(args)
    if args.cmd == 'active-block':
        return cmd_active_block(args)
    if args.cmd == 'statusline':
        return cmd_statusline(args)
    if args.cmd == 'hook-statusline':
        return cmd_hook_statusline(args)
    if args.cmd == 'budget-status':
        return cmd_budget_status(args)
    if args.cmd == 'set-budget':
        return cmd_set_budget(args)
    if args.cmd == 'export':
        return cmd_export(args)
    if args.cmd == 'index-refresh':
        return cmd_index_refresh(args)
    if args.cmd == 'team-budget-recommend':
        return cmd_team_budget_recommend(args)
    print('unknown command', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
