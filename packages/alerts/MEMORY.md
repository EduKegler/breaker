# MEMORY — alerts

## Current state
- Evolution API wrapper providing a simple REST interface for WhatsApp messaging.
- Express server with two endpoints: POST /send (send message) and GET /health.
- Single function `sendWhatsApp()` in `src/lib/evolution.ts` handles Evolution API calls.
- Package exports `sendWhatsApp` as its public API (used by refiner's orchestrator).
- Zod validation on incoming POST /send payloads (SendMessageSchema).
- Env config via Zod with safe defaults (won't throw if env vars are missing).
- Default port: 3100.

## Pending items
- No tests yet (supertest is a devDependency but no test files exist).
- No structured logging (uses console.log).
- No Docker/deploy infra (infra/ directory reserved but empty).

## Known pitfalls
- Env schema has safe defaults for all fields — module can be imported without env vars (needed because refiner imports at build time)

## Non-obvious decisions
- The Evolution API instance name defaults to "sexta-feira" (hardcoded in env schema).
- Env schema uses safe defaults for all fields so the module can be imported without env vars (important because refiner imports the library export at build time).
- `sendWhatsApp()` has retry disabled (`retry: { limit: 0 }`) — callers are responsible for retry logic.
