# AGENTS Instructions — breaker

## Project overview
B.R.E.A.K.E.R. — Backtesting Runtime for Evolutionary Analysis, Kernel Execution & Refinement. Automated strategy optimization using in-process `@trading/backtest` engine (no Playwright, no TradingView, no Pine Script).

## Project structure
- `src/automation/` — Prompt builders for Claude optimization/fix (`build-optimize-prompt-ts.ts`, `build-fix-prompt-ts.ts`)
- `src/dashboard/` — Dashboard and anomaly detection
- `src/lib/` — Config, lock, strategy-registry, candle-loader, strategy-path
- `src/loop/` — Orchestrator + stages (optimize, scoring, checkpoint, guardrails, integrity, events, research, summary, param-writer, run-engine)
- `src/types/` — Zod config schemas
- `assets/{ASSET}/{CATEGORY}/{IMPLEMENTATION}/` — Strategy artifacts (checkpoints, param history, optimization log)
- Strategies live in `packages/backtest/src/strategies/` (shared library)

## Optimization loop
- CLI: `node dist/loop/orchestrator.js --asset=BTC --strategy=breakout --max-iter=20`
- Lock is asset-level (`breaker-BTC.lock`) — prevents concurrent optimization of the same asset.
- **The loop STOPS when all criteria in `breaker-config.json` are met.**
- Two execution modes:
  - **refine**: param changes only → in-process `runBacktest()` (~2s/iteration)
  - **restructure**: Claude edits strategy `.ts` → typecheck → rebuild → child process (~5s/iteration)
- Phase escalation: refine → research → restructure (automatic when refine plateaus)

## Experimental integrity (mandatory)
- Before accepting an iteration result, compare `contentHash` of strategy source.
- During an optimization loop, keep the backtest window fixed; only change in a new round.

## Naming (breaker-specific)
- Strategy `name` field: `{ASSET} {TF} {Category} — {Strategy Name}` (e.g. `BTC 15m Breakout — Donchian ADX`).
- Use full names (breakout, mean-reversion), not abbreviations in docs and code.

## Configuration (breaker-specific)
- `.env` for secrets only (API keys, tokens).
- Non-secret config lives in `breaker-config.json` and constants in code.
- Strategy data config in `breaker-config.json`: `coin`, `dataSource`, `interval`, `strategyFactory`, `dateRange`.

## Build and test (breaker-specific)
- Coverage: `pnpm vitest run --coverage`
- Tests: `pnpm test` (315 tests across 19 files)
- After strategy code changes in restructure phase: `pnpm --filter @trading/backtest typecheck` then `pnpm --filter @trading/backtest build`
