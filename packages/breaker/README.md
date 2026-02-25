# B.R.E.A.K.E.R.

**Backtesting Runtime for Evolutionary Analysis, Kernel Execution & Refinement**

An autonomous trading strategy optimizer that uses Claude AI + Playwright to iteratively refine Pine Script strategies on TradingView. It backtests, analyzes results, proposes improvements, validates integrity, and repeats — with guardrails to prevent overfitting.

The system also includes a webhook server that receives TradingView alerts and forwards them to WhatsApp via Evolution API.

```
 ┌───────────────────────────────────────┐
 │          B.R.E.A.K.E.R. Loop          │
 │                                       │
 │        Backtest ──────▶ Parse         │
 │       (Playwright)      (XLSX)        │
 │           ▲                │          │
 │           │                ▼          │
 │       Guardrails      Integrity       │
 │           ▲            Check          │
 │           │                │          │
 │       Optimize ◀────── Scoring        │
 │       (Claude)          + Gate        │
 │                                       │
 │   Stops when all criteria are met     │
 └───────────────────────────────────────┘
```

---

## How It Works

### The Optimization Loop

Each iteration follows this pipeline:

1. **Backtest** — Playwright opens TradingView, pastes the Pine Script into the editor, runs the strategy, and exports an XLSX with all trades
2. **Parse** — Extracts metrics from the XLSX: PnL, Profit Factor, Win Rate, Max Drawdown, Avg R, trade count, session breakdown (Asia/London/NY), walk-forward split (70/30)
3. **Integrity** — Verifies a SHA-256 content token embedded in the strategy title matches the XLSX filename, ensuring results belong to the current code
4. **Scoring** — Computes a multi-objective score (0-100) weighting PF (25%), Avg R (20%), Sample Confidence (20%), Drawdown (15%), Complexity (10%), Win Rate (10%)
5. **Checkpoint** — If score improved and trade count is sufficient, saves the strategy as the new best. If score degraded, rolls back
6. **Optimize** — Claude analyzes the results and modifies the Pine Script. In `refine` phase: small parametric tweaks (max +1 variable per iteration). In `research` phase: web search for new approaches. In `restructure` phase: architectural changes
7. **Guardrails** — Validates protected fields weren't changed (commission, slippage, capital), parameter caps are respected, and exit rules weren't removed

The loop stops when **all criteria are met** (e.g., PF >= 1.8, DD <= 4%, WR >= 42%, trades >= 70).

### Phase Escalation

When the optimizer gets stuck (3 neutral iterations or 2 with no change), it automatically escalates:

```
refine ──▶ research ──▶ restructure ──▶ refine (cycle 2)
 small        web          structural       back to
 tweaks      search        changes          basics
```

Maximum 2 full cycles before giving up. If criteria aren't met, the system accepts that the strategy may not have sufficient edge — and that's a valid result.

### Webhook Pipeline

Separately, the webhook server handles live alerts:

```
TradingView Alert ──▶ POST /webhook/{secret} ──▶ Validate + Dedup ──▶ WhatsApp
```

- Zod schema validation
- TTL enforcement (alerts expire after 20 min)
- Idempotency via Redis (or in-memory fallback)
- Rate limiting (30 req/min per IP)
- Constant-time secret comparison

---

## Project Structure

```
.
├── src/
│   ├── loop/                  # Orchestrator + stages
│   │   ├── orchestrator.ts    # Main loop logic, phase management
│   │   ├── types.ts           # LoopConfig, IterationState, LoopPhase
│   │   └── stages/            # Modular pipeline stages
│   │       ├── backtest.ts    #   Run Playwright backtest
│   │       ├── parse.ts       #   Extract metrics from XLSX
│   │       ├── integrity.ts   #   Content token verification
│   │       ├── scoring.ts     #   Multi-objective scoring
│   │       ├── optimize.ts    #   Claude AI optimization
│   │       ├── research.ts    #   Web search for new ideas
│   │       ├── guardrails.ts  #   Protected fields + parameter caps
│   │       ├── checkpoint.ts  #   Save/restore best strategy
│   │       ├── param-writer.ts#   Update parameter history
│   │       ├── summary.ts     #   Session summary generation
│   │       └── events.ts      #   Event emission for monitoring
│   ├── automation/            # Playwright automation
│   │   ├── run-backtest.ts    #   TradingView backtest bot
│   │   ├── parse-results.ts   #   XLSX → metrics extraction
│   │   ├── build-optimize-prompt.ts  # Prompt construction
│   │   ├── build-fix-prompt.ts       # Fix prompt for compile errors
│   │   ├── selectors.ts      #   TradingView DOM selectors
│   │   └── login.ts          #   TradingView authentication
│   ├── webhook/               # Alert webhook server
│   │   └── server.ts         #   Express + Redis + WhatsApp
│   ├── lib/                   # Shared utilities
│   │   ├── config.ts         #   Config loader with 3-layer merge
│   │   ├── redis.ts          #   Redis client wrapper
│   │   ├── lock.ts           #   File locking
│   │   └── xlsx-utils.ts     #   XLSX parsing utilities
│   └── types/                 # Shared type definitions
│       ├── config.ts         #   Zod schemas for breaker-config
│       ├── alert.ts          #   Alert payload schema
│       └── parse-results.ts  #   Metrics types
├── assets/{ASSET}/{STRATEGY}/ # Per-asset, per-strategy
│   ├── {name}.pine           #   Active Pine Script (1 per dir)
│   ├── *_archived.pine       #   Dead strategies (ignored by discovery)
│   ├── parameter-history.json#   Optimization log (NDJSON)
│   └── checkpoints/          #   Best strategy snapshots
├── infra/                     # Docker deployment
│   ├── Dockerfile            #   Multi-stage Node.js build
│   ├── docker-compose.yml    #   Webhook + Caddy stack
│   ├── Caddyfile             #   HTTPS reverse proxy
│   └── healthcheck.sh        #   Cron-based health monitor
├── breaker-loop.sh            # Single-asset optimization runner
├── breaker-queue.sh           # Multi-asset parallel queue
├── breaker-config.json        # Criteria, scoring, guardrails, assets
├── deploy.sh                  # rsync + docker compose deploy
└── docs/knowledge-base.md     # Trading strategy research & decisions
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Playwright** (for TradingView automation)
- **TradingView account** (with Pine Script access)
- A **Claude API key** or Claude Code CLI installed

### Installation

```bash
git clone https://github.com/EduKegler/breaker.git
cd pine-editor-strategy
pnpm install
pnpm run build
```

### TradingView Authentication

The backtest bot needs a TradingView session. Log in once to save cookies:

```bash
pnpm run login
```

This opens a browser — log in manually. Playwright saves the session to `playwright/.auth/`.

### Configuration

All optimization behavior is controlled by `breaker-config.json`:

```jsonc
{
  // When to stop optimizing
  "criteria": {
    "minTrades": 70,
    "minPF": 1.8,       // Profit Factor
    "maxDD": 4,          // Max Drawdown %
    "minWR": 42          // Win Rate %
  },

  // Which Claude model for each task
  "modelRouting": {
    "optimize": "claude-sonnet-4-6",     // Fast iterations
    "restructure": "claude-opus-4-6",    // Deep structural changes
    "fix": "claude-haiku-4-5-20251001"   // Compile error fixes
  },

  // Per-strategy overrides
  "strategyProfiles": {
    "mean-reversion": {
      "minPF": 1.3,
      "maxDD": 8,
      "maxFreeVariables": 5
    },
    "breakout": {
      "maxFreeVariables": 8
    }
  },

  // Safety rails
  "guardrails": {
    "maxRiskTradeUsd": 25,
    "minAtrMult": 1.5,
    "protectedFields": [
      "commission_value", "slippage",
      "initial_capital", "process_orders_on_close"
    ]
  }
}
```

---

## Usage

### Run the Optimization Loop

```bash
# Single asset + strategy, 10 iterations
ASSET=BTC STRATEGY=breakout MAX_ITER=10 ./breaker-loop.sh

# Mean reversion strategy
ASSET=BTC STRATEGY=mean-reversion MAX_ITER=15 ./breaker-loop.sh

# Start from a specific phase
ASSET=BTC STRATEGY=breakout MAX_ITER=10 ./breaker-loop.sh --phase=research

# Auto-commit checkpoints to git
AUTO_COMMIT=true ASSET=BTC STRATEGY=breakout ./breaker-loop.sh
```

### Run Multiple Assets in Parallel

```bash
# Default queue (BTC:breakout BTC:mean-reversion)
./breaker-queue.sh

# Custom queue
QUEUE="BTC:breakout ETH:breakout" ./breaker-queue.sh
```

### Run a Single Backtest

```bash
pnpm run backtest -- --asset=BTC
```

### Parse Results Manually

```bash
pnpm run parse-results -- --asset=BTC
```

### Deploy the Webhook Server

```bash
# Create deployment config
cp .deploy.env.example .deploy.env
# Edit .deploy.env with your VPS credentials

# Deploy
./deploy.sh
```

### Start the Webhook Locally

```bash
# Create infra/.env from the example
cp infra/.env.example infra/.env
# Edit with your actual keys

pnpm run webhook
```

---

## Webhook API

### `POST /webhook/{secret}`

Receives a TradingView alert and sends it to WhatsApp.

```json
{
  "alert_id": "alert_xyz_123",
  "signal_ts": 1708960000,
  "asset": "BTC",
  "side": "LONG",
  "entry": 97500.00,
  "sl": 95200.00,
  "tp1": 100300.00,
  "risk_usd": 250,
  "leverage": 5,
  "notional_usdc": 48750,
  "margin_usdc": 9750
}
```

**Responses:**


| Status | Body                        | Meaning                        |
| ------ | --------------------------- | ------------------------------ |
| 200    | `{status: "sent"}`          | Alert forwarded to WhatsApp    |
| 200    | `{status: "duplicate"}`     | Already processed (idempotent) |
| 200    | `{status: "expired"}`       | Alert older than TTL           |
| 400    | `{error: "invalid JSON"}`   | Malformed request              |
| 403    | `{error: "invalid secret"}` | Wrong or missing secret        |
| 429    |                             | Rate limit exceeded            |
| 502    | `{error: "send failed"}`    | WhatsApp delivery failed       |


### `GET /health`

```json
{
  "status": "ok",
  "uptime_s": 3600,
  "dedup_mode": "redis",
  "redis_configured": true,
  "dedup_degraded": false
}
```

---

## Anti-Overfitting Measures

A core design goal — the system actively fights overfitting:


| Measure                       | How                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Variable count gate**       | Max free variables per strategy profile (MR: 5, Breakout: 8). Refine phase: max +1 per iteration     |
| **Walk-forward validation**   | 70/30 train/test split. If `pfRatio < 0.6` → overfit flag raised                                     |
| **Session breakdown**         | Metrics per session (Asia/London/NY). MR should profit in Asia, not London — if reversed, suspicious |
| **Content integrity token**   | SHA-256 in strategy title prevents using stale/wrong backtest results                                |
| **Multi-objective scoring**   | Complexity is 10% of the score — more variables = lower score at equal performance                   |
| **Checkpoint discipline**     | Only saves checkpoint if trades >= minTrades, preventing low-sample overfitting                      |
| **Protected fields**          | Commission, slippage, capital can't be changed by the optimizer                                      |
| **Rollback threshold**        | Score drops > 8% → automatic rollback to best checkpoint                                             |
| **Phase limits**              | Max iterations per phase and max cycles prevent infinite optimization                                |
| **Research domain whitelist** | Only trusted sources (arxiv, quantpedia, etc.) to avoid importing noise from blog posts              |


---

## Testing

```bash
# Run all tests (574 tests)
pnpm test

# Watch mode
pnpm run test:watch

# Coverage report
pnpm run test:coverage
```

Every module has tests. Every bug fix requires a regression test.

---

## Claude Code Integration

This project is designed to be operated via [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It includes custom skills and MCP servers that extend Claude's capabilities.

### Skills

Slash commands that automate common workflows:


| Skill         | Trigger                                    | What it does                                                                         |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `/backtest`   | `backtest`, `roda backtest`, `otimiza`     | Runs `breaker-loop.sh` for a given asset and reports metrics vs. criteria            |
| `/deploy`     | `deploy`, `manda pra VPS`, `publica`       | Builds, tests, deploys to VPS via `deploy.sh`, and runs health check                 |
| `/health`     | `health`, `status da VPS`, `ta rodando?`   | Checks webhook endpoint, Docker containers, and recent logs on VPS                   |
| `/pine-check` | `pine-check`, `valida o pine`, `lint pine` | Validates a `.pine` file syntax via the PineScript MCP, suggests fixes               |
| `/commit`     | `commit`, `commita`, `manda pro git`       | Builds, tests, verifies .md files, generates Conventional Commit message, and pushes |
| `/chart-help` | *(contextual)*                             | Visual guide — explains labels, lines, shapes, and backgrounds on TradingView charts |


### MCP Servers

External tools available to Claude during sessions:


| Server                        | Package                         | Purpose                                                                                                |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **pinescript-syntax-checker** | `uvx pinescript-syntax-checker` | Validates Pine Script v6 syntax before backtests — catches compile errors early                        |
| **context7**                  | `@upstash/context7-mcp`         | On-demand library documentation lookup — used for Pine Script docs instead of maintaining local copies |
| **playwright**                | `@playwright/mcp`               | Browser automation — powers the TradingView backtest bot                                               |
| **hyperliquid**               | custom script                   | Trading operations on Hyperliquid DEX — place/cancel orders, check positions and balances              |
| **hyperliquid-info**          | custom Python server            | Read-only Hyperliquid data — market prices, funding rates, candles, order book, user history           |


MCP configuration lives in `.mcp.json`.

---

## Architecture Decisions

- **Playwright over API**: TradingView has no public backtesting API. Playwright automates the browser to run real backtests with real data
- **Claude as optimizer**: The AI reads metrics + Pine Script, proposes targeted changes, and writes metadata about its reasoning. All changes are deterministically recorded in `parameter-history.json`
- **Thin shell wrapper**: `breaker-loop.sh` just builds TypeScript and delegates to the Node.js orchestrator. All logic lives in TypeScript with tests
- **Redis optional**: Webhook works with in-memory dedup for single-instance deploys. Redis enables distributed dedup across restarts
- **Caddy for HTTPS**: Automatic TLS certificate renewal. Zero-config HTTPS

---

## Environment Variables

Secrets go in `.env` files (gitignored). Everything else is in `breaker-config.json`.


| Variable             | Where         | Purpose                              |
| -------------------- | ------------- | ------------------------------------ |
| `WEBHOOK_SECRET`     | `infra/.env`  | Authenticates incoming alerts        |
| `EVOLUTION_API_KEY`  | `infra/.env`  | WhatsApp gateway (Evolution API)     |
| `EVOLUTION_INSTANCE` | `infra/.env`  | Evolution API instance name          |
| `WHATSAPP_RECIPIENT` | `infra/.env`  | Phone number for alerts              |
| `REDIS_URL`          | `infra/.env`  | Optional — enables distributed dedup |
| `VPS_HOST`           | `.deploy.env` | SSH target for deployment            |


See `infra/.env.example` and `.deploy.env.example` for templates.

---

## License

MIT