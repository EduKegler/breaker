import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { emitEvent } from "./events.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

describe("emitEvent", () => {
  it("creates events.ndjson with valid JSON line", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-events-"));
    emitEvent({
      artifactsDir: tmpDir,
      runId: "test-run",
      asset: "BTC",
      iter: 1,
      stage: "BACKTEST_START",
      status: "info",
      message: "Starting backtest",
    });

    const file = path.join(tmpDir, "events.ndjson");
    expect(fs.existsSync(file)).toBe(true);

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]);
    expect(event.run_id).toBe("test-run");
    expect(event.asset).toBe("BTC");
    expect(event.iter).toBe(1);
    expect(event.stage).toBe("BACKTEST_START");
    expect(event.message).toBe("Starting backtest");
  });

  it("appends multiple events to same file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-events-"));
    emitEvent({
      artifactsDir: tmpDir,
      runId: "r1",
      asset: "BTC",
      iter: 1,
      stage: "A",
      status: "info",
    });
    emitEvent({
      artifactsDir: tmpDir,
      runId: "r1",
      asset: "BTC",
      iter: 2,
      stage: "B",
      status: "success",
      pnl: 100,
      pf: 1.5,
    });

    const file = path.join(tmpDir, "events.ndjson");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).pnl).toBe(100);
  });

  it("creates directory if it does not exist", () => {
    tmpDir = path.join(os.tmpdir(), "pine-events-nested-" + Date.now());
    const nested = path.join(tmpDir, "sub", "dir");
    emitEvent({
      artifactsDir: nested,
      runId: "r1",
      asset: "BTC",
      iter: 1,
      stage: "X",
      status: "info",
    });
    expect(fs.existsSync(path.join(nested, "events.ndjson"))).toBe(true);
  });

  it("includes strategy field when provided", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-events-"));
    emitEvent({
      artifactsDir: tmpDir,
      runId: "r1",
      asset: "BTC",
      strategy: "breakout",
      iter: 1,
      stage: "X",
      status: "info",
    });
    const event = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf8").trim(),
    );
    expect(event.strategy).toBe("breakout");
  });

  it("defaults numeric fields to 0", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-events-"));
    emitEvent({
      artifactsDir: tmpDir,
      runId: "r1",
      asset: "BTC",
      iter: 1,
      stage: "X",
      status: "info",
    });

    const event = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf8").trim(),
    );
    expect(event.pnl).toBe(0);
    expect(event.pf).toBe(0);
    expect(event.dd).toBe(0);
    expect(event.trades).toBe(0);
  });
});
