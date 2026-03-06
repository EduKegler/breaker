# CLAUDE Instructions — refiner

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
- **Optimize-first loop**: each iteration runs Optimize → Apply → Backtest → Score → Checkpoint/Rollback (change evaluated in same iteration)
- **The loop STOPS when all criteria met**, unless baseline already passes — then runs all iterations to maximize score.
- Two execution modes:
  - **refine**: param changes only → in-process `runBacktest()` (~2s/iteration)
  - **restructure**: Claude edits strategy `.ts` → typecheck → rebuild → child process (~5s/iteration)
- Phase escalation: refine → research → restructure (automatic when refine plateaus)

## Experimental integrity (mandatory)
- Before accepting an iteration result, compare `contentHash` of strategy source.
- During an optimization loop, keep the backtest window fixed; only change in a new round.
- Walk-forward overfit gate (KB §10.1): `validateWalkForward()` in `guardrails.ts` rejects iterations where `overfitFlag=true` (testPF < 50% of trainPF or testPF < 1.0), even if score improved. Prevents promotion of memorized strategies.
- Checkpoint save decision uses `effectiveVerdict` (not raw score comparison alone). Guardrail-rejected iterations (WF overfit, free variable count) never save checkpoints, and trigger rollback to last good state.
- Checkpoint save bakes optimized params into strategy source via `bakeParamDefaults()` — strategy files become self-contained. Stale params (from previous strategy versions) are auto-cleaned from `best-params.json`.

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

## Config vs KB alignment
- `breaker-config.json` top-level `minPF` set to KB floor (1.3). Strategy profiles can set stricter values.
- Orchestrator enforces KB module floors at runtime via `MODULE_CRITERIA` — config values less strict than KB are auto-bumped.
- M2 (mean-reversion) WR gate: KB requires WR >= 50%. Enforced by MODULE_CRITERIA + orchestrator floor override.

## Strategy files are AI-generated (critical)
- Strategy `.ts` files in `packages/backtest/src/strategies/` are **generated and updated by the refiner's Claude optimizer** via prompts.
- **Never fix bugs by editing strategy files directly** — the next refiner run will overwrite changes.
- Fixes must go into the **prompt** (`build-optimize-prompt.ts`) as hard rules, and/or into the **engine** as runtime validation guards.
- Strategy files should **not have hand-maintained unit tests** — they are ephemeral artifacts. Engine-level tests cover correctness.

## Known pitfalls
- Can't run breaker inside Claude Code session (nested session protection); use `unset CLAUDECODE`
- `run-engine-child.ts` child-process path E2E validated (~280ms with 26k candles after init() optimization)
- `backoffDelay` extracted to `@breaker/kit` — import from kit, not from loop/
- `pctOfPosition` in `takeProfits` is a **fraction (0-1)**, not a percentage. Engine validates at runtime (`> 1` throws). Enforced in optimizer prompt as hard rule.

## Build and test (breaker-specific)
- Coverage: `pnpm vitest run --coverage`
- Tests: `pnpm test` (637 tests across 30 files)
- After strategy code changes in restructure phase: `pnpm --filter @breaker/backtest typecheck` then `pnpm --filter @breaker/backtest build`
