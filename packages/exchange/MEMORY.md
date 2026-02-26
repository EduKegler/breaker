# MEMORY — exchange

## Current state
- Empty stub package. `src/index.ts` exports nothing (`export {}`).
- TypeScript compiles successfully but there is no runtime functionality.
- Planned for Hyperliquid order execution, position tracking, and WhatsApp notifications.

## Pending items
- Order placement and execution via Hyperliquid SDK/API.
- Position tracking and management.
- Risk management and guardrails.
- WhatsApp notification integration via alerts.
- Tests (none exist).
- Actual dependencies (only zod is listed; will need Hyperliquid SDK).

## Known pitfalls
- Empty stub — no runtime code exists yet

## Non-obvious decisions
- Package was scaffolded early to reserve the namespace and establish the monorepo slot.
- The `start` script was removed because there is no server.js to run.
