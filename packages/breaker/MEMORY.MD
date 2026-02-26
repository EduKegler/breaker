# MEMORY — breaker

Updated: 2026-02-26

## Current state
- Playwright/TradingView/XLSX/Pine Script fully removed — replaced by in-process `@trading/backtest` engine
- 20 test files, 314 tests, all passing
- Builds clean with `pnpm build`
- Strategy registry maps config names (`createDonchianAdx`, `createKeltnerRsi2`) to backtest factories
- Candle loading via `CandleCache` (SQLite), synced once per session
- Two execution modes: in-process (refine) and child-process (restructure)

## Pending items
- Dashboard may need updates to reflect new metric sources
- `breaker-loop.sh` / `breaker-queue.sh` shell scripts still reference old flow — update or remove
- `run-engine-child.ts` child-process path not yet E2E tested (only in-process path validated)

## Known pitfalls
- Strategy factories return full TV-style names (e.g. "BTC 15m Breakout — Donchian ADX"), not short slugs
- `resolveDataConfig` defaults: coin=asset symbol, dataSource="coinbase-perp", interval="15m", factory="createDonchianAdx"
- `resolveDateRange` returns epoch ms `{ startTime, endTime }`, not strings
- `repoRoot` = breaker package root; strategy sources resolved via `path.resolve(repoRoot, "../..")` to monorepo root
- Can't run breaker inside Claude Code session (nested session protection); use `unset CLAUDECODE`

## Non-obvious decisions
- Refine phase: if Claude unexpectedly edits strategy file, orchestrator reverts and ignores param output
- Restructure phase: typecheck failure → revert to pre-edit source, count as failed iteration
- `paramOverrides` accumulates across iterations (each iteration can change subset of params)
- `countParams` in scoring uses strategy's typed `params` count, not Pine input regex
