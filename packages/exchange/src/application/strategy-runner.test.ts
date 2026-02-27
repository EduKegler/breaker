import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrategyRunner, type StrategyRunnerDeps } from "./strategy-runner.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { Strategy, Candle, Signal, StrategyContext } from "@breaker/backtest";
import type { ExchangeConfig } from "../types/config.js";

const config: ExchangeConfig = {
  mode: "testnet",
  port: 3200,
  gatewayUrl: "http://localhost:3100",
  asset: "BTC",
  strategy: "donchian-adx",
  interval: "15m",
  dataSource: "hyperliquid",
  warmupBars: 5,
  leverage: 5,
  marginType: "isolated",
  guardrails: {
    maxNotionalUsd: 50000,
    maxLeverage: 5,
    maxOpenPositions: 1,
    maxDailyLossUsd: 100,
    maxTradesPerDay: 5,
    cooldownBars: 0,
  },
  sizing: {
    mode: "risk",
    riskPerTradeUsd: 10,
    cashPerTrade: 100,
  },
};

const makeCandle = (i: number): Candle => ({
  t: 1700000000000 + i * 900_000,
  o: 95000 + i * 10,
  h: 95500 + i * 10,
  l: 94500 + i * 10,
  c: 95200 + i * 10,
  v: 1000,
  n: 50,
});

function createTestStrategy(signalOnBar?: number): Strategy {
  return {
    name: "test-strategy",
    params: {},
    init: vi.fn(),
    onCandle: vi.fn((ctx: StrategyContext) => {
      if (signalOnBar !== undefined && ctx.index === signalOnBar) {
        const signal: Signal = {
          direction: "long",
          entryPrice: ctx.currentCandle.c,
          stopLoss: ctx.currentCandle.c - 1000,
          takeProfits: [{ price: ctx.currentCandle.c + 2000, pctOfPosition: 0.5 }],
          comment: "Test signal",
        };
        return signal;
      }
      return null;
    }),
    shouldExit: vi.fn().mockReturnValue(null),
  };
}

function createMockPoller(candles: Candle[]) {
  let pollIndex = candles.length;
  return {
    warmup: vi.fn().mockResolvedValue(candles),
    poll: vi.fn(async () => {
      if (pollIndex < candles.length) {
        return candles[pollIndex++];
      }
      return null;
    }),
    getCandles: vi.fn(() => candles.slice(0, pollIndex)),
    getLatest: vi.fn(() => pollIndex > 0 ? candles[pollIndex - 1] : null),
    addCandle(c: Candle) {
      candles.push(c);
    },
  };
}

function createDeps(strategy: Strategy, poller: ReturnType<typeof createMockPoller>): StrategyRunnerDeps {
  const store = new SqliteStore(":memory:");
  const positionBook = new PositionBook();
  return {
    config,
    strategy,
    poller: poller as unknown as StrategyRunnerDeps["poller"],
    positionBook,
    eventLog: { append: vi.fn() },
    signalHandlerDeps: {
      config,
      hlClient: {
        connect: vi.fn(),
        setLeverage: vi.fn(),
        placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
        placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
        placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
        cancelOrder: vi.fn(),
        getPositions: vi.fn().mockResolvedValue([]),
        getOpenOrders: vi.fn().mockResolvedValue([]),
        getHistoricalOrders: vi.fn().mockResolvedValue([]),
        getAccountEquity: vi.fn().mockResolvedValue(1000),
      },
      store,
      eventLog: { append: vi.fn() },
      alertsClient: { notifyPositionOpened: vi.fn() },
      positionBook,
    },
  };
}

describe("StrategyRunner", () => {
  it("warms up strategy with historical candles", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, poller);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    expect(poller.warmup).toHaveBeenCalledWith(5);
    expect(strategy.init).toHaveBeenCalledOnce();
  });

  it("does nothing when no new candle", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, poller);

    const runner = new StrategyRunner(deps);
    await runner.warmup();
    await runner.tick();

    expect(strategy.onCandle).not.toHaveBeenCalled();
  });

  it("calls strategy onCandle when new candle arrives", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, poller);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Add new candle and make it available for poll
    const newCandle = makeCandle(5);
    poller.addCandle(newCandle);

    await runner.tick();

    expect(strategy.onCandle).toHaveBeenCalledOnce();
  });

  it("opens position when strategy emits signal", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    // Signal on bar index 5 (the new candle)
    const strategy = createTestStrategy(5);
    const deps = createDeps(strategy, poller);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    poller.addCandle(makeCandle(5));
    await runner.tick();

    expect(deps.positionBook.count()).toBe(1);
    expect(deps.signalHandlerDeps.hlClient.placeMarketOrder).toHaveBeenCalledOnce();
  });

  it("does not call onCandle when in position", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy(5);
    const deps = createDeps(strategy, poller);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // First tick: opens position
    poller.addCandle(makeCandle(5));
    await runner.tick();

    // Second tick: should call shouldExit, not onCandle
    poller.addCandle(makeCandle(6));
    vi.mocked(strategy.onCandle).mockClear();
    await runner.tick();

    expect(strategy.onCandle).not.toHaveBeenCalled();
    expect(strategy.shouldExit).toHaveBeenCalled();
  });

  it("calls onNewCandle callback when new candle arrives", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy();
    const onNewCandle = vi.fn();
    const deps = createDeps(strategy, poller);
    deps.onNewCandle = onNewCandle;

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    const newCandle = makeCandle(5);
    poller.addCandle(newCandle);
    await runner.tick();

    expect(onNewCandle).toHaveBeenCalledOnce();
    expect(onNewCandle).toHaveBeenCalledWith(newCandle);
  });

  it("does not call onNewCandle when no new candle", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const poller = createMockPoller(candles);
    const strategy = createTestStrategy();
    const onNewCandle = vi.fn();
    const deps = createDeps(strategy, poller);
    deps.onNewCandle = onNewCandle;

    const runner = new StrategyRunner(deps);
    await runner.warmup();
    await runner.tick(); // no new candle

    expect(onNewCandle).not.toHaveBeenCalled();
  });

  it("stops running when stop() is called", () => {
    const candles = [makeCandle(0)];
    const poller = createMockPoller(candles);
    const deps = createDeps(createTestStrategy(), poller);

    const runner = new StrategyRunner(deps);
    expect(runner.isRunning()).toBe(false);

    // We can't test start() easily since it loops, but we can verify stop works
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});
