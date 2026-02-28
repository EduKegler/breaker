# MEMORY — exchange

## Current state
- Fully implemented autonomous trading daemon with strategy runner, risk engine, and Hyperliquid execution.
- 20 test files, 295 tests passing. Build clean.
- Architecture: domain (pure logic) / adapters (I/O) / application (orchestration) / create-app + daemon.
- SQLite for persistence (signals, orders, fills, equity), NDJSON for audit trail.
- Reuses Strategy, Signal, Candle, fetchCandles, streamCandles from @breaker/backtest.
- **One-export-per-file refactoring applied**: types extracted to `types/` (hl-client.ts, hl-event-stream.ts, alerts-client.ts), validators/precision split into individual files, logger consolidated into single `logger` export, format functions extracted to format-alert-message.ts, reconcile() extracted to reconcile.ts. File renames: order-intent→signal-to-intent, risk-engine→check-risk, strategy-replay→replay-strategy, signal-handler→handle-signal, server→create-app, env→load-env.
- **Real-time streaming**: CandleStreamer uses CCXT pro WS with reconnect backoff. StrategyRunner is event-driven.
- **Event-driven sync**: HlEventStream subscribes to HL WebSocket for order updates + user fills. Reconcile loop is safety net at 5min interval.
- **Structured logging**: `logger.createChild(module)` with per-module log levels. `logger.setLogConfig()` at daemon startup.
- **Dry-run mode**: `dryRun: true` in config uses `DryRunHlClient`.
- **Auto-trading kill switch**: `autoTradingEnabled` in config (runtime-mutable via `POST /auto-trading`).

## Pending items
- Testnet+mainnet wallet: 0xf6e7...D03b (testnet has ~996 USDC, mainnet ~520 USDC).
- WhatsApp notifications: extend to SL hit, TP hit.
- Signal handler has SL failure rollback (compensating transaction).

## Known pitfalls
- **Input validation**: split into individual files in `lib/` (finite-or-throw, finite-or, is-sane-price, is-sane-size, is-sane-equity, assert-positive). Applied in adapters at data boundaries.
- SDK expects `BTC-PERP` format — `toSymbol()` converts input, `fromSymbol()` normalizes output. Domain layer only sees plain coin names (e.g. `"BTC"`).
- SDK `floatToWire` rejects bad sizes/prices — `truncateSize()` (lib/truncate-size.ts) and `truncatePrice()` (lib/truncate-price.ts) applied at handle-signal level AND adapter boundary.
- `loadSzDecimals(coin)` must be called before any order placement (daemon does this at startup).
- `load-env.ts` uses lazy `loadEnv(mode)` — loads `.env.testnet` or `.env.mainnet` based on config mode.
- Must build @breaker/backtest before running exchange tests (workspace dep resolution).

## Non-obvious decisions
- Risk engine (domain/check-risk.ts) has hardcoded $100k absolute notional cap + 5% price deviation check.
- Logger exports a single `logger` object with `.createChild()` and `.setLogConfig()` methods (pino instance + extensions).
- Types shared across adapters/domain live in `types/` dir (hl-client.ts, hl-event-stream.ts, alerts-client.ts).
- `reconcile()` pure function extracted to `application/reconcile.ts`, used by ReconcileLoop.
- Config lives in exchange-config.json, NOT .env (monorepo rule: .env is secrets only).
- PositionBook is in-memory — ReconcileLoop auto-corrects via hydration/auto-close/order sync.
- HyperliquidClient constructor takes `sdk: Hyperliquid` (DI). leverageCache: updateLeverage once per coin per session.
