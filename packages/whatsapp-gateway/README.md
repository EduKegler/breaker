# @trading/whatsapp-gateway

Lightweight REST service that sends and receives WhatsApp messages via the Evolution API.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/send` | Send WhatsApp message. Body: `{ text, recipient? }` |
| GET | `/health` | Health check. Returns `{ status, uptime }` |

## Usage

```bash
pnpm build
pnpm start   # node --env-file=.env dist/server.js
```

### Send a message

```bash
curl -X POST http://localhost:3100/send \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from trading bot"}'
```

## Configuration

Required secrets (`.env`):

```
EVOLUTION_API_URL=https://api.example.com
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=my-instance
```

Optional:

```
WHATSAPP_RECIPIENT=+5548...   # default recipient
PORT=3100                      # server port
```

## Integration

Used by:
- **@trading/webhook** — forwards formatted TradingView alerts
- **@trading/hl-broker** — sends trade execution notifications
- **@trading/breaker** — sends optimization session summaries

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
