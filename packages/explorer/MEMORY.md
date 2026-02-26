# MEMORY — explorer

## Current state
- Implemented: Vite + React + Tailwind + recharts dashboard.
- 3 pages: Dashboard (positions + equity), Orders (table), Equity (chart).
- Vite proxy: `/api/*` → `http://localhost:3200/*` (exchange daemon).
- Build output: ~600KB JS (recharts is heavy), 8.5KB CSS.
- No tests yet (frontend UI; manual testing via browser).

## Pending items
- Add config page showing exchange configuration.
- Add real-time PnL summary / stats panel.
- Consider lightweight-charts for candlestick view (not MVP).
- Add error boundaries and loading skeletons.

## Known pitfalls
- recharts bundle is ~500KB — could use dynamic import to split.
- Vite proxy only works in dev mode; production needs separate API server or static hosting.

## Non-obvious decisions
- No backend API server — Vite dev proxy forwards directly to exchange:3200.
- Polling at 5-10s intervals, no WebSocket (simple, sufficient for MVP).
- usePoll hook abstracts polling with auto-refresh and error handling.
- No auth — localhost only tool. Add if multi-device access needed later.
