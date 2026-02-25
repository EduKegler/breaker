/**
 * Shared test helpers — reusable across all test files.
 */
import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IterationMetric } from "./loop/types.js";
import type { Metrics } from "./types/parse-results.js";

/**
 * Creates a mock child process with configurable exit code and optional stdout/stderr data.
 */
export function createMockProcess(
  exitCode: number,
  stdoutData?: string,
  stderrData?: string,
) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdoutData) proc.stdout.push(stdoutData);
    if (stderrData) proc.stderr.push(stderrData);
    proc.stdout.push(null);
    proc.stderr.push(null);
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

/**
 * Creates a temp dir, runs fn, cleans up in finally.
 */
export async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sync version of withTmpDir.
 */
export function withTmpDirSync(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Sample metrics for testing */
export const sampleMetrics: Metrics = {
  totalPnl: 250,
  numTrades: 180,
  profitFactor: 1.65,
  maxDrawdownPct: 6.5,
  winRate: 32,
  avgR: 0.22,
};

/** Sample iteration metrics for testing */
export const sampleIterationMetrics: IterationMetric[] = [
  { iter: 1, pnl: 200, pf: 1.4, dd: 5.5, wr: 22, trades: 180, verdict: "neutral" },
  { iter: 2, pnl: 230, pf: 1.5, dd: 5.0, wr: 24, trades: 175, verdict: "improved" },
  { iter: 3, pnl: 180, pf: 1.3, dd: 7.0, wr: 20, trades: 190, verdict: "degraded" },
];

/** Sample pine content for testing */
export const samplePineContent = `//@version=5
strategy("Test Strategy", overlay=true, commission_type=strategy.commission.percent, commission_value=0.075)

atrMult = input.float(4.5, "ATR Multiplier")
useRsi = input.bool(true, "Use RSI Filter")

plot(close)
`;
