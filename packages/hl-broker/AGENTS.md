# AGENTS Instructions — hl-broker

## Project overview
Hyperliquid broker — order execution, position management, and WhatsApp notifications on the Hyperliquid trading platform.

## Project structure
- `src/` — TypeScript source code
- `dist/` — compiled output (tsc → dist/)

## Configuration (hl-broker-specific)
- Required secrets: `HL_ACCOUNT_ADDRESS`, `HL_PRIVATE_KEY`, `GATEWAY_URL`

## Run
- Start: `pnpm start` (node dist/server.js)

## Integration points
- **whatsapp-gateway**: sends notifications via `GATEWAY_URL` (POST /send)
- **Hyperliquid**: order execution and position queries via HL SDK/API
