# MEMORY — exchange

## Current state
- Fully implemented autonomous trading daemon with strategy runner, risk engine, and Hyperliquid execution.
- 19 test files, 257 tests passing. Build clean.
- Architecture: domain (pure logic) / adapters (I/O) / application (orchestration) / server + daemon.
- SQLite for persistence (signals, orders, fills, equity), NDJSON for audit trail.
- Reuses Strategy, Signal, Candle, fetchCandles from @breaker/backtest.
- Shared buildContext/canTrade from backtest engine-shared.ts ensures semantic equivalence.
- **Testnet validated**: daemon starts, connects to HL testnet, warmup + polling + signal execution work.
- **Event-driven sync**: HlEventStream subscribes to HL WebSocket for order updates + user fills (callbacks wrapped in try-catch + started guard). Reconcile loop is safety net at 5min interval, alerts via WhatsApp on 3 consecutive API failures.
- **Structured logging**: `createChildLogger(module)` with per-module log levels from `logLevels` config. `LOG_LEVEL` env var sets global default. VITEST guard returns silent logger.
- **Dry-run mode**: `dryRun: true` in config uses `DryRunHlClient` — logs actions without executing. No SDK connection needed.
- **resolveOrderStatus**: centralized HL→internal status mapping in `domain/order-status.ts`, used by reconcile-loop, daemon syncAndBroadcast, and WS push handler.

## Pending items
- Testnet+mainnet wallet: 0xf6e7...D03b (testnet has ~996 USDC, mainnet ~520 USDC).
- Verify fill confirmation: daemon assumes order is filled after placeMarketOrder returns oid, but IOC orders may be cancelled by exchange (no margin). Need post-order userFills check.
- Equity snapshots recorded every reconcile tick (5min) via ReconcileLoop.check().
- WhatsApp notifications on position open + API down (3 consecutive reconcile failures). Extend to SL hit, TP hit.
- Signal handler has SL failure rollback (compensating transaction): if SL placement fails, entry is closed. If close also fails, position hydrated with stopLoss=0.

## Known pitfalls
- **Input validation at data boundaries**: `lib/validators.ts` has guard functions (finiteOrThrow, finiteOr, isSanePrice etc.) applied in adapters. HyperliquidClient validates SDK Number() casts, CandlePoller filters invalid OHLCV, PositionBook.updatePrice rejects NaN/Infinity/non-positive, ReconcileLoop guards derived price + equity. Daemon WS handler validates statusTimestamp.
- SDK expects `BTC-PERP` format, NOT plain `BTC` — `toSymbol()` in HyperliquidClient handles this.
- SDK `floatToWire` rejects sizes with too many decimals — `truncateSize()` and `truncatePrice()` extracted to `lib/precision.ts` as pure functions. Applied at signal-handler level (before storing) AND adapter boundary (safety net, idempotent).
- `getSzDecimals(coin)` exposed on `HlClient` interface — `HyperliquidClient` returns from cache, `DryRunHlClient` returns 5.
- `loadSzDecimals(coin)` must be called before any order placement (daemon does this at startup, skipped in dry-run).
- `hyperliquid` npm SDK: marketOpen is on `sdk.custom` not `sdk.exchange`.
- `updateLeverage(symbol, leverageMode, leverage)` — symbol is first arg, mode is string "cross"|"isolated".
- `getClearinghouseState(walletAddress)` is on `sdk.info.perpetuals`, not `sdk.info`.
- Must build @breaker/backtest before running exchange tests (workspace dep resolution).
- `env.ts` uses lazy `loadEnv(mode)` — loads `.env.testnet` or `.env.mainnet` based on config mode.

## Non-obvious decisions
- Risk engine has hardcoded $100k absolute notional cap + 5% price deviation check — independent of config guardrails.
- `maxTradesPerDay: 0` acts as kill switch (Zod `.nonnegative()`); `tradesToday >= 0` always blocks.
- POST endpoints have rate limiting (10 req/min via express-rate-limit). POST /close-position has closingInProgress guard (409 on concurrent close for same coin). Quick-signal uses randomUUID() for alertId (not Date.now()).
- Config (mode, guardrails, sizing, dryRun, logLevels) lives in exchange-config.json, NOT in .env (monorepo rule: .env is secrets only).
- Two env files: `.env.testnet` and `.env.mainnet` — loaded based on `config.mode`. Skipped in dry-run mode.
- Paper mode eliminated: testnet is the dev mode, live is production. Dry-run is for logging without executing.
- PositionBook is in-memory — ReconcileLoop auto-corrects: hydrates from HL on startup, auto-closes stale local positions, syncs order statuses via resolveOrderStatus().
- Hydrated positions use signalId=-1 as sentinel (not from a daemon signal).
- leverageCache in HyperliquidClient — updateLeverage called once per coin per daemon session.
- HyperliquidClient constructor takes `sdk: Hyperliquid` (DI), not raw keys. Daemon creates SDK once, injects to both HlClient and HlEventStream.
- `syncPositionsAndBroadcast()` is a top-level function in daemon.ts with explicit deps (not a closure).
- StrategyRunner.tick() decomposed into checkExit() + checkEntry() + buildHigherTimeframes() + trackTrailingExit().
- **Warmup validation**: warmup() throws if received candles < 50% of requested (prevents silent indicator errors from insufficient data).
- **Candle staleness**: StrategyRunner tracks consecutiveEmptyPolls; fires `onStaleData` callback + log.warn at 5 empty polls (fire-once). daemon.ts sends WhatsApp alert. Health endpoint (`GET /health`) reports `status: "stale"` when lastCandleAt > 5× interval.
- `createChildLogger(module)` reads from mutable config ref set via `setLogConfig()` at daemon startup.
