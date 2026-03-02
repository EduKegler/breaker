# CLAUDE Instructions — backtest

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
- Strategies implement the `Strategy` interface from `types/strategy.ts` and must declare `requiredWarmup` (minimum candles per timeframe for valid signals)
- `computeLevels?(ctx, direction)` — optional Strategy method that computes SL/TPs for a forced direction (skips entry conditions). Used by exchange `/quick-signal` for manual signals. New strategies should implement this to keep manual signals strategy-agnostic
- Metrics types are identical to `@breaker/refiner` parse-results types for compatibility
- SQLite cache lives in `.cache/candles.db` (gitignored)
- All indicators are pure functions operating on number arrays
- Engine uses worst-case assumption: if SL and TP both trigger in same bar, SL wins

## Known pitfalls
- EMA: `trading-signals` library uses first-value seed (not SMA seed); converges after ~5x period
- ADX: library's pdi/mdi return fractions (multiplied by 100 in wrapper); DI available at period-1, ADX at 2*period-2
- Pine's `ta.kc` uses EMA of True Range for band width (not ATR/RMA)
- CCXT symbol mapping: bybit→`BTC/USDT:USDT`, hyperliquid→`BTC/USDC:USDC`, coinbase→`BTC/USD`, coinbase-perp→`BTC/USD:USD`
- Candle `n` (trade count) is always 0 — CCXT doesn't return it

## Non-obvious decisions
- Deferred exit: `shouldExit` clears SL/TP, places market order (tag="signal") → fills next bar open; prevents same-bar re-entry
- Higher-TF candles aggregated from source candles, not fetched separately
- Strategy uses previous-bar Donchian values ([1] in Pine) to avoid look-ahead
- Daily EMA and 1H ATR use anti-repaint equivalent (previous completed HTF bar)
- `fetchCandles` tests inject mock CCXT exchange via `_exchange` option (no module mocking)
- `computeMinWarmupBars(strategy, sourceInterval)` converts `requiredWarmup` to source bars with 20% margin for HTF bucket alignment; used by exchange StrategyRunner for auto-correction

## Deployed strategies (daemon isolation)
- `src/strategies/deployed/` — frozen copies of strategies used by the exchange daemon
- Daemon imports from `@breaker/backtest/deployed` (sub-path export), NOT from root
- `pnpm promote <name>` or `pnpm promote --all` copies source → deployed/ with import rewriting (`../` → `../../`)
- `pnpm promote <name> --from-checkpoint <path>` promotes from a refiner checkpoint
- After promote, run `pnpm build` to compile and restart daemon
- The refiner can freely modify `src/strategies/*.ts` without affecting the running daemon

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — run all tests
- `pnpm typecheck` — type-check without emitting
- `pnpm promote` — promote strategies to deployed/
- Every src file has a matching test file (TDD-first)
