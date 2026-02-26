# MEMORY — explorer

## Current state
- Empty stub package. `src/index.ts` exports nothing.
- Architecture decided: local-only (no Convex/remote DB).
- Data sources: SQLite candle cache + refiner event JSONs + checkpoint files.
- Planned stack: Vite + React frontend, lightweight API server (Express/Hono).

## Pending items
- API server reading refiner event files and backtest results.
- React UI with equity curve, trade table, strategy comparison.
- Chart library selection (lightweight-charts vs recharts).
- Integration with `@breaker/backtest` types for trade/metrics data.

## Known pitfalls
- Breaker event files are append-only NDJSON — need streaming parser for large files.
- SQLite candle cache uses WAL mode — concurrent reads from dashboard are safe.

## Non-obvious decisions
- Convex was considered (reactive subscriptions, cron, TypeScript-first) but rejected: all data is local, remote DB would just be a copy. Convex makes sense if live multi-device access is needed later.
- No Next.js — SSR is unnecessary for a localhost analysis tool. Vite + React is simpler.
- Read-only access to data sources — dashboard never writes to backtest DB or refiner files.

## Ideas from original doc (convex-dashboard-idea.md)
- If exchange goes live, Convex could be re-evaluated for real-time multi-device trade tracking.
- Incremental path: (1) exchange writes trades → (2) minimal UI (table + equity) → (3) router/refiner publish events → (4) Convex cron for auto-optimization scheduling.
- What NOT to migrate to remote DB: backtest engine (heavy compute), candle cache (large time-series), router (simple Express).
- Reference: Peter Steinberg uses Convex in OpenClaw with good results.
