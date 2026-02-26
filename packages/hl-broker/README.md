# @trading/hl-broker

Hyperliquid broker — order execution, position management, and WhatsApp notifications.

## Usage

```bash
pnpm build
pnpm start   # node dist/server.js
```

## Configuration

Required secrets (`.env`):

```
HL_ACCOUNT_ADDRESS=0x...
HL_PRIVATE_KEY=...
GATEWAY_URL=http://localhost:3100   # whatsapp-gateway
```

## Integration

- **Hyperliquid**: order execution and position queries via HL SDK/API
- **whatsapp-gateway**: sends notifications via `GATEWAY_URL` (POST /send)

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
