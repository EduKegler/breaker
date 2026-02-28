# B.R.E.A.K.E.R.

**Backtesting & Refinement Engine for Automated Knowledge-driven Execution & Routing**

End-to-end automated crypto trading pipeline — from strategy backtesting and optimization to live execution and WhatsApp notifications.

## Architecture

```
                    TradingView
                        |
                   [webhook POST]
                        |
                        v
                 +-------------+        +------------+        +-----------+
                 |   Router    | -----> |   Alerts   | -----> | WhatsApp  |
                 | (validate,  |        | (Evolution |        |           |
                 |  dedup,     |        |    API)    |        |           |
                 |  format)    |        +------------+        +-----------+
                 +-------------+              ^
                                              |
  +-----------+      +------------+           |
  |  Backtest | <--> |  Refiner   |           |
  | (engine,  |      | (AI-driven |           |
  |  candles, |      | optimization           |
  |  indicat.)|      |  loop)     |           |
  +-----------+      +------------+           |
                                              |
                     +------------+           |
                     |  Exchange  | ----------+
                     | (Hyperliquid
                     |  execution)|
                     +------------+
```

## Packages

The name B.R.E.A.K.E.R. is an acrostic of the packages:

| Letter | Package | Description | Status |
|:------:|---------|-------------|:------:|
| **B** | [`@breaker/backtest`](packages/backtest/) | Local backtesting engine — candles, indicators, trade simulation | Active |
| **R** | [`@breaker/refiner`](packages/refiner/) | AI-driven strategy optimization loop with Claude | Active |
| **E** | [`@breaker/exchange`](packages/exchange/) | Order execution and position management on Hyperliquid | Stub |
| **A** | [`@breaker/alerts`](packages/alerts/) | WhatsApp messaging via Evolution API | Active |
| **K** | [`@breaker/kit`](packages/kit/) | Shared utilities — isMainModule, parseEnv, formatZodErrors | Active |
| **E** | [`@breaker/explorer`](packages/explorer/) | Local analysis dashboard and visualization | Stub |
| **R** | [`@breaker/router`](packages/router/) | TradingView alert receiver with dedup and forwarding | Active |

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

### Per-package commands

```bash
# Build a single package
pnpm --filter @breaker/refiner build

# Test a single package
pnpm --filter @breaker/backtest test

# Run with coverage
pnpm --filter @breaker/refiner test:coverage
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, ES2022, NodeNext) |
| Package manager | pnpm (workspaces) |
| Testing | Vitest |
| Validation | Zod |
| Candle cache | SQLite (better-sqlite3) |
| HTTP | Express |
| Logging | pino + pino-http |
| Deploy | Docker + Caddy |
| AI | Claude API (strategy optimization) |

## Repository Structure

```
trading/
├── packages/
│   ├── backtest/        # B — backtesting engine
│   ├── refiner/         # R — automated optimization
│   ├── exchange/        # E — Hyperliquid execution (stub)
│   ├── alerts/          # A — WhatsApp gateway
│   ├── kit/             # K — shared utilities
│   ├── explorer/        # E — analysis dashboard (stub)
│   └── router/          # R — webhook receiver
├── package.json         # root (private, workspaces)
├── pnpm-workspace.yaml  # declares packages/*
├── tsconfig.base.json   # shared TypeScript config
├── AGENTS.md            # AI agent instructions
└── CLAUDE.md            # references AGENTS.md
```
