import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
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
  dataSource: "binance",
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
  autoTradingEnabled: true,
  entrySlippageBps: 10,
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

function createMockStreamer(candles: Candle[]) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    warmup: vi.fn().mockResolvedValue(candles),
    start: vi.fn(),
    stop: vi.fn(),
    getCandles: vi.fn(() => candles),
    getLatest: vi.fn(() => candles.length > 0 ? candles[candles.length - 1] : null),
    fetchHistorical: vi.fn().mockResolvedValue([]),
    addCandle(c: Candle) {
      candles.push(c);
    },
  });
}

function createDeps(strategy: Strategy, streamer: ReturnType<typeof createMockStreamer>): StrategyRunnerDeps {
  const store = new SqliteStore(":memory:");
  const positionBook = new PositionBook();
  return {
    config,
    strategy,
    streamer: streamer as unknown as StrategyRunnerDeps["streamer"],
    positionBook,
    eventLog: { append: vi.fn() },
    signalHandlerDeps: {
      config,
      hlClient: {
        connect: vi.fn(),
        getSzDecimals: vi.fn().mockReturnValue(5),
        setLeverage: vi.fn(),
        placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
        placeEntryOrder: vi.fn().mockResolvedValue({ orderId: "HL-E1", filledSize: 0.01, avgPrice: 95200, status: "placed" }),
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
      alertsClient: { notifyPositionOpened: vi.fn(), notifyTrailingSlMoved: vi.fn(), sendText: vi.fn() },
      positionBook,
    },
  };
}

describe("StrategyRunner", () => {
  it("warms up strategy with historical candles", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    expect(streamer.warmup).toHaveBeenCalledWith(5);
    expect(strategy.init).toHaveBeenCalledOnce();
  });

  it("does nothing when no new candle", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();
    await runner.tick();

    expect(strategy.onCandle).not.toHaveBeenCalled();
  });

  it("calls strategy onCandle when new candle arrives", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Add new candle and make it available for poll
    const newCandle = makeCandle(5);
    streamer.addCandle(newCandle);

    await runner.tick();

    expect(strategy.onCandle).toHaveBeenCalledOnce();
  });

  it("opens position when strategy emits signal", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    // Signal on bar index 5 (the new candle)
    const strategy = createTestStrategy(5);
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    expect(deps.positionBook.count()).toBe(1);
    expect(deps.signalHandlerDeps.hlClient.placeEntryOrder).toHaveBeenCalledOnce();
  });

  it("does not call onCandle when in position", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // First tick: opens position
    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // Second tick: should call shouldExit, not onCandle
    streamer.addCandle(makeCandle(6));
    vi.mocked(strategy.onCandle).mockClear();
    await runner.tick();

    expect(strategy.onCandle).not.toHaveBeenCalled();
    expect(strategy.shouldExit).toHaveBeenCalled();
  });

  it("calls onNewCandle callback when new candle arrives", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const onNewCandle = vi.fn();
    const deps = createDeps(strategy, streamer);
    deps.onNewCandle = onNewCandle;

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    const newCandle = makeCandle(5);
    streamer.addCandle(newCandle);
    await runner.tick();

    expect(onNewCandle).toHaveBeenCalledOnce();
    expect(onNewCandle).toHaveBeenCalledWith(newCandle);
  });

  it("does not call onNewCandle when no new candle", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const onNewCandle = vi.fn();
    const deps = createDeps(strategy, streamer);
    deps.onNewCandle = onNewCandle;

    const runner = new StrategyRunner(deps);
    await runner.warmup();
    await runner.tick(); // no new candle

    expect(onNewCandle).not.toHaveBeenCalled();
  });

  it("notifies when trailing SL moves favorably (long)", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    // Signal on bar 5
    const strategy = createTestStrategy(5);
    // Mock getExitLevel: returns increasing values (favorable for long)
    let exitLevelCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitLevelCall++;
      return exitLevelCall === 1 ? 94000 : 94500; // moved up = favorable for long
    });
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Tick 1: open position
    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // Tick 2: in position, getExitLevel returns 94000 (first call, sets baseline)
    streamer.addCandle(makeCandle(6));
    await runner.tick();
    expect(strategy.getExitLevel).toHaveBeenCalledTimes(1);
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).not.toHaveBeenCalled();

    // Tick 3: getExitLevel returns 94500 (moved up → notify)
    streamer.addCandle(makeCandle(7));
    await runner.tick();
    expect(strategy.getExitLevel).toHaveBeenCalledTimes(2);
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).toHaveBeenCalledOnce();
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).toHaveBeenCalledWith(
      "BTC", "long", 94000, 94500, expect.any(Number), "testnet",
    );
  });

  it("notifies when trailing SL moves favorably (short)", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    // Override to return short signal
    vi.mocked(strategy.onCandle).mockImplementation((ctx: StrategyContext) => {
      if (ctx.index === 5) {
        return {
          direction: "short",
          entryPrice: ctx.currentCandle.c,
          stopLoss: ctx.currentCandle.c + 1000,
          takeProfits: [{ price: ctx.currentCandle.c - 2000, pctOfPosition: 0.5 }],
          comment: "Test short",
        };
      }
      return null;
    });
    let exitLevelCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitLevelCall++;
      return exitLevelCall === 1 ? 96000 : 95500; // moved down = favorable for short
    });
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    streamer.addCandle(makeCandle(6));
    await runner.tick();
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).not.toHaveBeenCalled();

    streamer.addCandle(makeCandle(7));
    await runner.tick();
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).toHaveBeenCalledOnce();
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).toHaveBeenCalledWith(
      "BTC", "short", 96000, 95500, expect.any(Number), "testnet",
    );
  });

  it("does not notify when trailing SL moves unfavorably", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    let exitLevelCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitLevelCall++;
      return exitLevelCall === 1 ? 94000 : 93500; // moved down = unfavorable for long
    });
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    streamer.addCandle(makeCandle(6));
    await runner.tick();

    streamer.addCandle(makeCandle(7));
    await runner.tick();

    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).not.toHaveBeenCalled();
  });

  it("resets lastExitLevel when position is closed", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    strategy.getExitLevel = vi.fn().mockReturnValue(94000);
    // Exit on tick after opening
    vi.mocked(strategy.shouldExit!).mockImplementation((ctx: StrategyContext) => {
      // Exit on bar 7 (third tick in position)
      if (ctx.index === 7) return { exit: true, comment: "test exit" };
      return null;
    });
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Open position
    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // In position, set baseline
    streamer.addCandle(makeCandle(6));
    await runner.tick();

    // Exit position
    streamer.addCandle(makeCandle(7));
    await runner.tick();

    // After exit, no trailing SL notification should fire
    expect(deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved).not.toHaveBeenCalled();
  });

  it("position is not removed from PositionBook when exit placeMarketOrder fails", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    // shouldExit triggers on bar 6
    vi.mocked(strategy.shouldExit!).mockImplementation((ctx: StrategyContext) => {
      if (ctx.index === 6) return { exit: true, comment: "test exit" };
      return null;
    });
    const deps = createDeps(strategy, streamer);

    // Make exit placeMarketOrder fail (entry uses placeEntryOrder now)
    (deps.signalHandlerDeps.hlClient.placeMarketOrder as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Exchange timeout")); // exit fails

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Tick 1: open position
    streamer.addCandle(makeCandle(5));
    await runner.tick();
    expect(deps.positionBook.count()).toBe(1);

    // Tick 2: shouldExit fires, placeMarketOrder fails → error propagates through tick()
    // The start() loop catches this, but tick() itself throws
    streamer.addCandle(makeCandle(6));
    await expect(runner.tick()).rejects.toThrow("Exchange timeout");

    // Position should still be in the book (not removed)
    expect(deps.positionBook.count()).toBe(1);
    expect(deps.positionBook.get("BTC")).not.toBeNull();
  });

  it("stops running when stop() is called", () => {
    const candles = [makeCandle(0)];
    const streamer = createMockStreamer(candles);
    const deps = createDeps(createTestStrategy(), streamer);

    const runner = new StrategyRunner(deps);
    expect(runner.isRunning()).toBe(false);

    // We can't test start() easily since it loops, but we can verify stop works
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });

  describe("warmup validation", () => {
    it("throws when received candles are below 50% of requested", async () => {
      // Request 10 bars but only get 2 (< ceil(10 * 0.5) = 5)
      const candles = [makeCandle(0), makeCandle(1)];
      const streamer = createMockStreamer(candles);
      const deps = createDeps(createTestStrategy(), streamer);
      deps.config = { ...config, warmupBars: 10 };

      const runner = new StrategyRunner(deps);
      await expect(runner.warmup()).rejects.toThrow(/Insufficient warmup data/);
    });

    it("succeeds when candles meet minimum 50% threshold", async () => {
      // Request 10 bars, get 5 (= ceil(10 * 0.5))
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const deps = createDeps(createTestStrategy(), streamer);
      deps.config = { ...config, warmupBars: 10 };

      const runner = new StrategyRunner(deps);
      await expect(runner.warmup()).resolves.toBeUndefined();
    });
  });

  describe("staleness and lastCandleAt", () => {
    it("forwards stale events from streamer to onStaleData", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const onStaleData = vi.fn();
      const deps = createDeps(createTestStrategy(), streamer);
      deps.onStaleData = onStaleData;

      const runner = new StrategyRunner(deps);
      await runner.warmup();
      runner.start();

      // Simulate stale event from streamer
      streamer.emit("stale", { lastCandleAt: 1000, silentMs: 5000 });

      expect(onStaleData).toHaveBeenCalledOnce();
      expect(onStaleData).toHaveBeenCalledWith({ lastCandleAt: 1000, silentMs: 5000 });

      runner.stop();
    });

    it("tracks lastCandleAt from warmup candles", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const deps = createDeps(createTestStrategy(), streamer);

      const runner = new StrategyRunner(deps);
      await runner.warmup();

      // After warmup, lastCandleAt should be the last warmup candle's timestamp
      expect(runner.getLastCandleAt()).toBe(candles[4].t);
    });

    it("tracks lastCandleAt from processed candles", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const deps = createDeps(createTestStrategy(), streamer);

      const runner = new StrategyRunner(deps);
      await runner.warmup();

      const newCandle = makeCandle(5);
      streamer.addCandle(newCandle);
      await runner.tick();

      expect(runner.getLastCandleAt()).toBe(newCandle.t);
    });
  });
});
