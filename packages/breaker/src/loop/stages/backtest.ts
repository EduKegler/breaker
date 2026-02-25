import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "../types.js";

export interface BacktestResult {
  xlsxPath: string;
}

/**
 * Run the backtest via run-backtest.js child process.
 * Returns the XLSX result path extracted from stdout.
 */
export function runBacktest(opts: {
  repoRoot: string;
  strategyFile: string;
  chartUrl: string;
  authFile?: string;
  headless?: boolean;
  timeoutMs?: number;
  contentToken?: string;
  asset?: string;
  dateRange?: string;
}): StageResult<BacktestResult> {
  const {
    repoRoot,
    strategyFile,
    chartUrl,
    authFile = path.join(repoRoot, "playwright/.auth/tradingview.json"),
    headless = process.env.HEADLESS !== "false",
    timeoutMs = 120000,
    contentToken,
  } = opts;

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    STRATEGY_FILE: strategyFile,
    TV_CHART_URL: chartUrl,
    AUTH_FILE: authFile,
    HEADLESS: String(headless),
    TIMEOUT_MS: String(timeoutMs),
    ...(opts.asset ? { RESULTS_DIR: `results/${opts.asset}` } : {}),
    ...(opts.dateRange ? { DATE_RANGE: opts.dateRange } : {}),
  };

  if (contentToken) {
    env.CONTENT_TOKEN = contentToken;
  }

  try {
    const stdout = execFileSync(
      "node",
      [path.join(repoRoot, "dist/automation/run-backtest.js")],
      {
        env,
        cwd: path.join(repoRoot, "playwright"),
        timeout: timeoutMs + 30000, // extra margin
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Extract XLSX path from stdout
    const match = stdout.match(/XLSX_RESULT_PATH:(.+)/);
    if (!match) {
      return { success: false, error: "No XLSX_RESULT_PATH in output" };
    }

    const xlsxPath = match[1].trim();
    if (!fs.existsSync(xlsxPath)) {
      return { success: false, error: `XLSX file not found: ${xlsxPath}` };
    }

    return {
      success: true,
      data: { xlsxPath },
    };
  } catch (err) {
    const stderr = (() => {
      const e = err as { stderr?: Buffer | string };
      if (typeof e.stderr === "string") return e.stderr;
      if (Buffer.isBuffer(e.stderr)) return e.stderr.toString("utf8");
      return "";
    })().trim();
    const message = stderr ? `${(err as Error).message} | stderr: ${stderr.slice(0, 500)}` : ((err as Error).message || "backtest failed");
    return {
      success: false,
      error: message,
    };
  }
}
