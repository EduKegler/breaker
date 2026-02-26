# @breaker/alerts

> **A** in the B.R.E.A.K.E.R. acrostic

Lightweight REST service that sends and receives WhatsApp messages via the Evolution API. Acts as a centralized notification gateway for all other packages.

## API

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/send` | `{ text: string, recipient?: string }` | `{ status: "sent" }` |
| GET | `/health` | — | `{ status: "ok", uptime: number }` |

## Usage

```bash
pnpm build
pnpm start   # node --env-file=.env dist/server.js
```

### Sending a message

```bash
curl -X POST http://localhost:3100/send \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from BREAKER"}'
```

## Configuration

Required secrets (`.env`):

```
EVOLUTION_API_URL=https://api.example.com
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=my-instance
```

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_RECIPIENT` | — | Default recipient |
| `PORT` | `3100` | Server port |

## Structure

```
src/
├── server.ts          — Express setup and initialization
├── routes/
│   ├── send.ts        — POST /send (message delivery)
│   └── health.ts      — GET /health (health check)
├── lib/
│   ├── env.ts         — Zod schema for environment variables
│   └── evolution.ts   — Evolution API integration
└── types/
    └── message.ts     — Zod validation schemas for payloads
```

## Consumers

```
@breaker/router   ──┐
@breaker/exchange ──┼──> POST /send ──> Evolution API ──> WhatsApp
@breaker/refiner  ──┘
```

- **router** — forwards formatted TradingView alerts
- **exchange** — trade execution notifications
- **refiner** — optimization session summaries

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
