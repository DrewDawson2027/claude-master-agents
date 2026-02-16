# Design Principles — Jony Ive-Level UI Craft

## Design Direction (choose BEFORE coding)
1. **Context**: What does the product do? Who uses it? What emotion?
2. **Personality**: Pick one — Precision/Density (Linear), Warmth (Notion), Sophistication (Stripe), Boldness (Vercel), Utility (GitHub), Data (analytics)
3. **Color foundation**: Warm (approachable), Cool (professional), Pure neutral (technical), Tinted (distinctive)
4. **Layout**: Dense grids (data-heavy), Generous spacing (focused), Sidebar (multi-section), Split panels (list-detail)
5. **Typography**: System (native), Geometric sans (Geist/Inter), Humanist sans (SF Pro), Monospace (developer)

## Core Craft Rules (quality floor)

**4px Grid** — ALL spacing:
- 4px micro, 8px tight, 12px standard, 16px comfortable, 24px generous, 32px major

**Symmetrical Padding** — TLBR must match. Exception: horizontal needing more room (`12px 16px`)

**Border Radius** — Stick to 4px grid. Sharp = technical, Round = friendly. Commit to a system:
- Technical: 2px-4px. Friendly: 8px-12px. Mixed: 4px inputs, 8px cards, 12px modals

**Color for Meaning** — Accent for interactive + state only. Never decorative.
- Success: green. Error: red. Warning: amber. Info: blue. Everything else: neutral scale.

**Typography Hierarchy** — Max 3-4 sizes per view:
- Page title: 20-24px semibold
- Section: 14-16px semibold
- Body: 13-14px regular
- Caption: 11-12px, muted color

**Depth Strategy** — Pick ONE approach and commit:
- Flat: borders only, no shadows (Linear style)
- Subtle: `0 1px 2px rgba(0,0,0,0.05)` for cards, `0 4px 12px` for modals
- Layered: elevation system with 3-4 levels

## Anti-Patterns (NEVER do these)
- Inconsistent border radius within same component group
- More than 2 font weights visible simultaneously
- Color used decoratively instead of functionally
- Padding that varies between similar components
- Shadow AND border on the same element (pick one)
- More than 1 accent color competing for attention
