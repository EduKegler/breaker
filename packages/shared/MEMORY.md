# @trading/shared — MEMORY

## Current state
- Three utilities: `isMainModule`, `formatZodErrors`, `parseEnv`
- Consumed by: backtest, breaker, webhook, whatsapp-gateway

## Pending items
- None

## Known pitfalls
- `parseEnv` calls `process.env` at import time — importing in tests may need env vars set beforehand

## Non-obvious decisions
- `zod` is a direct dependency (not peer) — each consumer also declares its own zod dep
- `isMainModule` checks both `file://` and `file:///` prefixes for cross-platform compat
- `formatZodErrors` uses `type` import for zod to avoid bundling issues
