# @trading/backtest

Local backtesting engine replacing TradingView automation. Fetches candles from Hyperliquid, caches in SQLite, runs strategies as TypeScript, simulates trades with realistic execution.

## Structure

```
src/
├── types/        — Candle, Strategy, Order, Metrics
├── data/         — Hyperliquid candle client + SQLite cache
├── indicators/   — EMA, SMA, ATR, RSI, ADX, Donchian, Keltner
├── engine/       — Backtest loop, order simulation, position tracking, equity curve
├── analysis/     — Metrics calculation, trade analysis, walk-forward, filter simulations
├── strategies/   — Strategy implementations (donchian-adx, keltner-rsi2)
└── run-backtest.ts — CLI entrypoint
```

## Usage

### As a library

```typescript
import {
  createDonchianAdx,
  runBacktest,
  computeMetrics,
  analyzeTradeList,
  CandleCache,
} from "@trading/backtest";

const cache = new CandleCache("candles.db");
const candles = cache.getCandles("BTC", "coinbase-perp", "15m", startTime, endTime);

const strategy = createDonchianAdx({ dcSlow: 55, atrMult: 4.5 });
const result = runBacktest(candles, strategy, config, "15m");
const metrics = computeMetrics(result.trades, result.maxDrawdownPct);
```

### CLI

```bash
pnpm build
node dist/run-backtest.js --coin=BTC --interval=15m --strategy=donchian-adx
```

## Strategies

| Strategy | Factory | Description |
|----------|---------|-------------|
| Donchian ADX | `createDonchianAdx` | Donchian channel breakout with ADX trend filter |
| Keltner RSI2 | `createKeltnerRsi2` | Keltner channel mean reversion with RSI2 entry |

Strategies implement the `Strategy` interface and return typed `StrategyParam` objects with min/max/step metadata.

## Key Conventions

- Strategies are pure functions operating on `Candle[]`
- Engine uses worst-case assumption: if SL and TP both trigger in same bar, SL wins
- SQLite cache lives in `.cache/candles.db` (gitignored)
- All indicators are pure functions operating on `number[]`

## Commands

```bash
pnpm build       # Compile TypeScript
pnpm test        # Run all tests (175 tests)
pnpm typecheck   # Type-check without emitting
```
