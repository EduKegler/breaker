# MEMORY — router

## Current state
- Express server receiving TradingView alert webhooks (POST /webhook/:token and POST /webhook).
- Zod validation of alert payloads (AlertPayloadSchema).
- Dual deduplication: Redis (primary, via ioredis) + LRU in-memory fallback (max 1000 entries).
- Constant-time secret comparison (HMAC-SHA256) for auth; two auth modes: URL token or body secret.
- Rate limiting per IP: 30 req/min webhooks, 60 health, 5 debug.
- Formats trading alerts into WhatsApp messages and forwards to alerts via got (POST /send).
- Structured logging: pino + pino-http + pino-roll (stdout + date-rotated NDJSON files).
- Deployed at tv.kegler.dev behind Caddy reverse proxy (Docker multi-stage build).
- TTL_SECONDS controls alert dedup TTL (default 1200s / 20 min).
- Global daily trade limit: `DailyTradeLimit` class enforces max trades/day (default 5, via `GLOBAL_MAX_TRADES_DAY` env var). Resets at 00:00 UTC.
- 2 test files, 10 tests, all passing.

## Pending items
- No unit tests for formatWhatsAppMessage, isDuplicate, validateAlert, or safeCompare.

## Known pitfalls
- `env.ts` loads dotenv from `infra/.env` at import time — file must exist or env vars must be set before import
- Redis fail-fast: if REDIS_URL is set but Redis is down, server exits immediately

## Non-obvious decisions
- Redis fail-fast policy: if REDIS_URL is set but Redis is unreachable at startup, the server exits (fail_fast). Without REDIS_URL, it starts in degraded memory-only mode.
- Memory-only fallback has a 1000-entry LRU limit; oldest entries are evicted first.
- Runtime Redis disconnection triggers an alarm log and memory fallback; reconnection clears the alarm.
- The webhook server defines its own local sendWithRetry() using got (not the whatsapp-gateway export).
