import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkpoint } from "./checkpoint.js";
import type { Metrics } from "@breaker/backtest";

let tmpDir: string;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

const sampleMetrics: Metrics = {
  totalPnl: 242.68,
  numTrades: 188,
  profitFactor: 1.493,
  maxDrawdownPct: 6.11,
  winRate: 21.3,
  avgR: 0.257,
  avgWinR: 1.5,
  avgLossR: -0.7,
  maxLossR: -1.2,
  expectancy: 0.257,
  edgeBpsGross: null,
  edgeBpsNet: null,
  avgCostBps: null,
  tradesPerDay: null,
  totalCostPct: null,
  sharpeRatio: null,
  sortinoRatio: null,
};

describe("checkpoint.save / checkpoint.load", () => {
  it("saves and loads checkpoint correctly", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// strategy code", sampleMetrics, 5);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.strategyContent).toBe("// strategy code");
    expect(loaded!.metrics.totalPnl).toBe(242.68);
    expect(loaded!.iter).toBe(5);
    expect(loaded!.timestamp).toBeTruthy();
  });

  it("saves and loads params when provided", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const params = { dcSlow: 55, dcFast: 20 };
    const source = `const DEFAULT_PARAMS = {
  dcSlow: { value: 40, min: 20, max: 60, step: 5, optimizable: true },
  dcFast: { value: 15, min: 10, max: 25, step: 5, optimizable: true },
};`;
    checkpoint.save(tmpDir, source, sampleMetrics, 3, params);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.params).toEqual(params);
    // Values should be baked into source
    expect(loaded!.strategyContent).toContain("dcSlow: { value: 55,");
    expect(loaded!.strategyContent).toContain("dcFast: { value: 20,");
  });

  it("returns null when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    expect(checkpoint.load(tmpDir)).toBeNull();
  });

  it("returns null when metrics JSON is corrupted", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-strategy.ts.bak"), "// valid");
    fs.writeFileSync(path.join(tmpDir, "best-metrics.json"), "not valid json{{{");
    expect(checkpoint.load(tmpDir)).toBeNull();
  });

  it("does not leave .tmp files after save", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 3);

    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts.bak.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts.bak"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json"))).toBe(true);
  });

  it("creates directory if it does not exist", () => {
    tmpDir = path.join(os.tmpdir(), "ckpt-new-" + Date.now());
    checkpoint.save(tmpDir, "code", sampleMetrics, 1);
    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts.bak"))).toBe(true);
  });

});

describe("checkpoint.save error handling (P3.5)", () => {
  it("throws with descriptive message if write fails", () => {
    // Writing to a read-only path should fail
    const badDir = "/dev/null/impossible-path";
    expect(() => {
      checkpoint.save(badDir, "// code", sampleMetrics, 1);
    }).toThrow("Checkpoint save failed");
  });
});

describe("checkpoint.save edge cases", () => {
  it("save with empty trades produces checkpoint without trades CSV", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 1, { dcSlow: 55 }, []);
    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.iter).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "best-trades.csv"))).toBe(false);
  });
});

describe("checkpoint.save/load with paramCount (P4.1)", () => {
  it("saves and loads paramCount", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 5, { dcSlow: 55 }, [], 4);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.paramCount).toBe(4);
  });

  it("paramCount is undefined for saves without it", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 3, { dcSlow: 55 });

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.paramCount).toBeUndefined();
  });
});

describe("checkpoint.save/load with strategyParams (B4)", () => {
  it("saves and loads strategyParams", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const sp = {
      dcSlow: { value: 55, min: 20, max: 100, step: 5, optimizable: true, description: "Slow DC" },
      dcFast: { value: 20, min: 5, max: 50, step: 5, optimizable: true },
    };
    checkpoint.save(tmpDir, "// code", sampleMetrics, 5, { dcSlow: 55 }, [], 2, sp);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.strategyParams).toBeDefined();
    expect(loaded!.strategyParams!.dcSlow.min).toBe(20);
    expect(loaded!.strategyParams!.dcSlow.description).toBe("Slow DC");
    expect(loaded!.strategyParams!.dcFast.optimizable).toBe(true);
  });

  it("strategyParams is undefined for saves without it", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 3, { dcSlow: 55 });

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.strategyParams).toBeUndefined();
  });
});

describe("checkpoint.save/load with analysis (B2)", () => {
  it("saves and loads analysis", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const analysis = {
      totalExitRows: 100,
      byDirection: {},
      byExitType: [],
      avgBarsWinners: 5,
      avgBarsLosers: 3,
      byDayOfWeek: {},
      bestHoursUTC: [],
      worstHoursUTC: [],
      best3TradesPnl: [10, 8, 6],
      worst3TradesPnl: [-5, -4, -3],
      filterSimulations: { sessionFilter: null, hourFilter: null, dowFilter: null },
      walkForward: { trainPF: 1.5, testPF: 1.2, pfRatio: 0.8, overfitFlag: false },
      bySession: null,
    };
    checkpoint.save(tmpDir, "// code", sampleMetrics, 5, { dcSlow: 55 }, [], 2, undefined, analysis);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.analysis).toBeDefined();
    expect(loaded!.analysis!.totalExitRows).toBe(100);
    expect(loaded!.analysis!.walkForward?.trainPF).toBe(1.5);
  });

  it("load without best-analysis.json returns undefined analysis (backward-compat)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    checkpoint.save(tmpDir, "// code", sampleMetrics, 3, { dcSlow: 55 });

    const loaded = checkpoint.load(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.analysis).toBeUndefined();
  });
});

describe("checkpoint.rollback", () => {
  it("restores strategy file from checkpoint", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const strategyFile = path.join(tmpDir, "strategy.ts");
    const checkpointDir = path.join(tmpDir, "checkpoint");

    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "best-strategy.ts.bak"), "// best version");
    fs.writeFileSync(strategyFile, "// current version");

    const result = checkpoint.rollback(checkpointDir, strategyFile);
    expect(result).toBe(true);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("// best version");
  });

  it("returns false when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const result = checkpoint.rollback(tmpDir, "/nonexistent/file");
    expect(result).toBe(false);
  });

  it("returns false when checkpoint dir does not exist", () => {
    const result = checkpoint.rollback("/tmp/nonexistent-dir-" + Date.now(), "/tmp/target.ts");
    expect(result).toBe(false);
  });
});

describe("checkpoint.save bakes param defaults into source", () => {
  it("rewrites value: fields in strategy source to match overrides", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-bake-"));
    const source = `const DEFAULT_PARAMS = {
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true },
  tpRR: { value: 2, min: 1.5, max: 3, step: 0.5, optimizable: true },
};`;

    checkpoint.save(tmpDir, source, sampleMetrics, 5, { volMult: 2, tpRR: 1.5 });

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.strategyContent).toContain("volMult: { value: 2,");
    expect(loaded!.strategyContent).toContain("tpRR: { value: 1.5,");
  });

  it("removes stale params from best-params.json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-stale-"));
    const source = `const DEFAULT_PARAMS = {
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true },
};`;

    checkpoint.save(tmpDir, source, sampleMetrics, 5, { volMult: 2, dcSlow: 55 });

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.strategyContent).toContain("volMult: { value: 2,");
    expect(loaded!.params).toEqual({ volMult: 2 });
  });

  it("saves unchanged source when no params provided", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-nop-"));
    const source = "// unchanged code";
    checkpoint.save(tmpDir, source, sampleMetrics, 1);

    const loaded = checkpoint.load(tmpDir);
    expect(loaded!.strategyContent).toBe(source);
  });
});

describe("checkpoint.loadParams", () => {
  it("returns params when file exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-params.json"), JSON.stringify({ dcSlow: 55 }));
    expect(checkpoint.loadParams(tmpDir)).toEqual({ dcSlow: 55 });
  });

  it("returns null when file doesn't exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    expect(checkpoint.loadParams(tmpDir)).toBeNull();
  });

  it("returns null on corrupt file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-params.json"), "not json");
    expect(checkpoint.loadParams(tmpDir)).toBeNull();
  });
});
