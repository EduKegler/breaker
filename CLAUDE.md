# CLAUDE Instructions — Monorepo Root

## Monorepo structure (B.R.E.A.K.E.R.)
```
trading/
├── packages/
│   ├── backtest/         — B · backtesting engine, indicators, strategies & candle data
│   ├── refiner/          — R · automated strategy optimization loop
│   ├── exchange/         — E · Hyperliquid trading daemon (strategy runner, risk engine, execution)
│   ├── alerts/           — A · WhatsApp messaging via Evolution API
│   ├── kit/              — K · shared utilities (isMainModule, parseEnv, formatZodErrors)
│   ├── explorer/         — E · live trading dashboard (Vite + React)
│   └── router/           — R · TradingView alert receiver & forwarder
├── package.json          — root (private, workspaces)
├── pnpm-workspace.yaml   — declares packages/*
├── tsconfig.base.json    — shared TypeScript config
└── CLAUDE.md             — this file (shared rules)
```

## Configuration and secrets
- `.env` is EXCLUSIVELY for secrets (API keys, tokens, credentials) that must not leak.
- Everything else (timeouts, thresholds, flags) should be hardcoded or in config files.
- DO NOT use environment variables for non-secret configuration.

## Build, test and deploy
- Package manager: **pnpm** (workspaces)
- Build all: `pnpm build` (root runs `pnpm -r build`)
- Test all: `pnpm test` (root runs `pnpm -r test`)
- Type check all: `pnpm typecheck` (root runs `pnpm -r typecheck`)
- Run for a single package: `pnpm --filter @breaker/refiner build`
- If a bug originated from a prompt-driven system (e.g. refiner), update the prompt rules too.
- Mandatory pattern: every executable module in src/ must have an `isMainModule(import.meta.url)` guard from `@breaker/kit` (do not execute when imported in tests).

## Running services
- `pnpm daemon` — exchange daemon (tsx --watch, requires `.env` with HL keys)
- `pnpm router` — TradingView webhook receiver
- `pnpm alerts` — WhatsApp gateway
- `pnpm dev` — explorer Vite dev server (port 5173, proxies `/api/*` to `:3200`)
- `pnpm dashboard` — refiner optimization dashboard
- `pnpm validate` — full pre-submit: build + test + typecheck

## Architecture & data flow
```
TradingView → [webhook] → Router → Alerts → WhatsApp
                                      ↑
Backtest ←→ Refiner (Claude AI)       |
                                      |
                          Exchange ----+
                         (Hyperliquid)
```

### Workspace dependency graph (build order matters)
```
kit  ←  backtest  ←  refiner (also depends on kit, alerts)
kit  ←  exchange  (also depends on backtest)
kit  ←  alerts
kit  ←  router
explorer has no workspace deps (consumes exchange API via HTTP/WS)
```

## Tech stack (shared)
- Vitest for testing

## Cross-package pitfalls
- Must build `@breaker/backtest` before running exchange tests (workspace dep)
- Shell commands: use `execaSync` from `execa`, not `child_process`
- File writes: use `write-file-atomic`, not `fs.writeFileSync`
- JSON from LLM output: parse with `safeJsonParse()` from refiner's `safe-json.ts` (uses `jsonrepair`)
- Config files: `exchange-config.json` (exchange), `breaker-config.json` (refiner) — NOT `.env`
