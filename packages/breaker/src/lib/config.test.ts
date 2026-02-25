import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, resolveAssetCriteria, resolveChartUrl, resolveDateRange } from "./config.js";

function writeTempConfig(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-test-"));
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
      guardrails: { maxRiskTradeUsd: 25, protectedFields: ["commission_value"] },
      assets: { BTC: { class: "crypto-major", chartUrl: "https://example.com/btc" } },
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
    expect(() => loadConfig("/tmp/nonexistent-pine-config-xyz.json")).toThrow();
  });

  it("rejects invalid chartUrl (not a URL)", () => {
    const configPath = writeTempConfig({
      assets: { BTC: { class: "crypto-major", chartUrl: "not-a-url" } },
      assetClasses: { "crypto-major": {} },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects rollbackThreshold outside 0-1 range", () => {
    const configPath = writeTempConfig({ rollbackThreshold: 1.5 });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects asset referencing undefined class", () => {
    const configPath = writeTempConfig({
      assets: { BTC: { class: "nonexistent", chartUrl: "https://example.com" } },
      assetClasses: { "crypto-major": {} },
    });
    expect(() => loadConfig(configPath)).toThrow(/nonexistent/);
  });
});

describe("resolveAssetCriteria", () => {
  it("merges global criteria with asset class overrides", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2, maxDD: 20, minWR: 0 },
      assetClasses: { "crypto-major": { minPF: 1.25, maxDD: 12, minTrades: 150 } },
      assets: { BTC: { class: "crypto-major", chartUrl: "https://example.com" } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC");

    // Class overrides global
    expect(criteria.minPF).toBe(1.25);
    expect(criteria.maxDD).toBe(12);
    expect(criteria.minTrades).toBe(150);
    // Global preserved when class doesn't override
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
      assets: { BTC: { class: "crypto-major", strategies: { "mean-reversion": { chartUrl: "https://example.com", profile: "mean-reversion" } } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "mean-reversion");

    // Strategy profile overrides class
    expect(criteria.minPF).toBe(1.3);
    expect(criteria.maxDD).toBe(8);
    expect(criteria.minWR).toBe(50);
    // Strategy profile adds new fields
    expect(criteria.maxFreeVariables).toBe(5);
    expect(criteria.maxIterations).toBe(15);
    // Class overrides global when strategy doesn't override
    expect(criteria.minTrades).toBe(70);
  });

  it("empty strategy profile inherits from class", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2 },
      assetClasses: { "crypto-major": { minPF: 1.8, maxDD: 4 } },
      strategyProfiles: { breakout: {} },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com" } } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "breakout");

    // Empty profile doesn't override anything
    expect(criteria.minPF).toBe(1.8);
    expect(criteria.maxDD).toBe(4);
    expect(criteria.minTrades).toBe(100);
    expect(criteria.maxFreeVariables).toBeUndefined();
  });

  it("asset without strategy field only merges global + class", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2 },
      assetClasses: { "crypto-volatile": { minPF: 1.5, maxDD: 20 } },
      strategyProfiles: { breakout: { minPF: 2.0 } },
      assets: { SUI: { class: "crypto-volatile", chartUrl: "https://example.com" } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "SUI");

    // No strategy → no strategy profile merge
    expect(criteria.minPF).toBe(1.5);
    expect(criteria.maxDD).toBe(20);
    expect(criteria.minTrades).toBe(100);
  });

  it("falls back to legacy flat strategy field when no nested strategies match", () => {
    const configPath = writeTempConfig({
      criteria: { minTrades: 100, minPF: 1.2 },
      assetClasses: { "crypto-major": { minPF: 1.8 } },
      strategyProfiles: { "mean-reversion": { minPF: 1.3, maxDD: 8 } },
      assets: { BTC: { class: "crypto-major", strategy: "mean-reversion", chartUrl: "https://example.com" } },
    });

    const config = loadConfig(configPath);
    // No strategy arg → falls back to asset.strategy legacy field
    const criteria = resolveAssetCriteria(config, "BTC");

    expect(criteria.minPF).toBe(1.3); // from strategy profile
    expect(criteria.maxDD).toBe(8);   // from strategy profile
    expect(criteria.minTrades).toBe(100); // from global (class doesn't override)
  });
});

describe("resolveChartUrl", () => {
  it("returns nested strategy chartUrl when strategy provided", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: { breakout: { chartUrl: "https://example.com/btc-breakout" } },
        },
      },
    });

    const config = loadConfig(configPath);
    expect(resolveChartUrl(config, "BTC", "breakout")).toBe("https://example.com/btc-breakout");
  });

  it("falls back to legacy flat chartUrl", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: { class: "crypto-major", chartUrl: "https://example.com/btc-legacy" },
      },
    });

    const config = loadConfig(configPath);
    expect(resolveChartUrl(config, "BTC")).toBe("https://example.com/btc-legacy");
  });

  it("returns empty string for unknown asset", () => {
    const configPath = writeTempConfig({
      assets: {},
    });

    const config = loadConfig(configPath);
    expect(resolveChartUrl(config, "UNKNOWN")).toBe("");
  });

  it("falls back to legacy chartUrl when strategy not found in nested strategies", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          chartUrl: "https://example.com/btc-fallback",
          strategies: { breakout: { chartUrl: "https://example.com/btc-breakout" } },
        },
      },
    });

    const config = loadConfig(configPath);
    // Request unknown strategy → falls back to legacy chartUrl
    expect(resolveChartUrl(config, "BTC", "unknown-strat")).toBe("https://example.com/btc-fallback");
  });

  it("returns empty string when asset has no legacy chartUrl and strategy not found", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: { breakout: { chartUrl: "https://example.com/btc" } },
        },
      },
    });

    const config = loadConfig(configPath);
    // Request unknown strategy, no legacy chartUrl → empty string
    expect(resolveChartUrl(config, "BTC", "unknown-strat")).toBe("");
  });
});

describe("resolveDateRange", () => {
  it("returns per-strategy dateRange when set", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      dateRange: "last365",
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {
              chartUrl: "https://example.com/chart",
              dateRange: "custom:2025-08-01:2026-02-01",
            },
          },
        },
      },
    });
    const config = loadConfig(configPath);
    expect(resolveDateRange(config, "BTC", "breakout")).toBe("custom:2025-08-01:2026-02-01");
  });

  it("falls back to global dateRange when strategy has no override", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      dateRange: "last90",
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: { chartUrl: "https://example.com/chart" },
          },
        },
      },
    });
    const config = loadConfig(configPath);
    expect(resolveDateRange(config, "BTC", "breakout")).toBe("last90");
  });

  it("returns 'last365' when neither strategy nor global dateRange is set", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: { chartUrl: "https://example.com/chart" },
          },
        },
      },
    });
    const config = loadConfig(configPath);
    expect(resolveDateRange(config, "BTC", "breakout")).toBe("last365");
  });

  it("returns global default for unknown asset", () => {
    const configPath = writeTempConfig({
      dateRange: "all",
      assets: {},
    });
    const config = loadConfig(configPath);
    expect(resolveDateRange(config, "UNKNOWN")).toBe("all");
  });

  it("returns 'last365' for unknown asset with no global dateRange", () => {
    const configPath = writeTempConfig({ assets: {} });
    const config = loadConfig(configPath);
    expect(resolveDateRange(config, "UNKNOWN")).toBe("last365");
  });
});

describe("coreParameters and designChecklist", () => {
  it("parses strategy profile with coreParameters and designChecklist", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: {
        breakout: {
          minPF: 1.6,
          coreParameters: [
            { name: "dcSlow", min: 30, max: 60, step: 5 },
          ],
          designChecklist: ["Donchian channel entry"],
        },
      },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com" } } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "breakout");
    expect(criteria.coreParameters).toEqual([{ name: "dcSlow", min: 30, max: 60, step: 5 }]);
    expect(criteria.designChecklist).toEqual(["Donchian channel entry"]);
  });

  it("coreParameters and designChecklist are optional", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: { breakout: { minPF: 1.6 } },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com" } } } },
    });

    const config = loadConfig(configPath);
    const criteria = resolveAssetCriteria(config, "BTC", "breakout");
    expect(criteria.coreParameters).toBeUndefined();
    expect(criteria.designChecklist).toBeUndefined();
  });

  it("rejects invalid coreParameter (negative step)", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: {
        breakout: {
          coreParameters: [{ name: "dcSlow", min: 30, max: 60, step: -5 }],
        },
      },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com" } } } },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("rejects coreParameter with empty name", () => {
    const configPath = writeTempConfig({
      assetClasses: { "crypto-major": {} },
      strategyProfiles: {
        breakout: {
          coreParameters: [{ name: "", min: 30, max: 60, step: 5 }],
        },
      },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com" } } } },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe("resolveAssetCriteria — fallback branches", () => {
  it("returns empty class criteria when assetClass not in assetClasses map", () => {
    // Build config manually to bypass superRefine validation
    const config = {
      criteria: { minTrades: 100 },
      assetClasses: {},
      strategyProfiles: {},
      assets: { BTC: { class: "ghost-class", strategies: {} } },
    } as any;

    const criteria = resolveAssetCriteria(config, "BTC");
    // class "ghost-class" not in assetClasses → falls through to {}
    expect(criteria.minTrades).toBe(100);
  });

  it("returns empty strategy profile when profileName not in strategyProfiles map", () => {
    const config = {
      criteria: { minTrades: 100 },
      assetClasses: {},
      strategyProfiles: {},
      assets: { BTC: { class: "x", strategies: { breakout: { chartUrl: "https://x.com" } } } },
    } as any;

    // strategy "breakout" found in nested strategies, profile defaults to "breakout",
    // but "breakout" not in strategyProfiles → falls through to {}
    const criteria = resolveAssetCriteria(config, "BTC", "breakout");
    expect(criteria.minTrades).toBe(100);
  });
});
