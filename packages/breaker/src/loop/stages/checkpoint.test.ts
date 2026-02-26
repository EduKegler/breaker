import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveCheckpoint, loadCheckpoint, rollback, loadCheckpointParams } from "./checkpoint.js";
import type { Metrics } from "@trading/backtest";

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
};

describe("saveCheckpoint / loadCheckpoint", () => {
  it("saves and loads checkpoint correctly", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    saveCheckpoint(tmpDir, "// strategy code", sampleMetrics, 5);

    const loaded = loadCheckpoint(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.strategyContent).toBe("// strategy code");
    expect(loaded!.metrics.totalPnl).toBe(242.68);
    expect(loaded!.iter).toBe(5);
    expect(loaded!.timestamp).toBeTruthy();
  });

  it("saves and loads params when provided", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const params = { dcSlow: 55, dcFast: 20 };
    saveCheckpoint(tmpDir, "// code", sampleMetrics, 3, params);

    const loaded = loadCheckpoint(tmpDir);
    expect(loaded!.params).toEqual(params);
  });

  it("returns null when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    expect(loadCheckpoint(tmpDir)).toBeNull();
  });

  it("returns null when metrics JSON is corrupted", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-strategy.ts"), "// valid");
    fs.writeFileSync(path.join(tmpDir, "best-metrics.json"), "not valid json{{{");
    expect(loadCheckpoint(tmpDir)).toBeNull();
  });

  it("does not leave .tmp files after save", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    saveCheckpoint(tmpDir, "// code", sampleMetrics, 3);

    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json"))).toBe(true);
  });

  it("creates directory if it does not exist", () => {
    tmpDir = path.join(os.tmpdir(), "ckpt-new-" + Date.now());
    saveCheckpoint(tmpDir, "code", sampleMetrics, 1);
    expect(fs.existsSync(path.join(tmpDir, "best-strategy.ts"))).toBe(true);
  });

  it("falls back to legacy best.pine for loading", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best.pine"), "// legacy pine");
    fs.writeFileSync(
      path.join(tmpDir, "best-metrics.json"),
      JSON.stringify({ ...sampleMetrics, iter: 2, timestamp: "2026-01-01T00:00:00Z" }),
    );

    const loaded = loadCheckpoint(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.strategyContent).toBe("// legacy pine");
  });
});

describe("rollback", () => {
  it("restores strategy file from checkpoint", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const strategyFile = path.join(tmpDir, "strategy.ts");
    const checkpointDir = path.join(tmpDir, "checkpoint");

    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "best-strategy.ts"), "// best version");
    fs.writeFileSync(strategyFile, "// current version");

    const result = rollback(checkpointDir, strategyFile);
    expect(result).toBe(true);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("// best version");
  });

  it("returns false when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const result = rollback(tmpDir, "/nonexistent/file");
    expect(result).toBe(false);
  });

  it("falls back to legacy best.pine for rollback", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    const strategyFile = path.join(tmpDir, "strategy.ts");
    const checkpointDir = path.join(tmpDir, "checkpoint");

    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "best.pine"), "// legacy");
    fs.writeFileSync(strategyFile, "// current");

    const result = rollback(checkpointDir, strategyFile);
    expect(result).toBe(true);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("// legacy");
  });
});

describe("loadCheckpointParams", () => {
  it("returns params when file exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-params.json"), JSON.stringify({ dcSlow: 55 }));
    expect(loadCheckpointParams(tmpDir)).toEqual({ dcSlow: 55 });
  });

  it("returns null when file doesn't exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    expect(loadCheckpointParams(tmpDir)).toBeNull();
  });

  it("returns null on corrupt file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best-params.json"), "not json");
    expect(loadCheckpointParams(tmpDir)).toBeNull();
  });
});
