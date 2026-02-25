import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildStrategyDir, findActiveStrategyFile } from "./strategy-path.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

describe("buildStrategyDir", () => {
  it("builds path with asset and strategy", () => {
    expect(buildStrategyDir("/repo", "BTC", "breakout")).toBe(
      "/repo/assets/btc/breakout",
    );
  });

  it("handles different asset and strategy names", () => {
    expect(buildStrategyDir("/repo", "ETH", "mean-reversion")).toBe(
      "/repo/assets/eth/mean-reversion",
    );
  });
});

describe("findActiveStrategyFile", () => {
  it("returns the single active .pine file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "squeeze.pine"), "// pine");

    const result = findActiveStrategyFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "squeeze.pine"));
  });

  it("ignores -archived.pine files and returns the active one", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "squeeze.pine"), "// active");
    fs.writeFileSync(path.join(tmpDir, "orb-archived.pine"), "// archived");
    fs.writeFileSync(path.join(tmpDir, "donchian-archived.pine"), "// archived");

    const result = findActiveStrategyFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "squeeze.pine"));
  });

  it("throws when directory has no .pine files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# notes");

    expect(() => findActiveStrategyFile(tmpDir)).toThrow(/No active .pine/);
  });

  it("throws when directory has only _archived .pine files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "old-archived.pine"), "// archived");

    expect(() => findActiveStrategyFile(tmpDir)).toThrow(/No active .pine/);
  });

  it("throws when directory has 2+ active .pine files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "squeeze.pine"), "// one");
    fs.writeFileSync(path.join(tmpDir, "breakout.pine"), "// two");

    expect(() => findActiveStrategyFile(tmpDir)).toThrow(/Multiple active/);
  });

  it("throws when directory does not exist", () => {
    expect(() => findActiveStrategyFile("/nonexistent/dir")).toThrow(
      /does not exist/,
    );
  });

  it("ignores non-.pine files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strat-"));
    fs.writeFileSync(path.join(tmpDir, "squeeze.pine"), "// active");
    fs.writeFileSync(path.join(tmpDir, "parameter-history.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "# log");

    const result = findActiveStrategyFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, "squeeze.pine"));
  });
});
