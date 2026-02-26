# Trading Monorepo

Automated crypto trading pipeline — from strategy backtesting and optimization to live execution and notifications.

## Packages

| Package | Description |
|---------|-------------|
| [`@trading/backtest`](packages/backtest/) | Local backtesting engine — candle fetch, indicators, trade simulation, analysis |
| [`@trading/breaker`](packages/breaker/) | B.R.E.A.K.E.R. — automated strategy optimization loop powered by Claude |
| [`@trading/hl-broker`](packages/hl-broker/) | Hyperliquid order execution and position management |
| [`@trading/webhook`](packages/webhook/) | TradingView alert receiver, deduplication, and forwarding |
| [`@trading/whatsapp-gateway`](packages/whatsapp-gateway/) | WhatsApp messaging via Evolution API |

## Architecture

```
TradingView Alerts ──▶ webhook ──▶ whatsapp-gateway ──▶ WhatsApp
                                        ▲
                                        │
backtest ◀── breaker (optimization)     │
                                        │
              hl-broker ────────────────┘
              (Hyperliquid execution + notifications)
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Type-check all packages
pnpm typecheck
```

## Tech Stack

- **TypeScript** (strict, ES2022, NodeNext modules)
- **pnpm** workspaces
- **Vitest** for testing
- **Zod** for runtime validation
- **SQLite** (better-sqlite3) for candle caching
- **Express** for HTTP services

## Per-Package Commands

```bash
# Build a single package
pnpm --filter @trading/breaker build

# Test a single package
pnpm --filter @trading/backtest test

# Run with coverage
pnpm --filter @trading/breaker test:coverage
```
