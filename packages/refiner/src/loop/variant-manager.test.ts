import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  VariantManager,
  buildVariantId,
  selectNextCombination,
  fixFactoryName,
} from "./variant-manager.js";
import { buildFailureAnalysis } from "./variant-generator.js";
import type { ComponentCatalog } from "../lib/build-module-context.js";

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
// buildVariantId
// ---------------------------------------------------------------------------
describe("buildVariantId", () => {
  it("joins slugs in slot-priority order", () => {
    // Entry Signal (1) → Regime Filter (3) → Exit (5)
    const id = buildVariantId({
      "Exit": "chandelier",
      "Entry Signal": "squeeze",
      "Regime Filter": "adx",
    });
    expect(id).toBe("squeeze-adx-chandelier");
  });

  it("returns empty string for empty components", () => {
    expect(buildVariantId({})).toBe("");
  });

  it("handles unknown slot names alphabetically", () => {
    const id = buildVariantId({
      "Zebra Filter": "zebra",
      "Alpha Signal": "alpha",
    });
    expect(id).toBe("alpha-zebra");
  });

  it("known slots come before unknown slots", () => {
    const id = buildVariantId({
      "Custom Slot": "custom",
      "Entry Signal": "donchian",
    });
    expect(id).toBe("donchian-custom");
  });

  it("is deterministic regardless of insertion order", () => {
    const id1 = buildVariantId({
      "Exit": "timeout",
      "Entry Signal": "donchian",
      "Regime Filter": "ema",
    });
    const id2 = buildVariantId({
      "Regime Filter": "ema",
      "Entry Signal": "donchian",
      "Exit": "timeout",
    });
    expect(id1).toBe(id2);
    expect(id1).toBe("donchian-ema-timeout");
  });

  it("Direction slot sorts before Entry Signal (priority 0)", () => {
    const id = buildVariantId({
      "Exit": "partial-tp",
      "Entry Signal": "squeeze",
      "Regime Filter": "adx",
      "Direction": "short-only",
    });
    expect(id).toBe("short-only-squeeze-adx-partial-tp");
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

  describe("markKilled", () => {
    it("marks active variant as killed with reason", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.markKilled("PF 0.25 < 0.3 (universal floor)", 20, -50, 2, 3);

      const v = mgr.getAll()[0];
      expect(v.status).toBe("killed");
      expect(v.killReason).toBe("PF 0.25 < 0.3 (universal floor)");
      expect(v.bestScore).toBe(20);
      expect(v.bestPnl).toBe(-50);
      expect(v.bestIter).toBe(2);
      expect(v.iterationsUsed).toBe(3);
      expect(mgr.getActive()).toBeNull();
    });

    it("is a no-op when no active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      mgr.markKilled("test", 99, 99, 99, 99);
      expect(mgr.getAll()[0].status).toBe("plateaued"); // not overwritten
    });
  });

  describe("createVariant", () => {
    it("creates variant with deterministic ID from slugs", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      const components = {
        "Entry Signal": "squeeze",
        "Regime Filter": "adx",
        "Exit": "chandelier",
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
        { "Entry Signal": "squeeze", "Exit": "atr-trail" },
        "// code",
      );

      expect(mgr.getActive()!.id).toBe("squeeze-atr-trail");
    });

    it("throws when components produce duplicate ID", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      const components = { "Entry Signal": "squeeze" };
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
        mgr.createVariant({ "Entry Signal": "squeeze" }, "// code"),
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

  describe("resetBudget", () => {
    it("zeroes iterationsUsed for active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      mgr.incrementIterations();
      mgr.incrementIterations();
      expect(mgr.getActive()!.iterationsUsed).toBe(2);

      mgr.resetBudget();
      expect(mgr.getActive()!.iterationsUsed).toBe(0);
    });

    it("is no-op when no active variant", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 0, 0, 0, 0);

      expect(() => mgr.resetBudget()).not.toThrow();
    });
  });

  describe("getBest", () => {
    it("returns variant with highest score among non-active", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr.markPlateaued("test", 40, 100, 3, 10);

      mgr.createVariant({ "Entry Signal": "squeeze" }, "// v1");
      mgr.markPlateaued("test", 70, 200, 8, 15);

      mgr.createVariant({ "Entry Signal": "orb" }, "// v2");
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
      mgr.createVariant({ "Entry Signal": "squeeze", "Exit": "atr-trail" }, "// code");

      expect(
        mgr.isTestedCombination({ "Entry Signal": "squeeze", "Exit": "atr-trail" }),
      ).toBe(true);
    });

    it("returns false for untested combination", () => {
      const mgr = new VariantManager(tmpDir, mainStrategyFile);
      mgr.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);

      expect(
        mgr.isTestedCombination({ "Entry Signal": "squeeze" }),
      ).toBe(false);
    });
  });

  describe("save / load roundtrip", () => {
    it("persists full registry across instances", () => {
      const mgr1 = new VariantManager(tmpDir, mainStrategyFile);
      mgr1.loadOrInit(mainStrategyFile, checkpointDir, paramHistoryFile);
      mgr1.markPlateaued("neutral>=3", 60, 150, 5, 10);
      mgr1.createVariant(
        { "Entry Signal": "squeeze", "Regime Filter": "adx" },
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
      mgr.createVariant({ "Entry Signal": "squeeze" }, "// v1");
      mgr.markPlateaued("test", 0, 0, 0, 0);
      mgr.createVariant({ "Entry Signal": "orb" }, "// v2");

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
        { "Entry Signal": "squeeze", "Regime Filter": "ma-flat" },
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
        { "Entry Signal": "orb", "Exit": "chandelier" },
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
        components: { "Entry Signal": "squeeze", "Regime Filter": "adx" },
        bestScore: 65.3,
      },
    ];
    const result = buildFailureAnalysis(variants);
    expect(result).toContain("donchian-adx");
    expect(result).toContain("score=50.0");
    expect(result).toContain("noChange>=2");
    expect(result).toContain("squeeze + adx");
    expect(result).toContain("score=65.3");
  });
});

// ---------------------------------------------------------------------------
// selectNextCombination
// ---------------------------------------------------------------------------
describe("selectNextCombination", () => {
  const testCatalog: ComponentCatalog = {
    slots: [
      {
        slotName: "Entry Signal",
        candidates: [
          { name: "Donchian Channel", slug: "donchian", description: "Breakout" },
          { name: "BB squeeze", slug: "squeeze", description: "Squeeze" },
        ],
      },
      {
        slotName: "Entry Timing",
        candidates: [
          { name: "Close", slug: "close", description: "Breakout close" },
        ],
        optional: true,
      },
      {
        slotName: "Regime Filter",
        candidates: [
          { name: "EMA direction", slug: "ema", description: "EMA filter" },
          { name: "ADX threshold", slug: "adx", description: "ADX filter" },
        ],
      },
      {
        slotName: "Exit",
        candidates: [
          { name: "ATR trailing stop", slug: "atr-trail", description: "Trail" },
          { name: "Timeout", slug: "timeout", description: "Time" },
        ],
      },
    ],
  };

  it("returns an untested combination when testedIds is empty", () => {
    const result = selectNextCombination(testCatalog, new Set());
    expect(result).not.toBeNull();
    // Should only have required slots (not Entry Timing which is optional)
    expect(Object.keys(result!)).toEqual(
      expect.arrayContaining(["Entry Signal", "Regime Filter", "Exit"]),
    );
    expect(Object.keys(result!)).not.toContain("Entry Timing");
  });

  it("skips combinations already in testedIds", () => {
    // Test with the first combo already tested
    const first = selectNextCombination(testCatalog, new Set())!;
    const firstId = buildVariantId(first);

    const second = selectNextCombination(testCatalog, new Set([firstId]));
    expect(second).not.toBeNull();
    expect(buildVariantId(second!)).not.toBe(firstId);
  });

  it("returns null when all required-slot combinations are exhausted", () => {
    // 2 entry × 2 regime × 2 exit = 8 combinations
    const allCombos: string[] = [];
    for (const entry of ["donchian", "squeeze"]) {
      for (const regime of ["ema", "adx"]) {
        for (const exit of ["atr-trail", "timeout"]) {
          allCombos.push(buildVariantId({
            "Entry Signal": entry,
            "Regime Filter": regime,
            "Exit": exit,
          }));
        }
      }
    }

    const result = selectNextCombination(testCatalog, new Set(allCombos));
    expect(result).toBeNull();
  });

  it("prefers combinations with less-tested slugs (novelty)", () => {
    // Mark all donchian combos as tested → next combo should prefer squeeze
    const donchianCombos = [
      buildVariantId({ "Entry Signal": "donchian", "Regime Filter": "ema", "Exit": "atr-trail" }),
      buildVariantId({ "Entry Signal": "donchian", "Regime Filter": "ema", "Exit": "timeout" }),
      buildVariantId({ "Entry Signal": "donchian", "Regime Filter": "adx", "Exit": "atr-trail" }),
      buildVariantId({ "Entry Signal": "donchian", "Regime Filter": "adx", "Exit": "timeout" }),
    ];

    const result = selectNextCombination(testCatalog, new Set(donchianCombos));
    expect(result).not.toBeNull();
    expect(result!["Entry Signal"]).toBe("squeeze");
  });

  it("ignores optional slots", () => {
    const result = selectNextCombination(testCatalog, new Set());
    expect(result).not.toBeNull();
    // Entry Timing is optional — should not be in the result
    expect(result!["Entry Timing"]).toBeUndefined();
  });

  it("returns null for catalog with no required slots", () => {
    const allOptionalCatalog: ComponentCatalog = {
      slots: [
        {
          slotName: "Optional Slot",
          candidates: [{ name: "A", slug: "a", description: "test" }],
          optional: true,
        },
      ],
    };
    expect(selectNextCombination(allOptionalCatalog, new Set())).toBeNull();
  });

  it("returns null for empty catalog", () => {
    expect(selectNextCombination({ slots: [] }, new Set())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fixFactoryName
// ---------------------------------------------------------------------------
describe("fixFactoryName", () => {
  it("renames create* function to match variant ID", () => {
    const source = `export function createDonchianEmaTimeout(overrides) {
  const params: DonchianEmaTimeoutParams = { dcSlow: 20 };
  return { name: "DonchianEmaTimeout", params };
}`;
    const result = fixFactoryName(source, "squeeze-adx-trail-dc");
    expect(result).toContain("createSqueezeAdxTrailDc");
    expect(result).not.toContain("createDonchianEmaTimeout");
  });

  it("preserves source when factory name already matches", () => {
    const source = `export function createSqueezeAdx(overrides) { return {}; }`;
    const result = fixFactoryName(source, "squeeze-adx");
    expect(result).toBe(source);
  });

  it("renames related PascalCase types/interfaces", () => {
    const source = `interface DonchianEmaTimeoutParams { dcSlow: number; }
export function createDonchianEmaTimeout(overrides: Partial<DonchianEmaTimeoutParams>) {
  const p: DonchianEmaTimeoutParams = { dcSlow: 20 };
}`;
    const result = fixFactoryName(source, "squeeze-adx-trail-dc");
    expect(result).toContain("SqueezeAdxTrailDcParams");
    expect(result).not.toContain("DonchianEmaTimeoutParams");
    expect(result).toContain("createSqueezeAdxTrailDc");
  });

  it("handles source with no create* function (returns as-is)", () => {
    const source = `const x = 42;\nexport default x;`;
    const result = fixFactoryName(source, "squeeze-adx");
    expect(result).toBe(source);
  });
});
