import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ParseResultsOutput } from "../../types/parse-results.js";
import type { StageResult } from "../types.js";

/**
 * Run parse-results.js on an XLSX file and return the parsed output.
 */
export function parseResults(opts: {
  repoRoot: string;
  xlsxPath: string;
  asset: string;
  strategy?: string;
  strategyFile: string;
  iterStartTs?: number;
}): StageResult<ParseResultsOutput> {
  const { repoRoot, xlsxPath, asset, strategy, strategyFile, iterStartTs } = opts;

  const env = {
    ...process.env,
    ASSET: asset,
    ...(strategy ? { STRATEGY: strategy } : {}),
    PINE_FILE: strategyFile,
  };

  const args = [`--file=${xlsxPath}`];
  if (iterStartTs !== undefined) args.push(`--after=${iterStartTs}`);

  try {
    const stdout = execFileSync(
      "node",
      [path.join(repoRoot, "dist/automation/parse-results.js"), ...args],
      {
        env,
        cwd: repoRoot,
        timeout: 30000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // parse-results outputs JSON to stdout
    const parsed = JSON.parse(stdout) as ParseResultsOutput;

    // Validate required fields
    if (!parsed.metrics || typeof parsed.metrics !== "object") {
      return { success: false, error: "parse-results output missing 'metrics' field" };
    }

    // Cleanup XLSX after parsing
    try { fs.unlinkSync(xlsxPath); } catch { /* ignore */ }

    return { success: true, data: parsed };
  } catch (err) {
    const stderr = (() => {
      const e = err as { stderr?: Buffer | string };
      if (typeof e.stderr === "string") return e.stderr;
      if (Buffer.isBuffer(e.stderr)) return e.stderr.toString("utf8");
      return "";
    })().trim();
    return {
      success: false,
      error: stderr ? `${(err as Error).message} | stderr: ${stderr.slice(0, 500)}` : ((err as Error).message || "parse-results failed"),
    };
  }
}
