# CLAUDE Instructions — exchange

## Project overview
Autonomous trading daemon that loads strategies from @breaker/backtest, polls candles, and executes orders on Hyperliquid. Includes risk engine, position tracking, SQLite persistence, and WhatsApp notifications.

## Project structure
```
src/
├── domain/              # Pure business logic (zero I/O)
│   ├── check-risk.ts    # Guardrails: max-notional, leverage, positions, daily-loss, trades/day
│   ├── signal-to-intent.ts  # Signal → OrderIntent conversion with sizing + entryType (ioc/gtc)
│   ├── position-book.ts # In-memory position state, price updates, PnL
│   ├── pending-entry-book.ts # In-memory Map<coin, PendingEntry> for resting GTC/ALO orders
│   ├── recover-sl-tp.ts # Recover SL/TP from HL open orders (both are trigger orders)
│   ├── orchestrator.ts   # Centralized daily PnL, signal deconfliction, force close gate
│   └── order-status.ts  # HL → internal order status mapping
├── adapters/            # External I/O (injectable, mockable)
│   ├── hyperliquid-client.ts  # SDK wrapper (HyperliquidClient class)
│   ├── dry-run-client.ts      # DryRunHlClient (logs actions, no SDK)
│   ├── candle-streamer.ts     # WS-based candle streaming (primary)
│   ├── candle-poller.ts       # REST-based candle polling (legacy)
│   ├── alerts-client.ts       # HttpAlertsClient (WhatsApp via @breaker/alerts)
│   ├── format-alert-message.ts # formatOpenMessage, formatTrailingSlMessage
│   ├── hl-event-stream.ts     # HlEventStream (WS order/fill subscriptions)
│   ├── sqlite-store.ts        # SQLite: signals, orders, fills, equity_snapshots
│   └── event-log.ts           # NDJSON append-only audit trail
├── application/         # Orchestration
│   ├── handle-signal.ts       # Signal → risk check → execute → persist → notify (IOC/GTC bifurcation)
│   ├── place-protection-orders.ts # Extracted SL/TP placement (shared by IOC and GTC flows)
│   ├── process-pending-fill.ts    # GTC fill handler: pending book → protection orders → position open
│   ├── strategy-runner.ts     # Event-driven candle processing + strategy.onCandle/shouldExit + GTC expiry
│   ├── diagnose-signal.ts     # Per-strategy condition diagnostics for noSignal debug logs
│   ├── fetch-candles-for-replay.ts # Candle fetching (cache or streamer) for replay endpoints
│   ├── reconcile-loop.ts      # Periodic position sync (local vs Hyperliquid)
│   ├── reconcile.ts           # Pure reconcile() function
│   ├── resolve-historical-statuses.ts # Batch historical + fallback for trigger orders
│   └── replay-strategy.ts     # Replay strategy on historical candles
├── lib/
│   ├── load-env.ts      # Zod + parseEnv (HL_ACCOUNT_ADDRESS, HL_PRIVATE_KEY)
│   ├── logger.ts        # pino + pino-roll (single `logger` export with .createChild/.setLogConfig)
│   └── ws-broker.ts     # WebSocket event broadcast
│   # Guards & truncators extracted to @breaker/kit:
│   # finiteOr, finiteOrThrow, assertPositive, isSane*, truncateSize, truncatePrice
├── types/
│   ├── config.ts        # ExchangeConfig Zod schema
│   ├── events.ts        # Event types for NDJSON log
│   ├── hl-client.ts     # HlClient interface + related types (HlPosition, HlOrder*, etc.)
│   ├── hl-event-stream.ts # WsOrder, WsUserFill, HlEventStreamCallbacks
│   └── alerts-client.ts # AlertsClient interface
├── create-app.ts        # Express: POST /signal, GET /health|positions|orders|equity|config
├── daemon.ts            # Entry: bootstrap strategy-runner + server + reconcile
└── index.ts             # Public exports
```

## Configuration
- `exchange-config.json` — mode, asset, strategy, guardrails, sizing, dryRun, logLevels (NOT .env)
- `.env` — secrets only: `HL_ACCOUNT_ADDRESS`, `HL_PRIVATE_KEY`

## Key patterns
- HlClient interface (types/hl-client.ts) allows full mocking in tests (no real SDK needed)
- DryRunHlClient implements HlClient for dry-run mode (logs actions, returns fakes)
- buildContext/canTrade extracted to @breaker/backtest engine-shared.ts for live=backtest equivalence
- Daily loss limit uses R-multiples (`maxDailyLossR × riskPerTradeUsd`), NOT fixed USD — scales automatically with risk sizing
- `maxTradesPerDay` is a global cross-coin limit (uses `getTodayGlobalTradeCount()`), NOT per-coin
- Idempotency via UNIQUE alert_id in SQLite signals table
- Signal outcome tracking: `signals.outcome` (`executed|blocked|rejected|no_fill|resting|error`) + `signals.outcome_reason` — every code path in handleSignal and strategy-runner records the final disposition
- Strategy runner always runs `strategy.onCandle()` even when gates block — records blocked signals with `outcome: "blocked"` for diagnostics (alert_id prefix `runner-gate-`)
- leverageCache: updateLeverage called once per coin per daemon session
- `logger.createChild(module)` for per-module log levels (set via `logger.setLogConfig()`)
- `resolveOrderStatus()` centralizes HL→internal status mapping
- One export per file: file name matches primary export in kebab-case
- Candle WS broadcast is registered once per coin in daemon.ts (not per runner) to prevent duplicate events when a coin has multiple strategies
- `/candles` endpoint: without `?interval=` returns live in-memory data from CandleStreamer; with `?interval=` (validated against CandleInterval) uses CandleCache for alternate timeframes; `/strategy-signals` uses CandleCache for replay
- `POST /auto-trading` toggle persists to `exchange-config.json` via `persistConfig()` callback — survives daemon restarts
- When `autoTradingEnabled: false` blocks a strategy-runner signal, an `auto_trading_blocked` event is appended to the NDJSON event log for diagnostics
- `/quick-signal` delegates SL/TP computation to `strategy.computeLevels(ctx, direction)` via `runner.generateManualSignal()` — produces levels for any direction without checking entry conditions. Falls back to ATR-based SL (no TPs) when strategy lacks `computeLevels` or no runner found
- `StrategyRunner.getStrategyName()` returns the config identifier (e.g. "keltner-rsi2"), NOT the strategy's display name (e.g. "BTC 15m Mean Reversion — Keltner RSI2")

## Orchestrator (domain/orchestrator.ts)
- Pure domain object (zero I/O, synchronous except `proposeSignal` Promise)
- `canSignal()` is the central gate: daily loss >= 2R → block all; trades/day >= max → block
- `proposeSignal()` buffers signals for 50ms to deconflict same-bar, same-coin signals: same direction → highest priority wins; opposite direction → both rejected
- Module types and priority: breakout(4) > pullback(3) > mean-reversion(2) > trend-following(1)
- Heartbeat in daemon.ts (30s interval) evaluates `shouldForceClose()` to force close positions between candle closes
- Gate 6: Squeeze — `reportSqueeze(coin, active, barTs)` fed by StrategyRunner (computes BB(20,2)/KC(20,20,1.5)/detectSqueeze(4) on each candle close), GLOBAL gate (any coin squeezed → all entries blocked), dedup by barTs per coin, day reset does NOT clear squeeze state, logs `squeeze_detected`/`squeeze_released` transitions
- Decision callback persists every decision to EventLog NDJSON (type: `orchestrator_*`)
- Orchestrator is **optional** in `StrategyRunnerDeps` → existing tests don't break
- `seedDailyPnl(pnl)` initializes orchestrator from SQLite on daemon startup — prevents stale dailyPnl after restarts
- `handleSignal` sanity-checks `dailyLossOverride` against SQL: if divergence > 2× maxDailyLoss, falls back to DB value (prevents phantom blocks from corrupted in-memory state)

## GTC/ALO Maker Entries (PendingEntryBook)
- Strategies with `entryPrice !== null` (M1 Donchian, M2 Keltner) use GTC ALO (post-only) limit orders instead of IOC
- ALO = Add Liquidity Only (`{ limit: { tif: "Alo" } }`): rejected if it would cross spread, guarantees maker fee (0.015% vs 0.045% taker)
- `PendingEntryBook`: in-memory Map<coin, PendingEntry> tracking resting GTC orders awaiting fill
- Three fill detection paths: (a) WS onFill real-time via `processPendingFill`, (b) reconcile-loop fallback (HL position exists but no local position), (c) strategy-runner timeout (2 bars expiry)
- `handle-signal.ts` bifurcates: `entryType === "ioc"` → immediate IOC flow, `entryType === "gtc"` → ALO placement → resting or immediate fill
- `place-protection-orders.ts`: extracted SL/TP logic shared by both IOC and GTC flows
- Guard: `pendingEntryBook.has(coin)` blocks new signals while a GTC order is resting
- Daily PnL is centralized: all runners report via `recordClose()`, any runner reads via `getDailyPnl()`
- `moduleType` field in CoinStrategySchema (optional) overrides the fallback map in daemon.ts

## Funding rate tracking
- HL `getClearinghouseState()` (already called by reconcile loop) returns `cumFunding.sinceOpen` — cumulative USDC funding since position open (negative=paid, positive=received). Zero extra API calls needed
- `PositionBook.updateFunding(coin, cumFunding)` receives absolute cumulative value (not delta) — auto-corrective after daemon restart
- On position close: `totalPnl = unrealizedPnl + cumulativeFunding` — affects dailyPnl, orchestrator.recordClose
- SQLite: `signals.funding_paid` (per-signal), `equity_snapshots.cumulative_funding` (portfolio-wide). Additive migrations with `DEFAULT 0`
- Position history PnL: `realizedPnl = exitValue - entryValue - totalFees + fundingPaid` (fundingPaid is signed)
- Stale funding on close: last value is from previous reconcile (~30-60s). Max error ~$0.01 per $1000 notional. Acceptable

## Known pitfalls
- Must build `@breaker/backtest` before running exchange tests (workspace dependency)
- PositionBook is in-memory — ReconcileLoop auto-corrects via hydration/auto-close/order sync
- ReconcileLoop `onAutoClose` callback records PnL (`unrealizedPnl + cumulativeFunding`) in orchestrator on liquidation/external close — without this, daily loss gate stays stale after liquidation
- HL position data does NOT include SL/TP — `recoverSlTp()` extracts them from open orders (trigger→SL, trigger tpsl→TP)
- Dual SL architecture: fixed SL (never moves) + trailing SL (moves favorably). Both `reduceOnly` trigger orders on HL. If daemon crashes, trailing SL order lives on the exchange. `recoverSlTp(direction)` discriminates fixed vs trailing by price ordering
- Trailing SL placement uses place-first/cancel-after pattern — guarantees continuous coverage even if cancel fails (briefly 3 orders, all reduceOnly)
- Trailing SL breakeven guard: trailing SL is only placed on the exchange when the level is at or beyond breakeven (≥ entryPrice for long, ≤ entryPrice for short). Without this, the trailing SL can be hit before the fixed SL, causing a guaranteed loss
- Trailing SL direction: `isBuy` must be the OPPOSITE of position direction (long→isBuy=false=sell, short→isBuy=true=buy) since trailing SL closes the position
- HlEventStream hooks into SDK `ws.on('reconnect'|'close'|'maxReconnectAttemptsReached')` — fills during disconnect window are lost (isSnapshot guard skips them), so `onReconnected` triggers REST-based position sync
- `handle-signal` fetches fresh mid-price from HL before placing IOC entry — stale candle close in fast markets causes limit misses. Falls back to candle close on failure
- Signal handler has SL failure rollback (compensating transaction) and entry order error handling (`entry_order_error` event with full context)
- Strategy indicator caches (EMA, RSI, ATR, etc.) are pre-computed by `init()` — the runner re-calls `init()` on every candle close to extend caches for new candles; without this, `onCandle()` reads undefined values beyond the warmup range
- StrategyRunner auto-corrects `warmupBars` at startup via `computeMinWarmupBars()` — if config value is below strategy's `requiredWarmup`, the runner uses the computed minimum and logs a warning
- HL `getHistoricalOrders` does NOT include trigger orders (SL/TP) — `resolveHistoricalStatuses()` adds parallel fallback via `getOrderStatus(oid)` for missing OIDs
- SDK `getMeta()` applies `symbolConversion` by default (e.g. "SOL" → "SOL-PERP") — `loadSzDecimals()` normalizes via `fromSymbol()` so cache keys match domain naming. Without this, `getSzDecimals()` returns 5 (fallback) → wrong truncation → exchange rejects orders

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — 478 tests across 24 files
- `pnpm start` — run daemon (requires HL credentials in .env)

## Integration points
- **@breaker/backtest**: Strategy, Signal, fetchCandles, buildContext, canTrade
- **@breaker/backtest/deployed**: Strategy factories (createDonchianAdx, etc.) — daemon uses frozen copies, NOT live source
- **@breaker/alerts**: WhatsApp via gatewayUrl/send
- **Hyperliquid**: SDK `hyperliquid` npm (testnet/mainnet)
