# AGENTS Instructions — dashboard

## Status: Stub / Planned

This package is an empty stub. No runtime functionality exists yet.

## Project overview
Local analysis dashboard for visualizing backtest results, optimization history, and strategy performance metrics. Runs on localhost — no remote infra needed.

## Architecture (planned)

```
┌─────────────────────────────────────────┐
│         Data sources (read-only)        │
│  • SQLite candle cache (backtest)       │
│  • Breaker event JSON files             │
│  • Checkpoint / param-history files     │
└──────────────┬──────────────────────────┘
               │ reads directly
               ▼
┌─────────────────────────────────────────┐
│         Local API server                │
│  • Express or Hono on localhost         │
│  • Endpoints: /strategies, /trades,     │
│    /equity-curve, /optimizations        │
└──────────────┬──────────────────────────┘
               │ serves
               ▼
┌─────────────────────────────────────────┐
│         Web UI (Vite + React)           │
│  • Dashboard per strategy               │
│  • Equity curve + drawdown chart        │
│  • Win rate, PF, trades table           │
│  • Optimization history timeline        │
└─────────────────────────────────────────┘
```

## Data model

All data already exists locally — no remote DB needed:

- **Trades**: from backtest engine runs (strategy, asset, side, entry/exit prices, PnL)
- **Metrics**: computed by `@trading/backtest` analysis module (PF, WR, DD, etc.)
- **Optimization history**: breaker event JSON files + checkpoint dirs
- **Candles**: SQLite cache in `.cache/candles.db`

## Planned features

1. **Strategy comparison** — side-by-side metrics for all strategies
2. **Equity curve** — per-strategy with drawdown overlay
3. **Trade table** — filterable by strategy, date, session, direction
4. **Optimization timeline** — iteration-by-iteration metrics from breaker runs
5. **Session breakdown** — PF/WR by Asia/London/NY/Off-peak

## Tech decisions (planned)

- **No Convex** — data is local, no need for remote reactive DB
- **No Next.js** — no SSR needed for localhost tool
- **Vite + React** — fast local dev, simple build
- **API server** — lightweight (Express or Hono), reads from existing data files
- **Charts** — lightweight-charts (TradingView) or recharts

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — run tests (passWithNoTests until implemented)
- `pnpm typecheck` — type-check without emitting
