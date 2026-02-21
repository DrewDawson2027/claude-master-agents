# Atlas Mode — Soccer Prop Data Platform

Atlas is a DATA PLATFORM. Not advisory. Not recommendations. Data only.

## Capabilities (consolidated Atlas expertise)
- **Domain knowledge**: full platform architecture (backend ~/Desktop/Atlas, frontend ~/atlas-betting)
- **Product identity enforcement**: DATA platform only, never advisory/recommendations
- **Dual-repo awareness**: Python backend (FastAPI) + Next.js frontend, 35 DB tables
- **MCP tools**: serena (navigate Atlas codebase semantically), pyright-lsp (type checking) via ToolSearch

---

## Product Identity (NON-NEGOTIABLE — AUTO-FAIL ON VIOLATION)

**SHOW:** stats, hit rates (L5/L10/L20/season), trends, opponent matchups, game logs, set piece duties, line history
**NEVER SHOW:** "strong_over"/"avoid" badges, recommendations, EV calculations, probability estimates, "you should bet X"

Value scores, edge calculations = INTERNAL/operator-only. Never user-facing.

**Verification grep (must return empty):**
```bash
grep -riE '(recommend|strong_over|avoid|you should|edge|probability|ev_calc)' [changed files]
```

## Architecture

```
FotMob ──→ atlas/scrapers/ ──→ SQLite/Postgres ──→ atlas/web/app.py ──→ atlas-betting (Next.js)
PrizePicks ─┘                    (35 tables)         :8000                 :3000
SofaScore ──┘                    ~1.3 GB
FBref ──────┘
```

| Repo | Path | Stack | Test Command |
|------|------|-------|-------------|
| Backend | `~/Desktop/Atlas/` | Python 3.11+, SQLAlchemy 2.0, FastAPI | `pytest tests/ -x -q` |
| Frontend | `~/atlas-betting/` | Next.js 16.1, React 19, TypeScript, Tailwind | `npm run build` |

## Key Paths

**Backend:**
- API server: `atlas/web/app.py`
- Scrapers: `atlas/scrapers/`
- Analytics: `atlas/analytics/passes_framework.py`
- Models/ORM: `atlas/models/`
- Board pipeline: `atlas/core/fast_board_collector.py`
- Config: `atlas/config.py`
- Tests: `tests/` (1,469+ tests)

**Frontend:**
- Board page: `src/app/page.tsx`
- Player page: `src/app/player/[slug]/page.tsx`
- Board table: `src/components/board/BoardTable.tsx`
- Types: `src/lib/types.ts` (82-field SoccerPropGameEntry — most-edited file)
- API client: `src/lib/api.ts`
- Data hooks: `src/lib/hooks/use-props.ts`
- Design tokens: `DESIGN_TOKENS.md` (LOCKED — read-only)
- Change rules: `CHANGE_RULES.md` (LOCKED — read-only)

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `GET /api/board` | Board data (canonical) |
| `GET /api/insights` | Trending insights |
| `GET /api/player/{name}` | Player details |
| `GET /api/player/{name}/chart` | Game log chart |
| `GET /api/player/{name}/setpieces` | Set piece duties |
| `GET /api/player/{name}/splits` | Player splits |

## Frontend Rules (before ANY frontend change)
1. Read `CHANGE_RULES.md`
2. Read `DESIGN_TOKENS.md`
3. Confirm what WILL and WON'T change
4. Make ONLY requested changes
5. `npm run build` must pass with 0 errors

## Key Formulas
- **Hit Rate:** `COUNT(stat > line) / COUNT(*)`
- **Blend Score:** `0.4 * overall + 0.3 * home_away + 0.3 * L5` (in `transforms.ts`)

## Where to Add Things

| Adding... | File(s) |
|-----------|---------|
| New stat type | `lib/types.ts` (PROP_TYPE_LABELS, STAT_TABS, getStatValue, getLineForGame) |
| New board column | `BoardTable.tsx` (th + td + sortKey) |
| New API endpoint | `atlas/web/app.py` + `lib/types.ts` + `use-props.ts` |
| New scraper | `atlas/scrapers/new_scraper.py` + pipeline import + tests |

## State Files: `~/Desktop/Atlas/.planning/`
STATE.md, ROADMAP.md, TERMINAL_LOG.md, REVIEWS.md
