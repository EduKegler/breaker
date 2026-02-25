import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runBacktest } from "./backtest.js";

const REPO = "/fake/repo";
const DEFAULTS = {
  repoRoot: REPO,
  strategyFile: "/fake/repo/assets/BTC/strategy.pine",
  chartUrl: "https://www.tradingview.com/chart/xyz",
};

describe("runBacktest", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
  });

  it("returns success with xlsxPath when stdout has XLSX_RESULT_PATH", () => {
    (execFileSync as any).mockReturnValue(
      "some log\nXLSX_RESULT_PATH:/tmp/results/export.xlsx\ndone",
    );

    const result = runBacktest(DEFAULTS);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ xlsxPath: "/tmp/results/export.xlsx" });
  });

  it("returns failure when XLSX_RESULT_PATH absent in stdout", () => {
    (execFileSync as any).mockReturnValue("some log\nno path here\ndone");

    const result = runBacktest(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No XLSX_RESULT_PATH/);
  });

  it("returns failure when execFileSync throws", () => {
    (execFileSync as any).mockImplementation(() => {
      throw new Error("process exited with code 1");
    });

    const result = runBacktest(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/process exited with code 1/);
  });

  it("sets CONTENT_TOKEN in env when contentToken provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest({ ...DEFAULTS, contentToken: "tok_abc" });

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.CONTENT_TOKEN).toBe("tok_abc");
  });

  it("does NOT set CONTENT_TOKEN when contentToken is undefined", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env).not.toHaveProperty("CONTENT_TOKEN");
  });

  it("sets cwd to playwright dir", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.cwd).toBe(path.join(REPO, "playwright"));
  });

  it("sets timeout with margin of 30s", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest({ ...DEFAULTS, timeoutMs: 60000 });

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.timeout).toBe(60000 + 30000);
  });

  it("propagates headless flag as env var HEADLESS", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest({ ...DEFAULTS, headless: false });

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.HEADLESS).toBe("false");
  });

  it("uses default authFile when not provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.AUTH_FILE).toBe(
      path.join(REPO, "playwright/.auth/tradingview.json"),
    );
  });

  it("sets RESULTS_DIR when asset is provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest({ ...DEFAULTS, asset: "SUI" });

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.RESULTS_DIR).toBe("results/SUI");
  });

  it("sets DATE_RANGE env var when dateRange is provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest({ ...DEFAULTS, dateRange: "custom:2025-08-01:2026-02-01" });

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env.DATE_RANGE).toBe("custom:2025-08-01:2026-02-01");
  });

  it("does NOT set DATE_RANGE when dateRange is not provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env).not.toHaveProperty("DATE_RANGE");
  });

  it("does NOT set RESULTS_DIR when asset is not provided", () => {
    (execFileSync as any).mockReturnValue("XLSX_RESULT_PATH:/tmp/x.xlsx");

    runBacktest(DEFAULTS);

    const callArgs = (execFileSync as any).mock.calls[0];
    const opts = callArgs[2];
    expect(opts.env).not.toHaveProperty("RESULTS_DIR");
  });

  it("returns failure when XLSX file does not exist on disk", () => {
    (execFileSync as any).mockReturnValue(
      "XLSX_RESULT_PATH:/tmp/nonexistent/export.xlsx",
    );
    existsSyncSpy.mockReturnValue(false);

    const result = runBacktest(DEFAULTS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("XLSX file not found");
  });

  it("returns success when XLSX file exists on disk", () => {
    (execFileSync as any).mockReturnValue(
      "XLSX_RESULT_PATH:/tmp/results/export.xlsx",
    );

    const result = runBacktest(DEFAULTS);

    expect(result.success).toBe(true);
    expect(result.data?.xlsxPath).toBe("/tmp/results/export.xlsx");
  });
});
