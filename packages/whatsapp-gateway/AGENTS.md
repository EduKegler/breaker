# AGENTS Instructions — whatsapp-gateway

## Project overview
Lightweight REST service that sends and receives WhatsApp messages via the Evolution API. Provides a simple POST /send endpoint used by other services in the trading pipeline.

## Project structure
- `src/server.ts` — Express app setup and initialization
- `src/routes/send.ts` — POST /send endpoint for sending messages
- `src/routes/health.ts` — GET /health endpoint for health checks
- `src/lib/evolution.ts` — Evolution API integration with retry logic
- `src/types/message.ts` — Zod validation schemas for message payloads
- `infra/` — infrastructure config (reserved for future Docker/deploy setup)

## Configuration (whatsapp-gateway-specific)
- Required secrets: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`
- Config: `WHATSAPP_RECIPIENT` (default recipient), `PORT` (default 3100)

## API endpoints
- **POST /send** — Send WhatsApp message. Body: `{ text: string, recipient?: string }`. Returns `{ status: "sent" }` or error.
- **GET /health** — Health check. Returns `{ status: "ok", uptime: number }`.

## Error handling
- Zod `safeParse()` for all incoming payloads; 400 on validation errors with field-level details.
- `sendWithRetry()` in evolution.ts: automatic retry with 5s delay on gateway failures.
- 502 status for Evolution API failures.

## Additional deps
- Express.js for HTTP server
- Supertest for testing

## Run
- Start: `pnpm start` (node dist/server.js)

## Integration points
- **Evolution API**: sends messages via configured instance (`EVOLUTION_API_URL`)
- **Consumers**: webhook service and hl-broker call POST /send to deliver WhatsApp messages
