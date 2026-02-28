# AGENTS Instructions — refiner

## Project overview
B.R.E.A.K.E.R. — Backtesting & Refinement Engine for Automated Knowledge-driven Execution & Routing. Automated strategy optimization using in-process `@breaker/backtest` engine (no Playwright, no TradingView, no Pine Script).

## Project structure
- `src/automation/` — Prompt builders for Claude optimization/fix (`build-optimize-prompt-ts.ts`, `build-fix-prompt-ts.ts`)
- `src/dashboard/` — Dashboard and anomaly detection
- `src/lib/` — Config, lock, strategy-registry, candle-loader, strategy-path, safe-json
- `src/loop/` — Orchestrator + state-machine (xstate v5) + stages (optimize, scoring, checkpoint, guardrails, integrity, events, research, summary, param-writer, run-engine, run-claude)
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

## Infra conventions (breaker-specific)
- Shell commands: `execaSync` from `execa` (no `child_process`)
- File writes: `write-file-atomic` (no `fs.writeFileSync`)
- JSON parsing: `safeJsonParse()` from `src/lib/safe-json.ts` — `jsonrepair` for LLM output, Zod schemas for validation
- State management: xstate v5 machine in `src/loop/state-machine.ts` advises phase/counter state; for-loop still drives iteration flow

## Build and test (breaker-specific)
- Coverage: `pnpm vitest run --coverage`
- Tests: `pnpm test` (377 tests across 22 files)
- After strategy code changes in restructure phase: `pnpm --filter @breaker/backtest typecheck` then `pnpm --filter @breaker/backtest build`
