# AGENTS Instructions — Monorepo Root

## Project memory
- Each package has its own `MEMORY.md` (~50 lines max, 3 sections: current state, pending items, non-obvious decisions).
- AT THE START of each session: read the relevant `MEMORY.md` (it's short).
- AT THE END of each session: update `MEMORY.md` if anything changed.
- DO NOT record session changelog — git log is the source of truth.

## Continuous improvement of AGENTS.md
- Identify patterns, conventions or rules that should be documented.
- Proactively update when a new rule becomes established.
- Shared rules go in root `AGENTS.md`; package-specific rules stay in `packages/*/AGENTS.md`.

## Monorepo structure
```
trading/
├── packages/
│   ├── breaker/          — backtesting automation & optimization
│   ├── hl-broker/        — Hyperliquid order execution & position management
│   ├── webhook/          — TradingView alert receiver & forwarder
│   └── whatsapp-gateway/ — WhatsApp messaging via Evolution API
├── package.json          — root (private, workspaces)
├── pnpm-workspace.yaml   — declares packages/*
├── tsconfig.base.json    — shared TypeScript config
└── AGENTS.md             — this file (shared rules)
```

## Naming conventions
- File names use **kebab-case** (hyphens, not underscores).

## Configuration and secrets
- `.env` is EXCLUSIVELY for secrets (API keys, tokens, credentials) that must not leak.
- Everything else (timeouts, thresholds, flags) should be hardcoded or in config files.
- DO NOT use environment variables for non-secret configuration.

## Build, test and deploy
- Package manager: **pnpm** (workspaces)
- Build all: `pnpm build` (root runs `pnpm -r build`)
- Test all: `pnpm test` (root runs `pnpm -r test`)
- Type check all: `pnpm typecheck` (root runs `pnpm -r typecheck`)
- Run for a single package: `pnpm --filter @trading/breaker build`
- **Mandatory validation**: every code change (`src/`, `*.ts`) MUST end with `pnpm build && pnpm test`. Do not consider the task complete until tests pass.
- **Regression rule**: every bug fix MUST include at least 1 test that reproduces the bug and verifies the fix.
- **TDD-first**: write or update tests BEFORE implementing the feature/fix.
- Mandatory pattern: every executable module in src/ must have an `isMain` guard (do not execute when imported in tests).

## Tech stack (shared)
- TypeScript (strict, ES2022, NodeNext modules)
- Zod for runtime schema validation
- Vitest for testing
- ES Modules (`type: "module"` in package.json)
