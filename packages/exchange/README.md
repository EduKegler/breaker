# @breaker/exchange

> **E** in the B.R.E.A.K.E.R. acrostic

> **Status: Stub** — This package is a placeholder reserved for future development.

Hyperliquid broker — order execution, position management, and trade notifications.

## Planned Features

- Order placement and execution via Hyperliquid SDK/API
- Real-time position tracking and management
- WhatsApp notifications via `@breaker/alerts` (POST /send)

## Planned Configuration

Required secrets (`.env`):

```
HL_ACCOUNT_ADDRESS=0x...
HL_PRIVATE_KEY=...
GATEWAY_URL=http://localhost:3100   # @breaker/alerts
```

## Integrations

```
Exchange
   ├── Hyperliquid API  — order execution, position queries
   └── @breaker/alerts  — notifications via POST /send
```

## Commands

```bash
pnpm build      # Compile TypeScript (stub only)
pnpm test       # Run tests (none yet)
pnpm typecheck  # Type-check without emitting
```
