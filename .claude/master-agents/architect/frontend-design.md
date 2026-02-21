# Frontend Architecture Mode

Capabilities (from: frontend architecture, kpi-dashboard-design)

## When to Use

- Designing component architectures for web apps
- Planning state management strategies
- Designing dashboard/data visualization layouts
- Architecting design systems
- Frontend performance optimization strategy

## Frontend Architecture Decisions

### Framework Selection
| Need | Choose | Why |
|------|--------|-----|
| Full-stack with SSR | Next.js | React ecosystem, Vercel, API routes |
| SPA with routing | React + React Router | Most ecosystem, jobs, libraries |
| Performance-critical | SvelteKit | Smallest bundle, fastest runtime |
| Content-heavy | Astro | Partial hydration, island architecture |
| Enterprise/opinionated | Angular | TypeScript-first, batteries included |

### State Management
| Scope | Solution | When |
|-------|----------|------|
| Component-local | useState/useReducer | Single component state |
| Shared (small app) | React Context + useReducer | < 10 contexts, simple reads |
| Shared (medium) | Zustand | Simple API, good DX, selective re-renders |
| Shared (complex) | Redux Toolkit | Time-travel debugging, middleware, large team |
| Server state | TanStack Query (React Query) | API caching, background refresh, optimistic updates |
| Forms | React Hook Form + Zod | Validation, performance, type safety |

### Component Architecture Patterns
- **Compound components**: Related components that share implicit state (Tabs + TabPanel)
- **Render props / headless**: Logic without UI (useTable, useCombobox)
- **Container / Presenter**: Separate data fetching from rendering
- **Feature-based structure**: `features/{name}/components|hooks|utils|types`
- **Barrel exports**: `index.ts` per feature folder for clean imports

### Performance Strategy
| Issue | Solution | Impact |
|-------|----------|--------|
| Large bundle | Code splitting (dynamic import) | Faster initial load |
| Re-renders | React.memo, useMemo, useCallback (measure first) | Smoother UI |
| API waterfall | Parallel fetching, prefetching, SWR/React Query | Faster data |
| Images | next/image, lazy loading, WebP/AVIF | Bandwidth |
| Layout shifts | Explicit dimensions, skeleton screens | Better CLS |

## Dashboard Design (KPI dashboards, admin panels, analytics)

### Dashboard Hierarchy
```
Executive Summary (1 page)     → 4-6 headline KPIs, trends, alerts
  └─ Department Views          → Sales, Marketing, Ops, Finance
      └─ Detailed Drilldowns   → Individual metrics, root cause
```

### KPI Framework
| Level | Focus | Frequency | Audience |
|-------|-------|-----------|----------|
| Strategic | Long-term goals | Monthly/Quarterly | Executives |
| Tactical | Department goals | Weekly/Monthly | Managers |
| Operational | Day-to-day | Real-time/Daily | Teams |

### SMART KPIs
- **Specific**: Clear definition (not "engagement" — "DAU/MAU ratio")
- **Measurable**: Quantifiable with existing data
- **Achievable**: Realistic targets based on benchmarks
- **Relevant**: Directly tied to business objectives
- **Time-bound**: Defined measurement period

### Common KPIs by Function
- **SaaS/Product**: MRR, ARR, Churn rate, NRR, DAU/MAU, ARPU, LTV, CAC, LTV:CAC (>3:1)
- **Sales**: Pipeline value, Win rate, Avg deal size, Sales cycle length
- **Marketing**: CAC, MQL→SQL rate, Channel ROI, Organic traffic, Conversion rate
- **Engineering**: Deploy frequency, Lead time, MTTR, Change failure rate (DORA)

### Dashboard Layout Rules
- **Top row**: 4-6 big numbers with trend arrows and sparklines
- **Middle**: 2-3 charts showing trends/breakdowns
- **Bottom**: Detailed table or drilldown
- **Left sidebar** (optional): Filters, date range, segment selector
- **Color**: Green = on track, Red = below target, Gray = neutral. Never decorative color.
- **Update frequency label**: Show when data was last refreshed
- **Mobile**: Stack vertically, big numbers first, charts second

### Chart Selection
| Data Type | Best Chart | Avoid |
|-----------|-----------|-------|
| Trend over time | Line chart | Pie chart |
| Part of whole | Stacked bar, treemap | 3D pie |
| Comparison | Horizontal bar | Radar chart |
| Distribution | Histogram, box plot | Line chart |
| Relationship | Scatter plot | Bar chart |
| Single KPI | Big number + sparkline | Table |

### North Star Metric
Pick ONE metric that best captures value delivery:
- Spotify: "Time spent listening"
- Airbnb: "Nights booked"
- Slack: "Messages sent"
- Your product: what action = user getting value?

## Design System Architecture

### Token-Based System
```
Design Tokens (CSS variables)
  → Primitive tokens: colors, spacing, typography
  → Semantic tokens: --color-primary, --spacing-md
  → Component tokens: --button-bg, --card-radius
```

### Component Library Structure
```
components/
  primitives/        # Button, Input, Text, Icon
  composites/        # Card, Modal, Dropdown, Table
  patterns/          # SearchBar, DataGrid, FormLayout
  layouts/           # PageShell, Sidebar, Grid
```

### Principles (Linear/Notion/Stripe-level craft)
- 4px spacing grid (4, 8, 12, 16, 24, 32, 48, 64)
- Maximum 2 font families. System fonts for body, one accent.
- Color: 1 primary, 1 accent, grays for structure. 60/30/10 rule.
- Depth: Subtle shadows only (0 1px 2px rgba(0,0,0,0.05)). No heavy drop shadows.
- Motion: 150ms ease-out for micro-interactions. Only for meaningful state changes.
- White space is a feature, not waste.

## Output Format

Always deliver:
1. **Component architecture diagram** (tree or Mermaid)
2. **State management strategy** with specific technology choices
3. **Data fetching pattern** (where data comes from, how it's cached)
4. **Performance strategy** for the specific use case
5. **File structure** showing feature-based organization
