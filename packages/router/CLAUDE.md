# CLAUDE Instructions — router

## Project overview
TradingView alert receiver that validates payloads, deduplicates signals (Redis or in-memory fallback), formats trading messages, and forwards them to the WhatsApp Gateway.

## Project structure
- `src/webhook/server.ts` — main Express server, webhook handlers, message formatting
- `src/lib/env.ts` — dotenv + Zod env loading (loads `infra/.env`, validates and exports typed `env` object)
- `src/lib/redis.ts` — Redis connection and deduplication operations
- `src/lib/logger.ts` — pino logger instance and pino-http middleware
- `src/types/alert.ts` — Zod schema for alert payload validation
- `infra/` — deploy config (Dockerfile, docker-compose.yml, Caddyfile, healthcheck.sh)

## Configuration (webhook-specific)
- Required secrets: `WEBHOOK_SECRET`, `GATEWAY_URL`
- Optional: `REDIS_URL` (if set, Redis is required at startup — fail-fast; without it, degraded in-memory mode)
- `TTL_SECONDS` controls alert dedup TTL (default 1200s / 20 min)

## Redis policy
- `REDIS_URL` set = fail-fast if Redis is down at startup.
- Without `REDIS_URL`, server starts in degraded mode with memory-only deduplication.
- If Redis becomes unavailable at runtime, fallback to memory cache with alarms logged.
- Max in-memory cache: 1000 entries, oldest-first eviction.

## Security
- Constant-time secret comparison using HMAC-SHA256.
- Two auth methods: URL token or JSON body secret.
- Rate limiting per IP + path (30 req/min for webhooks, 60 for health).
- Strict input validation via Zod on all incoming payloads.

## Run and deploy
- Start: `pnpm start` (node dist/webhook/server.js)
- Deploy VPS: `docker compose -f infra/docker-compose.yml up -d`

## Additional deps
- Express.js for HTTP server
- ioredis for Redis client
- pino + pino-http + pino-roll for structured logging
- Supertest for testing
- Docker (multi-stage build) + Caddy reverse proxy

## Logging
- **pino** for structured JSON logging (async I/O, no sync writes on event loop).
- **pino-http** middleware for automatic request/response logging.
- **pino-roll** for date-based file rotation (`LOG_DIR/webhook.YYYY-MM-DD.ndjson`).
- Dual output: stdout (for Docker log capture) + date-rotated NDJSON files.
- Logger instance and middleware exported from `src/lib/logger.ts`.
- Log levels: `debug`, `info`, `warn`, `error`.

## Integration points
- **TradingView**: receives alert webhooks (POST with secret auth)
- **alerts**: forwards formatted messages via `GATEWAY_URL` (POST /send)
- **VPS**: deployed at tv.kegler.dev behind Caddy reverse proxy
