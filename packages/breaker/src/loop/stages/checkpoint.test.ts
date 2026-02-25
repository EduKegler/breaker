import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveCheckpoint, loadCheckpoint, rollback } from "./checkpoint.js";
import type { Metrics } from "../../types/parse-results.js";

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    saveCheckpoint(tmpDir, "// pine code", sampleMetrics, 5);

    const loaded = loadCheckpoint(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.pineContent).toBe("// pine code");
    expect(loaded!.metrics.totalPnl).toBe(242.68);
    expect(loaded!.iter).toBe(5);
    expect(loaded!.timestamp).toBeTruthy();
  });

  it("returns null when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    expect(loadCheckpoint(tmpDir)).toBeNull();
  });

  it("returns null when metrics JSON is corrupted", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    fs.writeFileSync(path.join(tmpDir, "best.pine"), "// valid pine");
    fs.writeFileSync(path.join(tmpDir, "best-metrics.json"), "not valid json{{{");
    expect(loadCheckpoint(tmpDir)).toBeNull();
  });

  it("does not leave .tmp files after save", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    saveCheckpoint(tmpDir, "// pine code", sampleMetrics, 3);

    expect(fs.existsSync(path.join(tmpDir, "best.pine.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "best.pine"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "best-metrics.json"))).toBe(true);
  });

  it("creates directory if it does not exist", () => {
    tmpDir = path.join(os.tmpdir(), "pine-ckpt-new-" + Date.now());
    saveCheckpoint(tmpDir, "code", sampleMetrics, 1);
    expect(fs.existsSync(path.join(tmpDir, "best.pine"))).toBe(true);
  });
});

describe("rollback", () => {
  it("restores strategy file from checkpoint", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    const strategyFile = path.join(tmpDir, "strategy.pine");
    const checkpointDir = path.join(tmpDir, "checkpoint");

    // Create checkpoint
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "best.pine"), "// best version");
    fs.writeFileSync(strategyFile, "// current version");

    const result = rollback(checkpointDir, strategyFile);
    expect(result).toBe(true);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("// best version");
  });

  it("returns false when no checkpoint exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    const result = rollback(tmpDir, "/nonexistent/file");
    expect(result).toBe(false);
  });

  it("restores checkpoint even after file was modified post-rollback (end-of-loop scenario)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-ckpt-"));
    const strategyFile = path.join(tmpDir, "strategy.pine");
    const checkpointDir = path.join(tmpDir, "checkpoint");

    // Simulate: checkpoint saved at iter 6 with kcMult=1.4
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, "best.pine"), "kcMult = 1.4");

    // Simulate: iter 10 rollback restores checkpoint
    fs.writeFileSync(strategyFile, "kcMult = 1.5");
    rollback(checkpointDir, strategyFile);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("kcMult = 1.4");

    // Simulate: optimize step overwrites the rollback
    fs.writeFileSync(strategyFile, "kcMult = 1.5\nrsiLen = 14");

    // End-of-loop restore should bring back the checkpoint
    const result = rollback(checkpointDir, strategyFile);
    expect(result).toBe(true);
    expect(fs.readFileSync(strategyFile, "utf8")).toBe("kcMult = 1.4");
  });
});
