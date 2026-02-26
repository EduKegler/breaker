# AGENTS Instructions — backtest

## Project overview
Local backtesting engine replacing TradingView automation. Fetches candles from Hyperliquid, caches in SQLite, runs strategies as TypeScript, simulates trades with realistic execution.

## Project structure
- `src/types/` — Candle, Strategy, Order, Metrics (BREAKER-compatible)
- `src/data/` — Multi-source candle client (Bybit, Coinbase, Hyperliquid; CCXT) + SQLite cache
- `src/indicators/` — EMA, SMA, ATR, RSI, ADX (via trading-signals), Donchian, Keltner (custom)
- `src/engine/` — Backtest loop, order simulation, position tracking, equity curve
- `src/analysis/` — Metrics calculation, trade analysis, walk-forward, filter simulations
- `src/strategies/` — Strategy implementations (TypeScript ports of Pine scripts)
- `src/run-backtest.ts` — CLI entrypoint (isMain guard)

## Key conventions
- Strategies implement the `Strategy` interface from `types/strategy.ts`
- Metrics types are identical to `@trading/breaker` parse-results types for compatibility
- SQLite cache lives in `.cache/candles.db` (gitignored)
- All indicators are pure functions operating on number arrays
- Engine uses worst-case assumption: if SL and TP both trigger in same bar, SL wins

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — run all tests
- `pnpm typecheck` — type-check without emitting
- Every src file has a matching test file (TDD-first)
