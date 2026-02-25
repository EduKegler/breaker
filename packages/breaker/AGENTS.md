# AGENTS Instructions — breaker

## Project overview
B.R.E.A.K.E.R. — Backtesting Runtime for Evolutionary Analysis, Kernel Execution & Refinement. Automated strategy optimization via Playwright + TradingView.

## Project structure
- `src/` — TypeScript code (automation/, webhook/, dashboard/, lib/, types/)
- `infra/` — deploy config (Dockerfile, docker-compose.yml, Caddyfile, healthcheck.sh)
- `playwright/` — Playwright runtime workspace (results/, exports/, .auth/, .env)
- `strategy.pine` (root) — canonical/base template; **not** the operational file for the per-asset loop
- `assets/{ASSET}/{STRATEGY}/` — nested by asset > strategy type
  - Active file: single `.pine` (e.g. `squeeze.pine`)
  - Archived: `*_archived.pine` (dead strategies, excluded from discovery)
  - `parameter-history.json`, `checkpoints/`, `optimization-log.md`
- `lib/` — emit_event.sh (used by breaker-loop.sh)
- `docs/` — documentation (alert-schema, knowledge-base)

## breaker-loop convention (mandatory)
- CLI: `ASSET=BTC STRATEGY=breakout ./breaker-loop.sh` (defaults: `ASSET=BTC`, `STRATEGY=breakout`)
- Queue: `QUEUE="BTC:breakout BTC:mean-reversion" ./breaker-queue.sh`
- The loop discovers the single active `.pine` in `assets/{ASSET}/{STRATEGY}/` via `findActiveStrategyFile()`.
- Archived files (`*_archived.pine`) are ignored by discovery.
- Always validate parameters/flags in the active strategy file, never in root `strategy.pine`.
- Lock is asset-level (`breaker-BTC.lock`) — prevents concurrent optimization of the same asset.
- **The loop STOPS when all criteria in `breaker-config.json` are met.** If the baseline already passes, the loop ends at iter 1 without optimizing. To force optimization, raise the bar on at least one criterion (e.g.: minTrades) above what the baseline delivers.

## Experimental integrity (mandatory)
- Before accepting an iteration result as valid, record and compare: `script_hash`, snapshot of applied parameters, and backtest window identifier.
- If there is a mismatch between the proposed change and actual file/result state, mark the iteration as invalid and do not use the metric for decisions.
- During an optimization loop, keep the backtest window fixed; only change the window in a new round and explicitly record it in the log.

## Naming (breaker-specific)
- Pine `strategy()` title: `{ASSET} {TF} {Category} — {Strategy Name}` (e.g. `BTC 15m Breakout — Squeeze Release`).
- Use full names (breakout, mean-reversion), not abbreviations (SQZ, MR) in docs and code.

## Configuration (breaker-specific)
- `.pine.env` also treated as secrets-only.
- Non-secret config lives in `breaker-config.json` and constants in code.

## Build, test and deploy (breaker-specific)
- Coverage: `pnpm vitest run --coverage` (server 86%, xlsx-utils 81%, config 100%)
- Deploy VPS: `./deploy.sh` (rsync + docker compose + health check)
- E2E tests: `pnpm test:e2e` (vitest with vitest.config.e2e.ts)
- For Playwright automation, validate interactions in E2E tests first, then integrate into production code.

## Pine Script (validation)
- Use MCP `pinescript-syntax-checker` to validate .pine before backtests.
- Use MCP `context7` to query Pine Script docs on-demand (do not keep local docs).
- breaker-loop v2 does automatic syntax check post-edit (revert if invalid).
