# CLAUDE Instructions — backtest

## Project overview
Local backtesting engine replacing TradingView automation. Fetches candles from Hyperliquid, caches in SQLite, runs strategies as TypeScript, simulates trades with realistic execution.

## Project structure
- `src/types/` — Candle, Strategy, Order, Metrics (BREAKER-compatible)
- `src/data/` — Multi-source candle client (Bybit, Coinbase, Hyperliquid; CCXT) + SQLite cache
- `src/indicators/` — EMA, SMA, ATR, RSI, ADX (via trading-signals), Donchian, Keltner (custom)
- `src/engine/` — Backtest loop, order simulation, position tracking, equity curve
- `src/analysis/` — Metrics calculation, trade analysis, walk-forward, filter simulations
- `src/strategies/{asset}/` — Strategy implementations organized by asset (btc/, sol/)
- `src/run-backtest.ts` — CLI entrypoint (isMain guard)

## Key conventions
- Strategies implement the `Strategy` interface from `types/strategy.ts` and must declare `requiredWarmup` (minimum candles per timeframe for valid signals)
- `init?(candles, higherTimeframes)` — optional Strategy method that pre-computes indicator arrays once (O(n) total). `onCandle`/`shouldExit` then do O(1) lookups. Without `init()`, per-bar recomputation is O(n²) and causes child-process timeouts in the refiner. The engine re-calls `init()` on every candle close to extend caches
- `computeLevels?(ctx, direction)` — optional Strategy method that computes SL/TPs for a forced direction (skips entry conditions). Used by exchange `/quick-signal` for manual signals. New strategies should implement this to keep manual signals strategy-agnostic
- Metrics types are identical to `@breaker/refiner` parse-results types for compatibility
- SQLite cache lives in `.cache/candles.db` (gitignored)
- All indicators are pure functions operating on number arrays
- Engine uses worst-case assumption: if SL and TP both trigger in same bar, SL wins
- `ExecutionConfig.fundingRate8h` (default 0.0004 = 0.04%/8h ≈ 0.005%/hour, KB §1.6 calm-market low-end) simulates funding cost: `fundingCost = entryPrice × size × rate × holdTime / 8h`. Deducted from `netPnl` in `CompletedTrade`. Prorated for partial closes

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

## Strategy organization (per-asset)
- `src/strategies/{asset}/` — strategy source + tests organized by asset (e.g. `btc/`, `sol/`)
- `src/strategies/{asset}/deployed/` — frozen copies used by the exchange daemon
- `src/strategies/deployed/index.ts` — top-level barrel that re-exports from all `{asset}/deployed/`
- Daemon imports from `@breaker/backtest/deployed` (sub-path export), NOT from root
- `pnpm promote <name>` or `pnpm promote --all` copies `{asset}/{name}.ts` → `{asset}/deployed/{name}.ts` with import rewriting (`../../` → `../../../`)
- `pnpm promote <name> --from-checkpoint <path>` promotes from a refiner checkpoint
- After promote, run `pnpm build` to compile and restart daemon
- The refiner can freely modify `src/strategies/{asset}/*.ts` without affecting the running daemon

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — run all tests
- `pnpm typecheck` — type-check without emitting
- `pnpm promote` — promote strategies to deployed/
- Every src file has a matching test file (TDD-first)
