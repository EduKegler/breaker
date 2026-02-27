# @breaker/exchange

> **E** in the B.R.E.A.K.E.R. acrostic

Autonomous trading daemon for Hyperliquid perpetuals. Loads strategies from `@breaker/backtest`, polls candles, generates signals, executes orders with risk guardrails, and tracks positions with WhatsApp notifications.

## Setup

### 1. Install dependencies

```bash
pnpm install          # from monorepo root
pnpm build            # build all packages (exchange depends on backtest)
```

### 2. Configure secrets

Create `.env.testnet` and/or `.env.mainnet` (secrets only):

```
HL_ACCOUNT_ADDRESS=0x...
HL_PRIVATE_KEY=...
```

### 3. Configure the daemon

Edit `exchange-config.json` (all non-secret configuration):

```jsonc
{
  "mode": "testnet",          // "testnet" | "live"
  "asset": "BTC",             // trading pair
  "strategy": "donchian-adx", // "donchian-adx" | "keltner-rsi2"
  "interval": "15m",          // candle interval
  "warmupBars": 200,          // historical candles for indicator warmup
  "leverage": 5,
  "marginType": "isolated",   // "isolated" | "cross"
  "dryRun": false,            // true = log actions without executing orders
  "guardrails": { ... },      // see Risk Parameters below
  "sizing": { ... },          // see Position Sizing below
  "logLevels": {}             // per-module overrides, e.g. { "candlePoller": "debug" }
}
```

### 4. Run

```bash
pnpm start                    # starts daemon (polls, trades, serves HTTP)
```

## HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Status (`ok` / `stale`), last candle timestamp, uptime |
| GET | `/positions` | Current open positions |
| GET | `/orders` | Recent order history |
| GET | `/open-orders` | Live open orders from Hyperliquid |
| GET | `/equity` | Equity snapshots (5min intervals) |
| GET | `/candles` | Candle buffer; `?before=ts&limit=N` for historical |
| GET | `/signals` | Recent strategy signals |
| GET | `/strategy-signals` | Replay strategy over historical candles |
| GET | `/config` | Current daemon configuration |
| POST | `/signal` | Submit external signal (direction, stopLoss, etc.) |
| POST | `/quick-signal` | Quick entry with auto-computed ATR stop |
| POST | `/close-position` | Close position + cancel coin orders |
| DELETE | `/open-order/:oid` | Cancel a specific open order |

WebSocket at `/ws` streams real-time: candles, positions, orders, equity, signals.

## Risk Parameters

### Guardrails (`guardrails` in config)

| Parameter | Example | Rationale |
|-----------|---------|-----------|
| `maxNotionalUsd` | `5000` | Max position value. With 5x leverage on ~$1000 equity, this caps exposure at 5× equity. |
| `maxLeverage` | `5` | Moderate leverage for crypto. Higher increases liquidation risk on volatile moves. |
| `maxOpenPositions` | `1` | One position at a time — simplifies risk tracking and avoids correlated exposure. |
| `maxDailyLossUsd` | `100` | ~10% of equity. Circuit breaker: stops trading for the day after $100 in realized losses. |
| `maxTradesPerDay` | `999` | Effectively unlimited — strategy-level `maxTradesDay` param (default: 3) is the real limiter. Set to `0` to act as a kill switch (blocks all trades). |
| `cooldownBars` | `4` | 4 × 15m = 1 hour between trades. Prevents rapid re-entry after stop-outs. |

### Hardcoded safety caps (in `risk-engine.ts`, cannot be overridden)

| Cap | Value | Rationale |
|-----|-------|-----------|
| `ABSOLUTE_MAX_NOTIONAL_USD` | `$100,000` | Catches config mistakes — no single position can exceed this regardless of config. |
| `MAX_PRICE_DEVIATION_PCT` | `5%` | Rejects entries where signal price deviates >5% from market — blocks stale signals and fat-finger errors. |

### Position sizing (`sizing` in config)

| Mode | Parameter | How it works |
|------|-----------|--------------|
| `risk` | `riskPerTradeUsd: 10` | Size = $10 / distance-to-stop. With ~$1000 equity, risks ~1% per trade. |
| `cash` | `cashPerTrade: 100` | Fixed $100 per trade regardless of stop distance. Fallback mode. |

## Dry-run mode

Set `"dryRun": true` in `exchange-config.json`. The daemon runs the full pipeline (warmup, polling, signals, risk checks) but uses `DryRunHlClient` which logs actions without placing real orders. No Hyperliquid SDK connection or credentials needed.

## Commands

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests (257 tests, 19 files)
pnpm start      # Start daemon
pnpm typecheck  # Type-check without emitting
```

## Architecture

See `AGENTS.md` for detailed project structure, code patterns, and integration points.

Signal flow: `CandlePoller → Strategy.onCandle() → Signal → RiskEngine → OrderIntent → HyperliquidClient → Exchange`

Safety layers:
- **Strategy guardrails** (`canTrade`): cooldown, consecutive losses, daily limits
- **Risk engine** (`checkRisk`): notional caps, leverage, price deviation
- **Adapter truncation** (`truncateSize/truncatePrice`): SDK-compatible precision
- **Reconcile loop**: periodic sync of local state vs Hyperliquid (safety net)
- **Staleness detection**: WhatsApp alert after 5 empty polls; health endpoint reports `"stale"`
