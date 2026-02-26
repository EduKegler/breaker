# AGENTS Instructions — exchange

## Status: Stub / Planned

This package is an empty stub. The source (`src/index.ts`) only exports `{}`. None of the features described below are implemented yet.

## Project overview
Hyperliquid broker — planned for order execution, position management, and WhatsApp notifications on the Hyperliquid trading platform.

## Project structure
- `src/index.ts` — empty stub (`export {}`)
- `dist/` — compiled output (tsc -> dist/)

## Planned: Configuration
- Required secrets: `HL_ACCOUNT_ADDRESS`, `HL_PRIVATE_KEY`, `GATEWAY_URL`

## Planned: Features
- Order placement and execution via Hyperliquid SDK/API
- Position tracking and management
- WhatsApp notifications via alerts

## Planned: Integration points
- **alerts**: send notifications via `GATEWAY_URL` (POST /send)
- **Hyperliquid**: order execution and position queries via HL SDK/API
