import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { StrategyRunner, type StrategyRunnerDeps } from "./strategy-runner.js";
import { clearPendingCoins } from "./handle-signal.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { Strategy, Candle, Signal, StrategyContext } from "@breaker/backtest";
import type { ExchangeConfig } from "../types/config.js";

const config: ExchangeConfig = {
  mode: "testnet",
  port: 3200,
  gatewayUrl: "http://localhost:3100",
  coins: [
    { coin: "BTC", leverage: 5, strategies: [{ name: "donchian-adx", interval: "15m", warmupBars: 5, autoTradingEnabled: true }] },
  ],
  dataSource: "binance",
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
    coin: "BTC",
    leverage: 5,
    interval: "15m",
    warmupBars: 5,
    autoTradingEnabled: true,
    strategy,
    strategyConfigName: "donchian-adx",
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
        getOrderStatus: vi.fn().mockResolvedValue(null),
        getAccountEquity: vi.fn().mockResolvedValue(1000),
        getAccountState: vi.fn().mockResolvedValue({ accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0, spotBalances: [] }),
        getMidPrice: vi.fn().mockResolvedValue(null),
      },
      store,
      eventLog: { append: vi.fn() },
      alertsClient: { notifyPositionOpened: vi.fn(), notifyTrailingSlMoved: vi.fn(), sendText: vi.fn() },
      positionBook,
    },
  };
}

beforeEach(() => {
  clearPendingCoins();
});

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

  it("does not broadcast candle (broadcast moved to daemon level)", async () => {
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

    // onNewCandle should NOT be called from tick() — broadcast is handled at daemon level
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

  it("places trailing SL order when level is more protective than fixed SL (long)", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    // getExitLevel returns level above fixed SL (94200 in signal is entry-1000)
    let exitLevelCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitLevelCall++;
      return exitLevelCall === 1 ? 94500 : 94800;
    });
    const deps = createDeps(strategy, streamer);
    // placeStopOrder: first call is from handleSignal (fixed SL), subsequent from trailing
    const placeStopOrder = deps.signalHandlerDeps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>;
    placeStopOrder
      .mockResolvedValueOnce({ orderId: "HL-SL-FIXED", status: "placed" })  // fixed SL
      .mockResolvedValueOnce({ orderId: "100", status: "placed" })   // first trailing
      .mockResolvedValueOnce({ orderId: "101", status: "placed" });  // second trailing

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Tick 1: open position (signal stopLoss = entry - 1000)
    streamer.addCandle(makeCandle(5));
    await runner.tick();
    const pos = deps.positionBook.get("BTC")!;
    expect(pos.stopLoss).toBeLessThan(94500); // fixed SL is below trailing level

    // Tick 2: first exit level (94500) — more protective than fixed SL → place trailing
    streamer.addCandle(makeCandle(6));
    await runner.tick();
    expect(placeStopOrder).toHaveBeenCalledTimes(2); // fixed + first trailing
    expect(deps.positionBook.get("BTC")!.trailingStopLoss).toBe(94500);

    // Tick 3: exit level moved up (94800) → place new, cancel old
    streamer.addCandle(makeCandle(7));
    await runner.tick();
    expect(placeStopOrder).toHaveBeenCalledTimes(3);
    expect(deps.signalHandlerDeps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 100);
    expect(deps.positionBook.get("BTC")!.trailingStopLoss).toBe(94800);
  });

  it("does not place trailing SL when level <= fixed SL (long)", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    // getExitLevel returns a level BELOW the fixed SL — not more protective
    strategy.getExitLevel = vi.fn(() => 93000);
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    streamer.addCandle(makeCandle(6));
    await runner.tick();

    // Only 1 call: the fixed SL from handleSignal
    expect(deps.signalHandlerDeps.hlClient.placeStopOrder).toHaveBeenCalledTimes(1);
    expect(deps.positionBook.get("BTC")!.trailingStopLoss).toBeNull();
  });

  it("logs error and continues when trailing SL placement fails", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    strategy.getExitLevel = vi.fn(() => 94500);
    const deps = createDeps(strategy, streamer);
    const placeStopOrder = deps.signalHandlerDeps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>;
    placeStopOrder
      .mockResolvedValueOnce({ orderId: "HL-SL-FIXED", status: "placed" })
      .mockRejectedValueOnce(new Error("Exchange error"));

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // Trailing SL placement fails — should NOT throw, position still protected by fixed SL
    streamer.addCandle(makeCandle(6));
    await runner.tick();
    expect(deps.positionBook.get("BTC")!.trailingStopLoss).toBeNull();
  });

  it("logs warning when cancel of old trailing SL fails", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);
    let exitLevelCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitLevelCall++;
      return exitLevelCall === 1 ? 94500 : 94800;
    });
    const deps = createDeps(strategy, streamer);
    const placeStopOrder = deps.signalHandlerDeps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>;
    placeStopOrder
      .mockResolvedValueOnce({ orderId: "HL-SL-FIXED", status: "placed" })
      .mockResolvedValueOnce({ orderId: "100", status: "placed" })
      .mockResolvedValueOnce({ orderId: "101", status: "placed" });
    (deps.signalHandlerDeps.hlClient.cancelOrder as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Cancel failed"));

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    streamer.addCandle(makeCandle(6));
    await runner.tick();

    // Even if cancel fails, new trailing SL was placed successfully
    streamer.addCandle(makeCandle(7));
    await runner.tick();
    expect(deps.positionBook.get("BTC")!.trailingStopLoss).toBe(94800);
  });

  it("recovers trailingSlOid from SQLite on warmup", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    let exitCall = 0;
    strategy.getExitLevel = vi.fn(() => {
      exitCall++;
      return exitCall === 1 ? 94500 : 94800; // warmup=94500, tick=94800
    });
    const deps = createDeps(strategy, streamer);

    // Pre-populate a position and a trailing-sl order in SQLite
    deps.positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      liquidationPx: null,
      trailingStopLoss: 94500,
      leverage: null,
      openedAt: "2024-01-01T00:00:00Z",
      signalId: 1,
    });
    deps.signalHandlerDeps.store.insertSignal({
      alert_id: "warm-001", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: "donchian-adx",
    });
    deps.signalHandlerDeps.store.insertOrder({
      signal_id: 1, hl_order_id: "200", coin: "BTC", side: "sell",
      size: 0.01, price: 94500, order_type: "stop", tag: "trailing-sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Now simulate trailing SL moving: should cancel old oid=200
    const placeStopOrder = deps.signalHandlerDeps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>;
    placeStopOrder.mockResolvedValueOnce({ orderId: "201", status: "placed" });

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // The old trailing SL (oid 200) should be cancelled
    expect(deps.signalHandlerDeps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 200);
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
      deps.warmupBars = 10;

      const runner = new StrategyRunner(deps);
      await expect(runner.warmup()).rejects.toThrow(/Insufficient warmup data/);
    });

    it("succeeds when candles meet minimum 50% threshold", async () => {
      // Request 10 bars, get 5 (= ceil(10 * 0.5))
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const deps = createDeps(createTestStrategy(), streamer);
      deps.warmupBars = 10;

      const runner = new StrategyRunner(deps);
      await expect(runner.warmup()).resolves.toBeUndefined();
    });
  });

  it("passes correct entryBarIndex to shouldExit based on position openedAt", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy(5);

    // Capture the context passed to shouldExit to verify entryBarIndex
    let capturedCtx: StrategyContext | null = null;
    vi.mocked(strategy.shouldExit!).mockImplementation((ctx: StrategyContext) => {
      capturedCtx = ctx;
      return null;
    });

    const deps = createDeps(strategy, streamer);
    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Open position on bar 5
    streamer.addCandle(makeCandle(5));
    await runner.tick();
    expect(deps.positionBook.count()).toBe(1);

    // Tick with position open — shouldExit should receive entryBarIndex near 5, not 0
    streamer.addCandle(makeCandle(6));
    await runner.tick();
    expect(capturedCtx).not.toBeNull();
    // Position was opened at candle 5's timestamp; entryBarIndex should be 5
    expect(capturedCtx!.positionEntryBarIndex).toBe(5);
  });

  it("does not false-timeout position opened recently with many warmup candles", async () => {
    // Simulate realistic scenario: 200 warmup candles, position opened 3 bars ago.
    // Position must exist BEFORE warmup so the runner assumes ownership (sets entryBarIndex).
    const candles = Array.from({ length: 200 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, streamer);
    deps.warmupBars = 200;

    // Open position before warmup (simulates restart with existing position)
    const entryCandle = candles[198];
    deps.positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: entryCandle.c,
      size: 0.01,
      stopLoss: entryCandle.c - 1000,
      takeProfits: [],
      liquidationPx: null,
      trailingStopLoss: null,
      leverage: null,
      openedAt: new Date(entryCandle.t).toISOString(),
    });

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // shouldExit should get entryBarIndex=198, barsInTrade=2 (not 200!)
    let capturedCtx: StrategyContext | null = null;
    vi.mocked(strategy.shouldExit!).mockImplementation((ctx: StrategyContext) => {
      capturedCtx = ctx;
      return null;
    });

    streamer.addCandle(makeCandle(200));
    await runner.tick();

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.positionEntryBarIndex).toBe(198);
    // barsInTrade = 200 - 198 = 2 → no timeout
  });

  it("skips exit check when entryBarIndex is null (position opened by another runner)", async () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    const streamer = createMockStreamer(candles);
    const strategy = createTestStrategy();
    const deps = createDeps(strategy, streamer);

    const runner = new StrategyRunner(deps);
    await runner.warmup();

    // Another runner opened a position for BTC — this runner's entryBarIndex is null
    deps.positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      liquidationPx: null,
      trailingStopLoss: null,
      leverage: 5,
      openedAt: new Date().toISOString(),
      signalId: 1,
    });

    streamer.addCandle(makeCandle(5));
    await runner.tick();

    // shouldExit should NOT be called because this runner doesn't own the position
    expect(strategy.shouldExit).not.toHaveBeenCalled();
    // onCandle should NOT be called either (position exists → no entry check)
    expect(strategy.onCandle).not.toHaveBeenCalled();
  });

  describe("warmup auto-correction via requiredWarmup", () => {
    it("auto-corrects warmup when strategy requires more bars than configured", async () => {
      const candles = Array.from({ length: 100 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const strategy = createTestStrategy();
      // Strategy requires 72 source bars (1h: 15 on 15m = 15*4*1.2 = 72)
      strategy.requiredWarmup = { "1h": 15 };

      const deps = createDeps(strategy, streamer);
      deps.warmupBars = 5; // configured too low

      const runner = new StrategyRunner(deps);
      await runner.warmup();

      // Streamer should be called with auto-corrected value (72), not configured (5)
      expect(streamer.warmup).toHaveBeenCalledWith(72);
    });

    it("keeps configured warmup when it exceeds strategy minimum", async () => {
      const candles = Array.from({ length: 200 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const strategy = createTestStrategy();
      strategy.requiredWarmup = { source: 22, "1h": 15 }; // min = 72

      const deps = createDeps(strategy, streamer);
      deps.warmupBars = 200; // configured is already sufficient

      const runner = new StrategyRunner(deps);
      await runner.warmup();

      expect(streamer.warmup).toHaveBeenCalledWith(200);
    });

    it("uses configured warmup when no requiredWarmup is set", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);
      const strategy = createTestStrategy();
      // No requiredWarmup

      const deps = createDeps(strategy, streamer);
      deps.warmupBars = 5;

      const runner = new StrategyRunner(deps);
      await runner.warmup();

      expect(streamer.warmup).toHaveBeenCalledWith(5);
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

  describe("indicator cache refresh", () => {
    it("re-inits strategy caches before each onCandle so new candles get valid indicators", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);

      // Strategy that caches close prices during init; onCandle returns null
      // if cache doesn't cover the current index (mimics real EMA/RSI caching).
      let cache: number[] | null = null;
      const strategy: Strategy = {
        name: "cache-test",
        params: {},
        init: vi.fn((cs: Candle[]) => {
          cache = cs.map((c) => c.c);
        }),
        onCandle: vi.fn((ctx: StrategyContext) => {
          if (!cache || ctx.index >= cache.length) return null;
          if (ctx.index === 5) {
            return {
              direction: "long" as const,
              entryPrice: ctx.currentCandle.c,
              stopLoss: ctx.currentCandle.c - 1000,
              takeProfits: [],
              comment: "Cache-dependent signal",
            };
          }
          return null;
        }),
        shouldExit: vi.fn().mockReturnValue(null),
      };

      const deps = createDeps(strategy, streamer);
      const runner = new StrategyRunner(deps);
      await runner.warmup();

      expect(strategy.init).toHaveBeenCalledOnce();

      // New candle at index 5 — beyond the original warmup cache range
      streamer.addCandle(makeCandle(5));
      await runner.tick();

      // init must be re-called to extend caches before onCandle evaluation
      expect(strategy.init).toHaveBeenCalledTimes(2);
      // Signal should fire because cache now covers index 5
      expect(deps.positionBook.count()).toBe(1);
    });

    it("refreshes stale cache when warmup candle closes with different price", async () => {
      // Simulate: warmup includes in-progress candle with partial close=95240.
      // Candle then closes at 95300, changing the signal condition.
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));

      // Strategy signals long only when cached close at index 4 > 95250
      let cache: number[] | null = null;
      const strategy: Strategy = {
        name: "stale-cache-test",
        params: {},
        init: vi.fn((cs: Candle[]) => {
          cache = cs.map((c) => c.c);
        }),
        onCandle: vi.fn((ctx: StrategyContext) => {
          if (!cache || ctx.index >= cache.length) return null;
          // Signal fires only when the cached close exceeds threshold
          if (cache[ctx.index] > 95250) {
            return {
              direction: "long" as const,
              entryPrice: ctx.currentCandle.c,
              stopLoss: ctx.currentCandle.c - 1000,
              takeProfits: [],
              comment: "Stale-cache signal",
            };
          }
          return null;
        }),
        shouldExit: vi.fn().mockReturnValue(null),
      };

      const streamer = createMockStreamer(candles);
      const deps = createDeps(strategy, streamer);
      const runner = new StrategyRunner(deps);
      await runner.warmup();

      // Warmup cached candle[4].c = 95240 (below threshold). Now simulate
      // the candle closing with a higher price — streamer updates in place.
      candles[4] = { ...candles[4], c: 95300 };

      // tick() won't fire because lastCandleAt === candles[4].t; use a new candle.
      streamer.addCandle(makeCandle(5));
      // Adjust: strategy should signal on bar 5 using refreshed cache at bar 5.
      // With the re-init, cache[5] = makeCandle(5).c = 95250 — still at boundary,
      // but the updated candle[4].c = 95300 is now in the cache too.
      // Let's make the strategy signal on index 4 being > 95250 evaluated at index 5:
      vi.mocked(strategy.onCandle).mockImplementation((ctx: StrategyContext) => {
        if (!cache || cache.length <= 4) return null;
        // Use the refreshed cache value at index 4 (was 95240, now 95300)
        if (cache[4] > 95250 && ctx.index === 5) {
          return {
            direction: "long" as const,
            entryPrice: ctx.currentCandle.c,
            stopLoss: ctx.currentCandle.c - 1000,
            takeProfits: [],
            comment: "Refreshed-cache signal",
          };
        }
        return null;
      });

      await runner.tick();

      // Without re-init, cache[4] would still be 95240 (no signal).
      // With re-init, cache[4] is 95300 (signal fires).
      expect(deps.positionBook.count()).toBe(1);
    });

    it("re-inits before shouldExit so exit checks use fresh indicators", async () => {
      const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i));
      const streamer = createMockStreamer(candles);

      let initCount = 0;
      const strategy: Strategy = {
        name: "exit-cache-test",
        params: {},
        init: vi.fn(() => { initCount++; }),
        onCandle: vi.fn().mockReturnValue(null),
        shouldExit: vi.fn().mockReturnValue(null),
      };

      const deps = createDeps(strategy, streamer);
      const runner = new StrategyRunner(deps);
      await runner.warmup();

      // Open position so shouldExit path runs
      streamer.addCandle(makeCandle(5));
      await runner.tick(); // no signal, no position

      // Manually open a position to trigger shouldExit path
      deps.positionBook.open({
        coin: "BTC",
        direction: "long",
        entryPrice: 95000,
        size: 0.01,
        stopLoss: 94000,
        takeProfits: [],
        liquidationPx: null,
        trailingStopLoss: null,
        leverage: 5,
        openedAt: new Date().toISOString(),
        signalId: 1,
      });

      const initCountBefore = initCount;
      streamer.addCandle(makeCandle(6));
      await runner.tick();

      // init must have been called again for the exit evaluation
      expect(initCount).toBeGreaterThan(initCountBefore);
    });
  });
});
