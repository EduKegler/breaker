# @trading/webhook

TradingView alert receiver that validates payloads, deduplicates signals, formats trading messages, and forwards to WhatsApp Gateway.

## Usage

```bash
pnpm build
pnpm start   # node dist/webhook/server.js
```

### Deploy (VPS)

```bash
docker compose -f infra/docker-compose.yml up -d
```

Deployed at `tv.kegler.dev` behind Caddy reverse proxy.

## Configuration

Required secrets (`.env`):

```
WEBHOOK_SECRET=...
GATEWAY_URL=http://localhost:3100   # whatsapp-gateway
```

Optional:

```
REDIS_URL=redis://localhost:6379    # without it, in-memory dedup (degraded mode)
TTL_SECONDS=1200                    # dedup TTL (default 20 min)
```

## Security

- Constant-time secret comparison (HMAC-SHA256)
- Two auth methods: URL token or JSON body secret
- Rate limiting per IP (30 req/min webhooks, 60 health)
- Zod validation on all incoming payloads

## Redis Policy

- `REDIS_URL` set: fail-fast if Redis unavailable at startup
- No `REDIS_URL`: degraded in-memory dedup (max 1000 entries, oldest-first eviction)
- Runtime Redis failure: fallback to memory cache with alarms logged

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
