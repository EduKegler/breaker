import { describe, it, expect } from "vitest";
import { signalToIntent } from "./signal-to-intent.js";
import type { Signal } from "@breaker/backtest";
import type { Sizing } from "../types/config.js";

const sizing: Sizing = {
  mode: "risk",
  riskPerTradeUsd: 10,
  cashPerTrade: 100,
};

describe("signalToIntent", () => {
  it("converts long signal with risk sizing", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [{ price: 110, pctOfPosition: 0.5 }],
      comment: "Donchian breakout",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing);

    expect(intent.coin).toBe("BTC");
    expect(intent.side).toBe("buy");
    expect(intent.direction).toBe("long");
    expect(intent.size).toBe(2); // 10 / (100 - 95) = 2
    expect(intent.entryPrice).toBe(100);
    expect(intent.stopLoss).toBe(95);
    expect(intent.notionalUsd).toBe(200); // 2 * 100
    expect(intent.takeProfits).toHaveLength(1);
    expect(intent.entryType).toBe("gtc");
  });

  it("converts short signal", () => {
    const signal: Signal = {
      direction: "short",
      entryPrice: 100,
      stopLoss: 105,
      takeProfits: [],
      comment: "Short entry",
    };

    const intent = signalToIntent(signal, 100, "ETH", sizing);

    expect(intent.side).toBe("sell");
    expect(intent.direction).toBe("short");
    expect(intent.size).toBe(2); // 10 / 5
  });

  it("uses currentPrice when entryPrice is null (market order) and sets ioc", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: null,
      stopLoss: 90,
      takeProfits: [],
      comment: "Market entry",
    };

    const intent = signalToIntent(signal, 95, "BTC", sizing);

    expect(intent.entryPrice).toBe(95);
    expect(intent.size).toBe(2); // 10 / (95 - 90) = 2
    expect(intent.entryType).toBe("ioc");
  });

  it("uses cash sizing mode", () => {
    const cashSizing: Sizing = { mode: "cash", riskPerTradeUsd: 10, cashPerTrade: 500 };
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "Cash entry",
    };

    const intent = signalToIntent(signal, 100, "BTC", cashSizing);

    expect(intent.size).toBe(5); // 500 / 100
  });

  it("returns zero size when entryPrice is 0 in cash mode (division by zero guard)", () => {
    const cashSizing: Sizing = { mode: "cash", riskPerTradeUsd: 10, cashPerTrade: 500 };
    const signal: Signal = {
      direction: "long",
      entryPrice: 0,
      stopLoss: -5,
      takeProfits: [],
      comment: "Zero entry",
    };

    const intent = signalToIntent(signal, 0, "BTC", cashSizing);

    expect(intent.size).toBe(0); // cashPerTrade / 0 → guarded to 0
    expect(intent.notionalUsd).toBe(0);
  });

  it("uses ioc for breakout moduleType even with entryPrice", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "Donchian breakout",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing, "breakout");

    expect(intent.entryType).toBe("ioc");
  });

  it("uses ioc for trend-following moduleType even with entryPrice", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "Trend entry",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing, "trend-following");

    expect(intent.entryType).toBe("ioc");
  });

  it("uses gtc for mean-reversion moduleType with entryPrice", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "Keltner entry",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing, "mean-reversion");

    expect(intent.entryType).toBe("gtc");
  });

  it("uses gtc for pullback moduleType with entryPrice", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "Pullback entry",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing, "pullback");

    expect(intent.entryType).toBe("gtc");
  });

  it("falls back to entryPrice-based logic when moduleType is undefined", () => {
    const withEntry: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [],
      comment: "With entry",
    };
    const withoutEntry: Signal = {
      direction: "long",
      entryPrice: null,
      stopLoss: 90,
      takeProfits: [],
      comment: "Without entry",
    };

    expect(signalToIntent(withEntry, 100, "BTC", sizing).entryType).toBe("gtc");
    expect(signalToIntent(withoutEntry, 95, "BTC", sizing).entryType).toBe("ioc");
  });

  it("returns zero size when stopDist is zero in risk mode", () => {
    const signal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 100,
      takeProfits: [],
      comment: "Zero SL distance",
    };

    const intent = signalToIntent(signal, 100, "BTC", sizing);

    expect(intent.size).toBe(0);
  });
});
