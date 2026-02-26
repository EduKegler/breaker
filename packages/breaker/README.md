# @trading/breaker

B.R.E.A.K.E.R. — Backtesting Runtime for Evolutionary Analysis, Kernel Execution & Refinement.

Automated strategy optimization loop that uses Claude to iteratively improve trading strategy parameters and code, backed by the `@trading/backtest` engine.

## How It Works

```
1. Load config + sync candles (once)
2. For each iteration:
   a. Run backtest (in-process or child process)
   b. Score results (multi-objective: PF, avgR, WR, DD, complexity, sample)
   c. Checkpoint if improved / rollback if regressed
   d. Claude suggests parameter changes or code edits
   e. Apply changes, check guardrails
   f. Stop if all criteria met
3. Restore best checkpoint, emit summary
```

## Execution Modes

| Phase | What Claude changes | Execution | Speed |
|-------|-------------------|-----------|-------|
| **refine** | Param values only (JSON) | In-process `runBacktest()` | ~2s |
| **restructure** | Strategy `.ts` source code | `pnpm build` + child process | ~5s |

Phases escalate automatically: refine → research → restructure.

## Usage

```bash
# Build
pnpm build

# Run optimization (2 iterations)
node dist/loop/orchestrator.js --asset=BTC --strategy=breakout --max-iter=2

# With options
node dist/loop/orchestrator.js \
  --asset=BTC \
  --strategy=breakout \
  --max-iter=20 \
  --phase=refine

# Dashboard
pnpm dashboard
pnpm dashboard:open   # generates + opens HTML
```

## Configuration

All config lives in `breaker-config.json`:

```json
{
  "criteria": { "minTrades": 150, "minPF": 1.25, "maxDD": 12 },
  "assetClasses": { "crypto-major": { "minPF": 1.25 } },
  "assets": {
    "BTC": {
      "class": "crypto-major",
      "strategies": {
        "breakout": {
          "coin": "BTC",
          "dataSource": "coinbase-perp",
          "interval": "15m",
          "strategyFactory": "createDonchianAdx",
          "dateRange": { "start": "2025-05-24", "end": "2026-02-24" }
        }
      }
    }
  }
}
```

## Structure

```
src/
├── automation/   — Prompt builders for Claude (optimize, fix)
├── dashboard/    — Performance dashboard + anomaly detection
├── lib/          — Config, lock, strategy registry, candle loader
├── loop/         — Orchestrator + stages
│   └── stages/   — run-engine, scoring, checkpoint, optimize, guardrails, etc.
└── types/        — Zod config schemas
```

## Commands

```bash
pnpm build          # Compile TypeScript
pnpm test           # Run all tests (377 tests)
pnpm typecheck      # Type-check without emitting
pnpm test:coverage  # Run with coverage report
```
