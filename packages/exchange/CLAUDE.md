# CLAUDE Instructions — exchange

## Project overview
Autonomous trading daemon that loads strategies from @breaker/backtest, polls candles, and executes orders on Hyperliquid. Includes risk engine, position tracking, SQLite persistence, and WhatsApp notifications.

## Project structure
```
src/
├── domain/              # Pure business logic (zero I/O)
│   ├── check-risk.ts    # Guardrails: max-notional, leverage, positions, daily-loss, trades/day
│   ├── signal-to-intent.ts  # Signal → OrderIntent conversion with sizing
│   ├── position-book.ts # In-memory position state, price updates, PnL
│   ├── recover-sl-tp.ts # Recover SL/TP from HL open orders (trigger→SL, limit→TP)
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
│   ├── handle-signal.ts       # Signal → risk check → execute → persist → notify
│   ├── strategy-runner.ts     # Event-driven candle processing + strategy.onCandle/shouldExit
│   ├── reconcile-loop.ts      # Periodic position sync (local vs Hyperliquid)
│   ├── reconcile.ts           # Pure reconcile() function
│   └── replay-strategy.ts     # Replay strategy on historical candles
├── lib/
│   ├── load-env.ts      # Zod + parseEnv (HL_ACCOUNT_ADDRESS, HL_PRIVATE_KEY)
│   ├── logger.ts        # pino + pino-roll (single `logger` export with .createChild/.setLogConfig)
│   ├── truncate-size.ts # truncateSize (exchange precision)
│   ├── truncate-price.ts # truncatePrice (5 sig figs)
│   ├── finite-or-throw.ts # Guard: throws on NaN/Infinity
│   ├── finite-or.ts     # Guard: fallback on NaN/Infinity
│   ├── assert-positive.ts # Guard: throws on non-positive
│   ├── is-sane-price.ts # Safety range check for prices
│   ├── is-sane-size.ts  # Safety range check for sizes
│   ├── is-sane-equity.ts # Safety range check for equity
│   └── ws-broker.ts     # WebSocket event broadcast
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
- Idempotency via UNIQUE alert_id in SQLite signals table
- leverageCache: updateLeverage called once per coin per daemon session
- `logger.createChild(module)` for per-module log levels (set via `logger.setLogConfig()`)
- `resolveOrderStatus()` centralizes HL→internal status mapping
- One export per file: file name matches primary export in kebab-case

## Known pitfalls
- Must build `@breaker/backtest` before running exchange tests (workspace dependency)
- PositionBook is in-memory — ReconcileLoop auto-corrects via hydration/auto-close/order sync
- HL position data does NOT include SL/TP — `recoverSlTp()` extracts them from open orders (trigger→SL, limit reduceOnly→TP)
- Signal handler has SL failure rollback (compensating transaction)

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — 312 tests across 21 files
- `pnpm start` — run daemon (requires HL credentials in .env)

## Integration points
- **@breaker/backtest**: Strategy, Signal, fetchCandles, buildContext, canTrade
- **@breaker/alerts**: WhatsApp via gatewayUrl/send
- **Hyperliquid**: SDK `hyperliquid` npm (testnet/mainnet)
