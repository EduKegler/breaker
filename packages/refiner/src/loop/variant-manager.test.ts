import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  VariantManager,
  toCanonical,
  buildVariantId,
} from "./variant-manager.js";
import { buildFailureAnalysis } from "./variant-generator.js";

let tmpDir: string;
let strategyDir: string;
let mainStrategyFile: string;
let checkpointDir: string;
let paramHistoryFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variant-mgr-"));
  strategyDir = path.join(tmpDir, "strategies");
  fs.mkdirSync(strategyDir, { recursive: true });
  mainStrategyFile = path.join(strategyDir, "donchian-adx.ts");
  fs.writeFileSync(mainStrategyFile, "// seed strategy code", "utf8");
  checkpointDir = path.join(tmpDir, "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  paramHistoryFile = path.join(tmpDir, "parameter-history.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// toCanonical
// ---------------------------------------------------------------------------
describe("toCanonical", () => {
  it("maps M1 breakout KB candidates to short names", () => {
    expect(toCanonical("Donchian Channel")).toBe("donchian");
    expect(toCanonical("Bollinger Band squeeze release")).toBe("squeeze");
    expect(toCanonical("Opening Range Breakout (ORB)")).toBe("orb");
    expect(toCanonical("Range breakout")).toBe("range");
    expect(toCanonical("Volatility expansion")).toBe("expansion");
    expect(toCanonical("Breakout close")).toBe("close");
    expect(toCanonical("Retest entry")).toBe("retest");
    expect(toCanonical("ADX threshold")).toBe("adx");
    expect(toCanonical("RSI momentum")).toBe("rsi");
    expect(toCanonical("ATR trailing stop")).toBe("atr-trail");
    expect(toCanonical("Time-based timeout")).toBe("timeout");
    expect(toCanonical("Partial TP + trail")).toBe("partial-tp");
  });

  it("maps M2 mean-reversion KB candidates to short names", () => {
    expect(toCanonical("Bollinger Bands")).toBe("bollinger");
    expect(toCanonical("Keltner Channels")).toBe("keltner");
    expect(toCanonical("RSI(2)")).toBe("rsi2");
    expect(toCanonical("Williams %R")).toBe("williams");
    expect(toCanonical("Stochastic")).toBe("stochastic");
    expect(toCanonical("ADX threshold (low)")).toBe("adx-low");
    expect(toCanonical("Channel midline")).toBe("midline");
    expect(toCanonical("Catastrophic stop")).toBe("cat-stop");
  });

  it("maps M3 pullback KB candidates to short names", () => {
    expect(toCanonical("HH/HL structure")).toBe("hhhl");
    expect(toCanonical("ADX > threshold")).toBe("adx-high");
    expect(toCanonical("Fibonacci retracement")).toBe("fib");
    expect(toCanonical("EMA dynamic support")).toBe("ema-support");
    expect(toCanonical("9/30 pullback zone")).toBe("930");
    expect(toCanonical("RSI neutral reset")).toBe("rsi-reset");
    expect(toCanonical("Candle close beyond pullback extreme")).toBe("close-beyond");
    expect(toCanonical("Prior swing high/low")).toBe("swing");
    expect(toCanonical("Fibonacci extension")).toBe("fib-ext");
  });

  it("maps M4 trend-following KB candidates to short names", () => {
    expect(toCanonical("SuperTrend flip")).toBe("supertrend");
    expect(toCanonical("EMA crossover")).toBe("ema-cross");
    expect(toCanonical("Donchian channel breakout")).toBe("donchian-daily");
    expect(toCanonical("MACD crossover + HTF filter")).toBe("macd-htf");
    expect(toCanonical("Chandelier Exit")).toBe("chandelier");
    expect(toCanonical("EMA slope + price position")).toBe("ema-slope");
  });

  it("falls back to kebab-case for unknown components (max 3 segments)", () => {
    expect(toCanonical("My Custom Indicator")).toBe("my-custom-indicator");
    expect(toCanonical("MACD Histogram")).toBe("macd-histogram");
  });

  it("truncates long unknown names to 3 segments", () => {
    expect(toCanonical("Volume Spike vs SMA(vol,20) Timeout")).toBe("volume-spike-vs");
    expect(toCanonical("ATR Normalized N-bar Range Width Gate")).toBe("atr-normalized-n");
  });
});

// ---------------------------------------------------------------------------
// buildVariantId
// ---------------------------------------------------------------------------
describe("buildVariantId", () => {
  it("joins components in slot-priority order", () => {
    // Entry Signal (1) → Regime Filter (3) → Exit (5)
    const id = buildVariantId({
      "Exit": "Chandelier Exit",
      "Entry Signal": "Bollinger Band squeeze release",
      "Regime Filter": "ADX threshold",
    });
    expect(id).toBe("squeeze-adx-chandelier");
  });

  it("returns empty string for empty components", () => {
    expect(buildVariantId({})).toBe("");
  });

  it("handles unknown slot names alphabetically", () => {
    const id = buildVariantId({
      "Zebra Filter": "ZebraInd",
      "Alpha Signal": "AlphaInd",
    });
    expect(id).toBe("alphaind-zebraind");
  });

  it("known slots come before unknown slots", () => {
    const id = buildVariantId({
      "Custom Slot": "CustomInd",
      "Entry Signal": "Donchian Channel",
    });
    expect(id).toBe("donchian-customind");
  });

  it("truncates long IDs to max 60 chars with hash suffix", () => {
    const id = buildVariantId({
      "Entry Signal": "Volume Spike vs SMA(vol,20) Timeout at timeoutBars",
      "Entry Timing": "Narrow Range Breakout ATR Normalized N-bar Range Width Gate",
      "Regime Filter": "4H ADX 14 Consolidation Daily EMA 200 Directional",
      "Confirmation": "Volume Confirmation Relative to 20-period Average",
      "Exit": "ATR 14 1H StopMult Single TP at tpRR Risk",
    });
    expect(id.length).toBeLessThanOrEqual(60);
    // Should still be deterministic
    const id2 = buildVariantId({
      "Entry Signal": "Volume Spike vs SMA(vol,20) Timeout at timeoutBars",
      "Entry Timing": "Narrow Range Breakout ATR Normalized N-bar Range Width Gate",
      "Regime Filter": "4H ADX 14 Consolidation Daily EMA 200 Directional",
      "Confirmation": "Volume Confirmation Relative to 20-period Average",
      "Exit": "ATR 14 1H StopMult Single TP at tpRR Risk",
    });
    expect(id).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// VariantManager
// ---------------------------------------------------------------------------
describe("VariantManager", () => {
  describe("loadOrInit", () => {
    it("creates seed variant when no registry exists", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      const active = mgr.getActive();
      expect(active).not.toBeNull();
      expect(active!.id).toBe("donchian-adx");
      expect(active!.status).toBe("active");
      expect(active!.strategyFile).toBe(mainStrategyFile);
      expect(active!.checkpointDir).toBe(checkpointDir);
      expect(active!.components).toEqual({});
    });

    it("loads existing registry from disk", () => {
      // Create and save
      const mgr1 = new VariantManager(tmpDir, mainStrategyFile);
      mgr1.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr1.markPlateaued("test", 60, 150, 5, 10);
      mgr1.save();

      // Load in new instance
      const mgr2 = new VariantManager(tmpDir, mainStrategyFile);
      mgr2.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      expect(mgr2.getAll()).toHaveLength(1);
      expect(mgr2.getAll()[0].status).toBe("plateaued");
      expect(mgr2.getActive()).toBeNull();
    });
  });

  describe("getActive", () => {
    it("returns active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      expect(mgr.getActive()!.id).toBe("donchian-adx");
    });

    it("returns null when no active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);
      expect(mgr.getActive()).toBeNull();
    });
  });

  describe("markPlateaued", () => {
    it("marks active variant as plateaued and clears active", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.markPlateaued("neutralStreak >= 3", 60, 150, 5, 10);

      const all = mgr.getAll();
      expect(all[0].status).toBe("plateaued");
      expect(all[0].plateauReason).toBe("neutralStreak >= 3");
      expect(all[0].bestScore).toBe(60);
      expect(all[0].bestPnl).toBe(150);
      expect(all[0].bestIter).toBe(5);
      expect(all[0].iterationsUsed).toBe(10);
      expect(mgr.getActive()).toBeNull();
    });

    it("is a no-op when no active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);
      // Second call should be safe
      mgr.markPlateaued("test2", 99, 99, 99, 99);
      expect(mgr.getAll()[0].bestScore).toBe(0); // not overwritten
    });
  });

  describe("markComplete", () => {
    it("marks active variant as complete", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.markComplete(85, 300, 12, 15);

      const v = mgr.getAll()[0];
      expect(v.status).toBe("complete");
      expect(v.bestScore).toBe(85);
      expect(mgr.getActive()).toBeNull();
    });
  });

  describe("createVariant", () => {
    it("creates variant with deterministic ID from components", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      const components = {
        "Entry Signal": "Bollinger Band squeeze release",
        "Regime Filter": "ADX threshold",
        "Exit": "Chandelier Exit",
      };
      const variant = mgr.createVariant(components, "// bb squeeze code");

      expect(variant.id).toBe("squeeze-adx-chandelier");
      expect(variant.status).toBe("active");
      expect(variant.strategyFile).toBe(
        path.join(strategyDir, "squeeze-adx-chandelier.ts"),
      );
      expect(fs.existsSync(variant.strategyFile)).toBe(true);
      expect(fs.readFileSync(variant.strategyFile, "utf8")).toBe("// bb squeeze code");
      expect(fs.existsSync(variant.checkpointDir)).toBe(true);
      expect(variant.checkpointDir).toContain("variants/squeeze-adx-chandelier/checkpoints");
    });

    it("sets the new variant as active", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      mgr.createVariant(
        { "Entry Signal": "Bollinger Band squeeze release", "Exit": "ATR trailing stop" },
        "// code",
      );

      expect(mgr.getActive()!.id).toBe("squeeze-atr-trail");
    });

    it("throws when components produce duplicate ID", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      const components = { "Entry Signal": "Bollinger Band squeeze release" };
      mgr.createVariant(components, "// code");
      mgr.markPlateaued("test", 0, 0, 0, 0);

      expect(() => mgr.createVariant(components, "// code2"))
        .toThrow(/already exists/);
    });

    it("throws when components are empty", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      expect(() => mgr.createVariant({}, "// code"))
        .toThrow(/empty components/);
    });

    it("throws when there is already an active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      // seed is still active

      expect(() =>
        mgr.createVariant({ "Entry Signal": "Bollinger Band squeeze release" }, "// code"),
      ).toThrow(/already an active variant/);
    });
  });

  describe("updateBest", () => {
    it("updates active variant scores", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.updateBest(75, 250, 8);

      const active = mgr.getActive()!;
      expect(active.bestScore).toBe(75);
      expect(active.bestPnl).toBe(250);
      expect(active.bestIter).toBe(8);
    });
  });

  describe("incrementIterations", () => {
    it("increments the active variant iteration count", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.incrementIterations();
      mgr.incrementIterations();
      mgr.incrementIterations();

      expect(mgr.getActive()!.iterationsUsed).toBe(3);
    });
  });

  describe("getBest", () => {
    it("returns variant with highest score among non-active", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 40, 100, 3, 10);

      mgr.createVariant({ "Entry Signal": "Bollinger Band squeeze release" }, "// v1");
      mgr.markPlateaued("test", 70, 200, 8, 15);

      mgr.createVariant({ "Entry Signal": "Opening Range Breakout (ORB)" }, "// v2");
      mgr.markPlateaued("test", 55, 150, 12, 10);

      const best = mgr.getBest();
      expect(best).not.toBeNull();
      expect(best!.id).toBe("squeeze");
      expect(best!.bestScore).toBe(70);
    });

    it("returns null when no non-active variants exist", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      expect(mgr.getBest()).toBeNull();
    });
  });

  describe("isTestedCombination", () => {
    it("returns true for already-tested component set", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);
      mgr.createVariant({ "Entry Signal": "Bollinger Band squeeze release", "Exit": "ATR trailing stop" }, "// code");

      expect(
        mgr.isTestedCombination({ "Entry Signal": "Bollinger Band squeeze release", "Exit": "ATR trailing stop" }),
      ).toBe(true);
    });

    it("returns false for untested combination", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      expect(
        mgr.isTestedCombination({ "Entry Signal": "Bollinger Band squeeze release" }),
      ).toBe(false);
    });
  });

  describe("save / load roundtrip", () => {
    it("persists full registry across instances", () => {
      const mgr1 = new VariantManager(tmpDir, mainStrategyFile);
      mgr1.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr1.markPlateaued("neutral>=3", 60, 150, 5, 10);
      mgr1.createVariant(
        { "Entry Signal": "Bollinger Band squeeze release", "Regime Filter": "ADX threshold" },
        "// v1 code",
      );
      mgr1.updateBest(45, 120, 3);
      mgr1.save();

      const mgr2 = new VariantManager(tmpDir, mainStrategyFile);
      mgr2.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      expect(mgr2.getAll()).toHaveLength(2);
      expect(mgr2.getAll()[0].id).toBe("donchian-adx");
      expect(mgr2.getAll()[0].status).toBe("plateaued");
      expect(mgr2.getAll()[1].id).toBe("squeeze-adx");
      expect(mgr2.getAll()[1].status).toBe("active");
      expect(mgr2.getActive()!.id).toBe("squeeze-adx");
      expect(mgr2.getActive()!.bestScore).toBe(45);
    });
  });

  describe("getAll", () => {
    it("returns all registered variants", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);
      mgr.createVariant({ "Entry Signal": "Bollinger Band squeeze release" }, "// v1");
      mgr.markPlateaued("test", 0, 0, 0, 0);
      mgr.createVariant({ "Entry Signal": "Opening Range Breakout (ORB)" }, "// v2");

      const all = mgr.getAll();
      expect(all).toHaveLength(3);
      expect(all.map(v => v.id)).toEqual([
        "donchian-adx",
        "squeeze",
        "orb",
      ]);
    });
  });

  describe("multi-run simulation", () => {
    it("simulates 3 runs: seed → plateau → generate → plateau → generate", () => {
      // Run 1: seed refine → plateau
      const mgr1 = new VariantManager(tmpDir, mainStrategyFile);
      mgr1.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      expect(mgr1.getActive()!.id).toBe("donchian-adx");
      mgr1.updateBest(50, 100, 5);
      mgr1.markPlateaued("noChange>=2", 50, 100, 5, 8);
      mgr1.save();

      // Run 2: detect plateau → generate variant → refine → plateau
      const mgr2 = new VariantManager(tmpDir, mainStrategyFile);
      mgr2.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      expect(mgr2.getActive()).toBeNull(); // no active variant
      mgr2.createVariant(
        { "Entry Signal": "Bollinger Band squeeze release", "Regime Filter": "MA slope flat" },
        "// squeeze-ma-flat code",
      );
      expect(mgr2.getActive()!.id).toBe("squeeze-ma-flat");
      mgr2.updateBest(65, 200, 3);
      mgr2.markPlateaued("neutralStreak>=3", 65, 200, 3, 12);
      mgr2.save();

      // Run 3: detect plateau → generate another variant
      const mgr3 = new VariantManager(tmpDir, mainStrategyFile);
      mgr3.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      expect(mgr3.getActive()).toBeNull();
      mgr3.createVariant(
        { "Entry Signal": "Opening Range Breakout (ORB)", "Exit": "Chandelier Exit" },
        "// orb-chandelier code",
      );
      expect(mgr3.getActive()!.id).toBe("orb-chandelier");

      const all = mgr3.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe("donchian-adx");
      expect(all[0].status).toBe("plateaued");
      expect(all[1].id).toBe("squeeze-ma-flat");
      expect(all[1].status).toBe("plateaued");
      expect(all[2].id).toBe("orb-chandelier");
      expect(all[2].status).toBe("active");

      // Best is squeeze-ma-flat (score 65)
      expect(mgr3.getBest()!.id).toBe("squeeze-ma-flat");
    });
  });
});

// ---------------------------------------------------------------------------
// buildFailureAnalysis (variant-generator)
// ---------------------------------------------------------------------------
describe("buildFailureAnalysis", () => {
  it("returns empty string for empty variants", () => {
    expect(buildFailureAnalysis([])).toBe("");
  });

  it("formats variant history with scores and reasons", () => {
    const variants = [
      { id: "donchian-adx", components: {}, bestScore: 50, plateauReason: "noChange>=2" },
      {
        id: "squeeze-adx",
        components: { "Entry Signal": "Bollinger Band squeeze release", "Regime Filter": "ADX threshold" },
        bestScore: 65.3,
      },
    ];
    const result = buildFailureAnalysis(variants);
    expect(result).toContain("donchian-adx");
    expect(result).toContain("score=50.0");
    expect(result).toContain("noChange>=2");
    expect(result).toContain("Bollinger Band squeeze release + ADX threshold");
    expect(result).toContain("score=65.3");
  });
});
