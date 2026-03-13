import { describe, it, expect } from "vitest";
import { resolveEffectiveStrategies } from "./resolve-effective-strategies.js";
import type { ExchangeConfig } from "../types/config.js";
import type { DeployedStrategyEntry } from "@breaker/backtest/deployed";

function makeConfig(overrides: Partial<ExchangeConfig> = {}): ExchangeConfig {
  return {
    mode: "testnet",
    port: 3200,
    gatewayUrl: "http://localhost:3100",
    coins: [{ coin: "BTC", leverage: 5 }],
    strategyOverrides: {},
    dataSource: "binance",
    marginType: "isolated",
    guardrails: {
      maxNotionalUsd: 5000,
      maxLeverage: 5,
      maxOpenPositions: 1,
      maxDailyLossR: 2,
      maxTradesPerDay: 5,
      cooldownBars: 2,
      volSpikeThresholdPct: 1.5,
      volSpikeLookbackBars: 4,
      volSpikeCooldownBars: 4,
    },
    sizing: { mode: "risk", riskPerTradeUsd: 10, cashPerTrade: 100 },
    entrySlippageBps: 50,
    dryRun: false,
    logLevels: {},
    ...overrides,
  };
}

const manifest: DeployedStrategyEntry[] = [
  { factoryName: "createBreakoutStrat", strategyName: "breakout-strat", coin: "BTC", interval: "15m", moduleType: "breakout" },
  { factoryName: "createTrendStrat", strategyName: "trend-strat", coin: "BTC", interval: "4h", moduleType: "trend-following" },
  { factoryName: "createPullbackStrat", strategyName: "pullback-strat", coin: "SOL", interval: "15m", moduleType: "pullback" },
];

describe("resolveEffectiveStrategies", () => {
  it("discovers all strategies for a coin from the manifest", () => {
    const config = makeConfig({
      coins: [{ coin: "BTC", leverage: 5 }],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      coin: "BTC",
      name: "breakout-strat",
      interval: "15m",
      moduleType: "breakout",
      leverage: 5,
      autoTradingEnabled: false,
    });
    expect(result[1]).toEqual({
      coin: "BTC",
      name: "trend-strat",
      interval: "4h",
      moduleType: "trend-following",
      leverage: 5,
      autoTradingEnabled: false,
    });
  });

  it("applies strategyOverrides to autoTradingEnabled", () => {
    const config = makeConfig({
      coins: [{ coin: "BTC", leverage: 5 }],
      strategyOverrides: {
        "breakout-strat": { autoTradingEnabled: true },
      },
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result[0].autoTradingEnabled).toBe(true);
    expect(result[1].autoTradingEnabled).toBe(false);
  });

  it("filters manifest by coin — only returns strategies for configured coins", () => {
    const config = makeConfig({
      coins: [{ coin: "SOL", leverage: 3 }],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pullback-strat");
    expect(result[0].coin).toBe("SOL");
    expect(result[0].leverage).toBe(3);
  });

  it("returns empty when coin has no deployed strategies", () => {
    const config = makeConfig({
      coins: [{ coin: "ETH", leverage: 2 }],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result).toHaveLength(0);
  });

  it("uses leverage from coin config, not manifest", () => {
    const config = makeConfig({
      coins: [
        { coin: "BTC", leverage: 10 },
        { coin: "SOL", leverage: 3 },
      ],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result.filter(s => s.coin === "BTC").every(s => s.leverage === 10)).toBe(true);
    expect(result.filter(s => s.coin === "SOL").every(s => s.leverage === 3)).toBe(true);
  });

  it("defaults autoTradingEnabled to false for safety", () => {
    const config = makeConfig({
      coins: [{ coin: "BTC", leverage: 5 }],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    for (const es of result) {
      expect(es.autoTradingEnabled).toBe(false);
    }
  });

  it("handles empty manifest gracefully", () => {
    const config = makeConfig({
      coins: [{ coin: "BTC", leverage: 5 }],
    });

    const result = resolveEffectiveStrategies(config, []);

    expect(result).toHaveLength(0);
  });

  it("handles multiple coins with strategies from manifest", () => {
    const config = makeConfig({
      coins: [
        { coin: "BTC", leverage: 5 },
        { coin: "SOL", leverage: 3 },
      ],
    });

    const result = resolveEffectiveStrategies(config, manifest);

    expect(result).toHaveLength(3);
    expect(result.filter(s => s.coin === "BTC")).toHaveLength(2);
    expect(result.filter(s => s.coin === "SOL")).toHaveLength(1);
  });
});
