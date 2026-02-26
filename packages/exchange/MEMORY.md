# MEMORY — exchange

## Current state
- Fully implemented autonomous trading daemon with strategy runner, risk engine, and Hyperliquid execution.
- 12 test files, 73 tests passing. Build clean.
- Architecture: domain (pure logic) / adapters (I/O) / application (orchestration) / server + daemon.
- SQLite for persistence (signals, orders, fills, equity), NDJSON for audit trail.
- Reuses Strategy, Signal, Candle, fetchCandles from @breaker/backtest.
- Shared buildContext/canTrade from backtest engine-shared.ts ensures semantic equivalence.

## Pending items
- Testnet validation: run with real Hyperliquid testnet credentials.
- Strategy exit flow via shouldExit needs live testing (currently closes via market order).
- Equity snapshot recording not wired into strategy-runner loop yet (only via API inserts).
- WhatsApp notifications only on position open (extend to SL hit, TP hit, errors).

## Known pitfalls
- `hyperliquid` npm SDK: marketOpen is on `sdk.custom` not `sdk.exchange`.
- `updateLeverage(symbol, leverageMode, leverage)` — symbol is first arg, mode is string "cross"|"isolated".
- `getClearinghouseState(walletAddress)` is on `sdk.info.perpetuals`, not `sdk.info`.
- Must build @breaker/backtest before running exchange tests (workspace dep resolution).

## Non-obvious decisions
- Config (mode, guardrails, sizing) lives in exchange-config.json, NOT in .env (monorepo rule: .env is secrets only).
- Paper mode eliminated: testnet is the dev mode, live is production. Adapters mockable for CI tests.
- PositionBook is in-memory only — reconcile-loop detects drift but doesn't auto-correct.
- leverageCache in HyperliquidClient — updateLeverage called once per coin per daemon session.
