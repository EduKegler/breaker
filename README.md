# Trading Monorepo

Automated crypto trading pipeline — from strategy backtesting and optimization to live execution and notifications.

## Packages

| Package | Description |
|---------|-------------|
| [`@breaker/backtest`](packages/backtest/) | Local backtesting engine — candle fetch, indicators, trade simulation, analysis |
| [`@breaker/refiner`](packages/refiner/) | B.R.E.A.K.E.R. — automated strategy optimization loop powered by Claude |
| [`@breaker/exchange`](packages/exchange/) | Hyperliquid order execution and position management |
| [`@breaker/router`](packages/router/) | TradingView alert receiver, deduplication, and forwarding |
| [`@breaker/alerts`](packages/alerts/) | WhatsApp messaging via Evolution API |

## Architecture

```
TradingView Alerts ──▶ router ──▶ alerts ──▶ WhatsApp
                                    ▲
                                    │
backtest ◀── refiner (optimization) │
                                    │
              exchange ─────────────┘
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
pnpm --filter @breaker/refiner build

# Test a single package
pnpm --filter @breaker/backtest test

# Run with coverage
pnpm --filter @breaker/refiner test:coverage
```
