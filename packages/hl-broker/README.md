# @trading/hl-broker

> **Not yet implemented.** This package is an empty stub reserved for future development.

Planned: Hyperliquid broker — order execution, position management, and WhatsApp notifications.

## Planned features

- Order placement and execution via Hyperliquid SDK/API
- Position tracking and management
- WhatsApp notifications via whatsapp-gateway (POST /send)

## Planned configuration

Required secrets (`.env`):

```
HL_ACCOUNT_ADDRESS=0x...
HL_PRIVATE_KEY=...
GATEWAY_URL=http://localhost:3100   # whatsapp-gateway
```

## Commands

```bash
pnpm build      # Compile TypeScript (stub only)
pnpm test       # Run tests (none yet)
pnpm typecheck  # Type-check without emitting
```
