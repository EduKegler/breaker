# @trading/backtest — Memory

## Current state
- Full implementation complete: types, indicators (7), engine (5 modules), analysis (4), data layer (2), strategy (donchian-adx), CLI, barrel
- 175 tests passing, 20 test files, clean build
- Strategies: donchian-adx, keltner-rsi2 (both TypeScript ports of Pine scripts)
- Data sources: Bybit (default, perp USDT), Coinbase spot (BTC-USD), Coinbase perp (BTC-PERP-INTX via Advanced Trade API), Hyperliquid
- Cache keyed by (source, coin, interval, t) — different sources stored separately
- `shouldExit` deferred exit: places market order filling at next bar open (matches Pine `process_orders_on_close=false`)
- CLI supports `--start YYYY-MM-DD --end YYYY-MM-DD`, `--warmup N` (default 60), `--strategy` flag, `--cash`/risk sizing
- **TV validation (Jul16 2025–Feb19 2026, coinbase-perp):**
  - Donchian ADX: 88/95 unique entries matched (92.6%), 40 extra borderline Donchian breakouts
  - Keltner RSI2: 101/104 unique entries matched (97.1%), 298 extra borderline KC crossings (66% within 0.1% of band)
  - Extra trades in both cases caused by tiny candle data differences between Coinbase API and TV feed — not logic bugs

## Pending items
- BREAKER integration complete — breaker imports `@trading/backtest` directly, scoring uses param count from Strategy object

## Known pitfalls
- Strategies must call `init()` before `onCandle()`/`shouldExit()` when used outside the engine (e.g. in tests)
- Indicator warmup: first N values are NaN (period-dependent); strategy must guard with `isNaN()` checks
- Coinbase candle data differs slightly from TradingView feed — causes extra borderline trades in validation

## Non-obvious decisions
- **Performance fix**: Strategy `init?(candles, higherTimeframes)` lifecycle pre-computes all indicators once; `onCandle`/`shouldExit` do O(1) index lookups. Strategies fall back to on-the-fly computation if `init()` wasn't called.
- Metrics types defined locally in `types/metrics.ts` (compatible with breaker scoring)
- Indicators: EMA, SMA, ATR, RSI, ADX via `trading-signals` library wrappers; Donchian and Keltner are custom
- **Pine's ta.kc uses EMA of True Range for band width (not ATR/RMA)**. Confirmed via Pine docs + @ixjb94/indicators library
- EMA: library uses first-value seed (not SMA seed); converges after ~5x period
- Engine daily reset uses UTC (matches Pine's `dayofmonth(time, "UTC")`)
- ADX: library's pdi/mdi return fractions (multiplied by 100 in wrapper); DI available at period-1, ADX at 2*period-2
- trueRange() kept as custom standalone utility
- SQLite via better-sqlite3 for candle caching (WAL mode, in-memory for tests)
- Worst-case assumption on same-bar SL/TP conflicts (SL wins)
- Engine force-closes open positions at end of data (exitType="eod")
- Deferred exit: shouldExit clears SL/TP, places market order (tag="signal") → fills next bar open; prevents same-bar re-entry
- Higher-TF candles aggregated from source candles, not fetched separately
- Strategy uses previous-bar Donchian values ([1] in Pine) to avoid look-ahead
- Daily EMA and 1H ATR use anti-repaint equivalent (previous completed HTF bar)
- candle-client: fetchWithRetry helper deduplicates HTTP 429 retry logic; Bybit has separate fetchBybitWithRetry for body-level rate limit
- Coinbase perp uses Advanced Trade API (api.coinbase.com/api/v3/brokerage), not Exchange API
- Coinbase perp product ID format: `{COIN}-PERP-INTX` (e.g. BTC-PERP-INTX)
- Coinbase Advanced Trade granularity uses string enums (FIFTEEN_MINUTE, ONE_HOUR, etc.)
- Bybit `category=linear` is USDT-margined perpetual (already perp data)
