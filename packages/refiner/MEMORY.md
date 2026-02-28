# MEMORY -- refiner

Updated: 2026-02-28

## Current state
- Playwright/TradingView/XLSX/Pine Script fully removed -- replaced by in-process `@breaker/backtest` engine
- 27 test files, 352 tests, all passing
- Builds clean with `pnpm build`
- One-export-per-file convention fully applied across all files
- Consolidated objects: `lock`, `strategyRegistry`, `checkpoint`, `paramWriter`, `integrity`, `phaseHelpers`
- Split files: errors -> classify-error + backoff-delay, strategy-path -> build-strategy-dir + get-strategy-source-path, run-engine -> run-engine-in-process + spawn-engine-child, scoring -> scoring + compare-scores, optimize -> optimize + fix-strategy
- Extracted from orchestrator: parse-args, build-loop-config, check-criteria, phase-helpers
- Strategy registry maps config names (`createDonchianAdx`, `createKeltnerRsi2`) to backtest factories
- Candle loading via `CandleCache` (SQLite), synced once per session
- Two execution modes: in-process (refine) and child-process (restructure)
- All shell commands use `execaSync` from `execa` v9 (no `node:child_process` usage)
- All file writes use `write-file-atomic` v7 for crash-safe atomic writes (no manual tmp+rename)
- All JSON.parse calls use `safeJsonParse()` from `src/lib/safe-json.ts` with `jsonrepair` (for LLM output) and Zod schema validation
- Orchestrator uses xstate v5 state machine (`src/loop/state-machine.ts`) for phase/counter management

## Pending items
- Dashboard may need updates to reflect new metric sources
- `breaker-loop.sh` / `breaker-queue.sh` shell scripts are functional wrappers for orchestrator
- `run-engine-child.ts` child-process path not yet E2E tested (only in-process path validated)

## Known pitfalls
- Strategy factories return full TV-style names (e.g. "BTC 15m Breakout -- Donchian ADX"), not short slugs
- `resolveDataConfig` is private inside config.ts; accessed via `loadConfig(path, opts).dataConfig`
- `resolveDateRange` is private inside config.ts; accessed via `loadConfig(path, opts).dateRange`
- `repoRoot` = breaker package root; strategy sources resolved via `path.resolve(repoRoot, "../..")` to monorepo root
- Can't run breaker inside Claude Code session (nested session protection); use `unset CLAUDECODE`

## Non-obvious decisions
- Refine phase: if Claude unexpectedly edits strategy file, orchestrator reverts and ignores param output
- Restructure phase: typecheck failure -> revert to pre-edit source, count as failed iteration
- `paramOverrides` accumulates across iterations (each iteration can change subset of params)
- `countParams` removed as export (was trivial passthrough); scoring uses paramCount arg directly
- `safeJsonParse` with `repair: true` is for Claude/LLM-written files; internal files use schema-only validation
- xstate machine ADVISES state, it does not control flow -- the for-loop still drives iterations
- Phase helpers consolidated into `phaseHelpers` object with methods: shouldEscalate, resetCounters, getMaxIter, transitionOnMaxIter, computeEffectiveVerdict
- Machine uses transient `init` state to route to the correct initial phase based on input
