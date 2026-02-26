import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, resolveAssetCriteria, resolveDataConfig, resolveDateRange } from "./config.js";

function writeTempConfig(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-test-"));
  const filePath = path.join(dir, "breaker-config.json");
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

describe("loadConfig", () => {
  it("parses a valid config with all fields", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 150, minPF: 1.25, maxDD: 12, minWR: 20, minAvgR: 0.15, minTradesForFilter: 6 },
      rollbackThreshold: 0.15,
      modelRouting: { optimize: "claude-sonnet-4-6", fix: "claude-haiku-4-5-20251001", plan: "claude-opus-4-6" },
      assetClasses: {
        "crypto-major": { minPF: 1.25, maxDD: 12, minTrades: 150, minWR: 20, minAvgR: 0.15 },
      },
      strategyProfiles: { breakout: {} },
      guardrails: { maxRiskTradeUsd: 25, protectedFields: ["commission_value"] },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {
              coin: "BTC",
              dataSource: "coinbase-perp",
              interval: "15m",
              strategyFactory: "createDonchianAdx",
              dateRange: { start: "2025-05-24", end: "2026-02-24" },
            },
          },
        },
      },
    });

    const config = loadConfig(configPath);
    expect(config.criteria.minTrades).toBe(150);
    expect(config.criteria.minPF).toBe(1.25);
    expect(config.modelRouting.optimize).toBe("claude-sonnet-4-6");
    expect(config.guardrails.maxRiskTradeUsd).toBe(25);
    expect(config.assets.BTC.class).toBe("crypto-major");
    expect(config.assetClasses["crypto-major"]?.minPF).toBe(1.25);
  });

  it("applies defaults for missing optional fields", () => {
    const configPath = writeTempConfig({});
    const config = loadConfig(configPath);

    expect(config.criteria).toEqual({});
    expect(config.rollbackThreshold).toBeUndefined();
    expect(config.modelRouting.optimize).toBe("claude-sonnet-4-6");
    expect(config.guardrails.maxRiskTradeUsd).toBe(25);
    expect(config.assets).toEqual({});
    expect(config.assetClasses).toEqual({});
  });

  it("throws ZodError for invalid types", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: "not-a-number" },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws for nonexistent file", () => {
    expect(() => loadConfig("/tmp/nonexistent-breaker-config-xyz.json")).toThrow();
  });

  it("rejects rollbackThreshold outside 0-1 range", () => {
    const configPath = writeTempConfig({ rollbackThreshold: 1.5 });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects asset referencing undefined class", () => {
    const configPath = writeTempConfig({
      assets: { BTC: { class: "nonexistent" } },
      assetClasses: { "crypto-major": {} },
    });
    expect(() => loadConfig(configPath)).toThrow(/nonexistent/);
  });

  it("accepts strategy entries with new fields", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {
              coin: "BTC",
              dataSource: "coinbase-perp",
              interval: "15m",
              strategyFactory: "createDonchianAdx",
              dateRange: { start: "2025-05-24", end: "2026-02-24" },
            },
          },
        },
      },
    });
    const config = loadConfig(configPath);
    const entry = config.assets.BTC.strategies.breakout;
    expect(entry.coin).toBe("BTC");
    expect(entry.dataSource).toBe("coinbase-perp");
    expect(entry.strategyFactory).toBe("createDonchianAdx");
  });

  it("accepts legacy string dateRange format", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: { dateRange: "custom:2025-05-24:2026-02-24" },
          },
        },
      },
    });
    const config = loadConfig(configPath);
    expect(config.assets.BTC.strategies.breakout.dateRange).toBe("custom:2025-05-24:2026-02-24");
  });
});

describe("resolveAssetCriteria", () => {
  it("merges global criteria with asset class overrides", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2, maxDD: 20, minWR: 0 },
      assetClasses: { "crypto-major": { minPF: 1.25, maxDD: 12, minTrades: 150 } },
      assets: { BTC: { class: "crypto-major" } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC");

    expect(criteria.minPF).toBe(1.25);
    expect(criteria.maxDD).toBe(12);
    expect(criteria.minTrades).toBe(150);
    expect(criteria.minWR).toBe(0);
  });

  it("returns global criteria for unknown asset", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2 },
      assets: {},
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "UNKNOWN");

    expect(criteria.minTrades).toBe(100);
    expect(criteria.minPF).toBe(1.2);
  });

  it("merges 3 layers: global → class → strategy profile", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2, maxDD: 20, minWR: 30 },
      assetClasses: { "crypto-major": { minPF: 1.8, maxDD: 4, minTrades: 70 } },
      strategyProfiles: { "mean-reversion": { minPF: 1.3, maxDD: 8, minWR: 50, maxFreeVariables: 5, maxIterations: 15 } },
      assets: { BTC: { class: "crypto-major", strategies: { "mean-reversion": { profile: "mean-reversion" } } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "mean-reversion");

    expect(criteria.minPF).toBe(1.3);
    expect(criteria.maxDD).toBe(8);
    expect(criteria.minWR).toBe(50);
    expect(criteria.maxFreeVariables).toBe(5);
    expect(criteria.maxIterations).toBe(15);
    expect(criteria.minTrades).toBe(70);
  });
});

describe("resolveDataConfig", () => {
  it("returns strategy-level data config", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {
              coin: "BTC",
              dataSource: "coinbase-perp",
              interval: "15m",
              strategyFactory: "createDonchianAdx",
            },
          },
        },
      },
    });

    const config = loadConfig(configPath);
    const dc = resolveDataConfig(config, "BTC", "breakout");

    expect(dc.coin).toBe("BTC");
    expect(dc.dataSource).toBe("coinbase-perp");
    expect(dc.interval).toBe("15m");
    expect(dc.strategyFactory).toBe("createDonchianAdx");
  });

  it("returns defaults for unknown asset", () => {
    const configPath = writeTempConfig({ assets: {} });
    const config = loadConfig(configPath);
    const dc = resolveDataConfig(config, "UNKNOWN");

    expect(dc.coin).toBe("UNKNOWN");
    expect(dc.dataSource).toBe("coinbase-perp");
    expect(dc.interval).toBe("15m");
    expect(dc.strategyFactory).toBe("createDonchianAdx");
  });
});

describe("resolveDateRange", () => {
  it("returns epoch ms for object dateRange", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {
              dateRange: { start: "2025-05-24", end: "2026-02-24" },
            },
          },
        },
      },
    });

    const config = loadConfig(configPath);
    const dr = resolveDateRange(config, "BTC", "breakout");

    expect(dr.startTime).toBe(new Date("2025-05-24T00:00:00Z").getTime());
    expect(dr.endTime).toBe(new Date("2026-02-24T23:59:59.999Z").getTime());
  });

  it("parses legacy custom string format", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: { dateRange: "custom:2025-08-01:2026-02-01" },
          },
        },
      },
    });

    const config = loadConfig(configPath);
    const dr = resolveDateRange(config, "BTC", "breakout");

    expect(dr.startTime).toBe(new Date("2025-08-01T00:00:00Z").getTime());
    expect(dr.endTime).toBe(new Date("2026-02-01T23:59:59.999Z").getTime());
  });

  it("falls back to lastN when no strategy dateRange", () => {
    const configPath = writeTempConfig({
      dateRange: "last90",
      assets: {},
    });

    const config = loadConfig(configPath);
    const dr = resolveDateRange(config, "UNKNOWN");

    expect(dr.endTime).toBeCloseTo(Date.now(), -4);
    expect(dr.startTime).toBeLessThan(dr.endTime);
    const days = (dr.endTime - dr.startTime) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(90, 0);
  });

  it("defaults to last365 when no config dateRange", () => {
    const configPath = writeTempConfig({ assets: {} });
    const config = loadConfig(configPath);
    const dr = resolveDateRange(config, "UNKNOWN");

    const days = (dr.endTime - dr.startTime) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(365, 0);
  });
});

describe("coreParameters and designChecklist", () => {
  it("parses strategy profile with coreParameters and designChecklist", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: {
        breakout: {
          minPF: 1.6,
          coreParameters: [{ name: "dcSlow", min: 30, max: 60, step: 5 }],
          designChecklist: ["Donchian channel entry"],
        },
      },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: {} } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "breakout");
    expect(criteria.coreParameters).toEqual([{ name: "dcSlow", min: 30, max: 60, step: 5 }]);
    expect(criteria.designChecklist).toEqual(["Donchian channel entry"]);
  });

  it("rejects invalid coreParameter (negative step)", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: {
        breakout: {
          coreParameters: [{ name: "dcSlow", min: 30, max: 60, step: -5 }],
        },
      },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: {} } } },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });
});
