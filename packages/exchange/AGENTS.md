# AGENTS Instructions — exchange

## Project overview
Autonomous trading daemon that loads strategies from @breaker/backtest, polls candles, and executes orders on Hyperliquid. Includes risk engine, position tracking, SQLite persistence, and WhatsApp notifications.

## Project structure
```
src/
├── domain/              # Pure business logic (zero I/O)
│   ├── risk-engine.ts   # Guardrails: max-notional, leverage, positions, daily-loss, trades/day
│   ├── order-intent.ts  # Signal → OrderIntent conversion with sizing
│   └── position-book.ts # In-memory position state, price updates, PnL
├── adapters/            # External I/O (injectable, mockable)
│   ├── hyperliquid-client.ts  # SDK wrapper (custom.marketOpen, exchange.placeOrder, etc.)
│   ├── candle-poller.ts       # Polls candles via @breaker/backtest fetchCandles
│   ├── alerts-client.ts       # POST /send to @breaker/alerts (WhatsApp)
│   ├── sqlite-store.ts        # SQLite: signals, orders, fills, equity_snapshots
│   └── event-log.ts           # NDJSON append-only audit trail
├── application/         # Orchestration
│   ├── signal-handler.ts      # Signal → risk check → execute → persist → notify
│   ├── strategy-runner.ts     # Candle polling loop + strategy.onCandle/shouldExit
│   └── reconcile-loop.ts      # Periodic position sync (local vs Hyperliquid)
├── lib/
│   ├── env.ts           # Zod + parseEnv (HL_ACCOUNT_ADDRESS, HL_PRIVATE_KEY)
│   └── logger.ts        # pino + pino-roll (same pattern as router)
├── types/
│   ├── config.ts        # ExchangeConfig Zod schema
│   └── events.ts        # Event types for NDJSON log
├── server.ts            # Express: POST /signal, GET /health|positions|orders|equity|config
├── daemon.ts            # Entry: bootstrap strategy-runner + server + reconcile
└── index.ts             # Public exports
```

## Configuration
- `exchange-config.json` — mode, asset, strategy, guardrails, sizing (NOT .env)
- `.env` — secrets only: `HL_ACCOUNT_ADDRESS`, `HL_PRIVATE_KEY`

## Key patterns
- HlClient interface allows full mocking in tests (no real SDK needed)
- buildContext/canTrade extracted to @breaker/backtest engine-shared.ts for live=backtest equivalence
- Idempotency via UNIQUE alert_id in SQLite signals table
- leverageCache: updateLeverage called once per coin per daemon session

## Build and test
- `pnpm build` — compile TypeScript
- `pnpm test` — 138 tests across 15 files
- `pnpm start` — run daemon (requires HL credentials in .env)

## Integration points
- **@breaker/backtest**: Strategy, Signal, fetchCandles, buildContext, canTrade
- **@breaker/alerts**: WhatsApp via gatewayUrl/send
- **Hyperliquid**: SDK `hyperliquid` npm (testnet/mainnet)
