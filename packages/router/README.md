# @breaker/router

> **R** (final) in the B.R.E.A.K.E.R. acrostic

TradingView alert receiver that validates payloads, deduplicates signals, formats trading messages, and forwards them to WhatsApp via `@breaker/alerts`.

## Flow

```
TradingView
     |
  [webhook POST + secret]
     |
     v
  Validation (Zod) ──> 400 if invalid
     |
  Authentication (HMAC-SHA256) ──> 401 if failed
     |
  Dedup (Redis or in-memory) ──> 200 skip if duplicate
     |
  Message formatting
     |
     v
  POST /send ──> @breaker/alerts ──> WhatsApp
```

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
GATEWAY_URL=http://localhost:3100   # @breaker/alerts
```

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | — | If set, Redis is required at startup |
| `TTL_SECONDS` | `1200` | Dedup TTL (20 min) |

## Security

- **Authentication**: constant-time comparison via HMAC-SHA256
- **Two auth methods**: URL token or JSON body secret
- **Rate limiting**: 30 req/min for webhooks, 60 for health (per IP)
- **Validation**: Zod on all incoming payloads

## Redis Policy

| Scenario | Behavior |
|----------|----------|
| `REDIS_URL` set | Fail-fast if Redis unavailable at startup |
| No `REDIS_URL` | Degraded mode with in-memory dedup |
| Redis drops at runtime | Fallback to memory cache + alarms logged |

In-memory cache: max 1000 entries, oldest-first eviction.

## Structure

```
src/
├── webhook/
│   └── server.ts      — Express server, webhook handlers, formatting
├── lib/
│   ├── env.ts         — dotenv + Zod validation
│   ├── redis.ts       — Redis connection and dedup operations
│   └── logger.ts      — pino logger + pino-http middleware
└── types/
    └── alert.ts       — Zod schema for alert payloads
```

### Infra

```
infra/
├── Dockerfile           — Multi-stage build
├── docker-compose.yml   — Full stack (app + Redis + Caddy)
├── Caddyfile            — Reverse proxy with automatic HTTPS
└── healthcheck.sh       — Docker health check script
```

## Logging

- **pino** for structured JSON logging (async I/O)
- **pino-http** for automatic request/response logging
- **pino-roll** for date-based file rotation (`webhook.YYYY-MM-DD.ndjson`)
- Dual output: stdout (Docker) + rotated NDJSON files

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm typecheck  # Type-check without emitting
```
