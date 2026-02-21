# KPI Dashboard Design

## Dashboard Hierarchy
```
Executive Summary (1 page)     → 4-6 headline KPIs, trends, alerts
  └─ Department Views          → Sales, Marketing, Ops, Finance
      └─ Detailed Drilldowns   → Individual metrics, root cause
```

## KPI Framework Levels
| Level | Focus | Frequency | Audience |
|-------|-------|-----------|----------|
| Strategic | Long-term goals | Monthly/Quarterly | Executives |
| Tactical | Department goals | Weekly/Monthly | Managers |
| Operational | Day-to-day | Real-time/Daily | Teams |

## SMART KPIs
- **Specific**: clear definition (not "engagement" — "DAU/MAU ratio")
- **Measurable**: quantifiable with existing data
- **Achievable**: realistic targets based on benchmarks
- **Relevant**: directly tied to business objectives
- **Time-bound**: defined measurement period

## Common KPIs by Function
**SaaS/Product:** MRR, ARR, Churn rate, NRR, DAU/MAU, ARPU, LTV, CAC, LTV:CAC (>3:1)
**Sales:** Pipeline value, Win rate, Avg deal size, Sales cycle length, Close rate
**Marketing:** CAC, MQL→SQL rate, Channel ROI, Organic traffic, Conversion rate
**Engineering:** Deploy frequency, Lead time, MTTR, Change failure rate (DORA metrics)

## Layout Rules
- **Top row**: 4-6 big numbers (KPIs) with trend arrows and sparklines
- **Middle**: 2-3 charts showing trends/breakdowns
- **Bottom**: detailed table or drilldown
- **Left sidebar** (optional): filters, date range, segment selector
- **Color**: green = on track, red = below target, gray = neutral. Never decorative color.
- **Update frequency label**: show when data was last refreshed
- **Mobile**: stack vertically, big numbers first, charts second

## North Star Metric Selection
Pick ONE metric that best captures value delivery to customers:
- Spotify: "Time spent listening"
- Airbnb: "Nights booked"
- Slack: "Messages sent"
- Your product: what action = user getting value?
