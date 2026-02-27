# MEMORY — exchange

## Current state
- Fully implemented autonomous trading daemon with strategy runner, risk engine, and Hyperliquid execution.
- 15 test files, 138 tests passing. Build clean.
- Architecture: domain (pure logic) / adapters (I/O) / application (orchestration) / server + daemon.
- SQLite for persistence (signals, orders, fills, equity), NDJSON for audit trail.
- Reuses Strategy, Signal, Candle, fetchCandles from @breaker/backtest.
- Shared buildContext/canTrade from backtest engine-shared.ts ensures semantic equivalence.
- **Testnet validated**: daemon starts, connects to HL testnet, warmup + polling + signal execution work.
- **Event-driven sync**: HlEventStream subscribes to HL WebSocket for order updates + user fills. Reconcile loop is now safety net at 5min interval.

## Pending items
- Testnet+mainnet wallet: 0xf6e7...D03b (testnet has ~996 USDC, mainnet ~520 USDC).
- Verify fill confirmation: daemon assumes order is filled after placeMarketOrder returns oid, but IOC orders may be cancelled by exchange (no margin). Need post-order userFills check.
- Equity snapshots recorded every reconcile tick (5min) via ReconcileLoop.check().
- WhatsApp notifications only on position open (extend to SL hit, TP hit, errors).

## Known pitfalls
- SDK expects `BTC-PERP` format, NOT plain `BTC` — `toSymbol()` in HyperliquidClient handles this.
- SDK `floatToWire` rejects sizes with too many decimals — `truncateSize()` truncates to szDecimals (fetched from meta).
- `loadSzDecimals(coin)` must be called before any order placement (daemon does this at startup).
- `hyperliquid` npm SDK: marketOpen is on `sdk.custom` not `sdk.exchange`.
- `updateLeverage(symbol, leverageMode, leverage)` — symbol is first arg, mode is string "cross"|"isolated".
- `getClearinghouseState(walletAddress)` is on `sdk.info.perpetuals`, not `sdk.info`.
- Must build @breaker/backtest before running exchange tests (workspace dep resolution).
- `env.ts` uses lazy `loadEnv(mode)` — loads `.env.testnet` or `.env.mainnet` based on config mode.

## Non-obvious decisions
- Config (mode, guardrails, sizing) lives in exchange-config.json, NOT in .env (monorepo rule: .env is secrets only).
- Two env files: `.env.testnet` and `.env.mainnet` — loaded based on `config.mode`.
- Paper mode eliminated: testnet is the dev mode, live is production. Adapters mockable for CI tests.
- PositionBook is in-memory — ReconcileLoop auto-corrects: hydrates from HL on startup, auto-closes stale local positions, syncs order statuses (pending→filled/cancelled/rejected) via HL open+historical orders API.
- Hydrated positions use signalId=-1 as sentinel (not from a daemon signal).
- leverageCache in HyperliquidClient — updateLeverage called once per coin per daemon session.
- HyperliquidClient constructor takes `sdk: Hyperliquid` (DI), not raw keys. Daemon creates SDK once, injects to both HlClient and HlEventStream.
- HlEventStream: pure adapter for `sdk.subscriptions.subscribeToOrderUpdates` + `subscribeToUserFills`. Callbacks handled in daemon.
- WsBroker (ws-broker.ts) attaches to same HTTP server on /ws path; broadcasts state on reconcile + signal + WS events.
- ReconcileLoop has `onReconciled` callback; SignalHandlerDeps has `onSignalProcessed` — both optional, won't break tests.
- GET /open-orders endpoint requires `walletAddress` in ServerDeps (added alongside hlClient).
- ServerDeps includes `candlePoller` — provides GET /candles and GET /signals endpoints.
- StrategyRunner has `onNewCandle` callback — daemon uses it to broadcast new candles via WsBroker.
- WS snapshot includes `candles` and `signals` for initial client hydration.
