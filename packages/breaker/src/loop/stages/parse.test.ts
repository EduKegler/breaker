import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseResults } from "./parse.js";

const REPO = "/fake/repo";
const DEFAULTS = {
  repoRoot: REPO,
  xlsxPath: "/tmp/test.xlsx",
  asset: "BTC",
  strategyFile: "/fake/repo/assets/BTC/strategy.pine",
};

const sampleOutput = {
  passed: true,
  xlsxStale: false,
  filepath: "/tmp/test.xlsx",
  thresholds: { minTrades: 150, minPF: 1.6, maxDD: 8, minWR: 30, minAvgR: 0.2 },
  metrics: {
    totalPnl: 250,
    numTrades: 180,
    profitFactor: 1.65,
    maxDrawdownPct: 6.5,
    winRate: 32,
    avgR: 0.22,
  },
  criteria: {
    pnlPositive: true,
    tradesOk: true,
    pfOk: true,
    ddOk: true,
    wrOk: true,
    avgROk: true,
  },
  pineParams: null,
  xlsxParams: null,
  tradeAnalysis: null,
};

describe("parseResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
  });

  it("returns parsed JSON on success", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(sampleOutput);
  });

  it("calls fs.unlinkSync on xlsxPath after parsing", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));

    parseResults(DEFAULTS);

    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/test.xlsx");
  });

  it("handles unlinkSync failure silently", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));
    (fs.unlinkSync as any).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(sampleOutput);
  });

  it("returns failure when execFileSync throws", () => {
    (execFileSync as any).mockImplementation(() => {
      throw new Error("parse-results crashed");
    });

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/parse-results crashed/);
  });

  it("returns failure when stdout is invalid JSON", () => {
    (execFileSync as any).mockReturnValue("not valid json {{{");

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("passes --after flag when iterStartTs provided", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));

    parseResults({ ...DEFAULTS, iterStartTs: 1700000000000 });

    const callArgs = (execFileSync as any).mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args).toContain("--after=1700000000000");
  });

  it("omits --after flag when iterStartTs is undefined", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));

    parseResults(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args.some((a) => a.startsWith("--after="))).toBe(false);
  });

  it("sets env vars ASSET and PINE_FILE", () => {
    (execFileSync as any).mockReturnValue(JSON.stringify(sampleOutput));

    parseResults(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.ASSET).toBe("BTC");
    expect(opts.env.PINE_FILE).toBe("/fake/repo/assets/BTC/strategy.pine");
  });

  it("returns failure when JSON is missing 'metrics' field", () => {
    const incomplete = { passed: true, xlsxStale: false, filepath: "/tmp/x.xlsx" };
    (execFileSync as any).mockReturnValue(JSON.stringify(incomplete));

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("metrics");
  });

  it("returns failure when metrics is null", () => {
    const nullMetrics = { ...sampleOutput, metrics: null };
    (execFileSync as any).mockReturnValue(JSON.stringify(nullMetrics));

    const result = parseResults(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("metrics");
  });
});
