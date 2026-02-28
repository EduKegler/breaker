import fs from "node:fs";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import type { StageResult } from "../types.js";
import { runClaude } from "./run-claude.js";

interface FixResult {
  changed: boolean;
}

/**
 * Invoke Claude CLI with a pre-built fix prompt for TypeScript compilation errors.
 */
export async function fixStrategy(opts: {
  prompt: string;
  strategyFile: string;
  repoRoot: string;
  model: string;
}): Promise<StageResult<FixResult>> {
  const { prompt, strategyFile, repoRoot, model } = opts;

  try {
    const beforeContent = fs.readFileSync(strategyFile, "utf8");

    const result = await runClaude(
      ["--model", model, "--dangerously-skip-permissions", "-p", prompt],
      { cwd: repoRoot, timeoutMs: 180000, label: "fix" },
    );

    if (result.status !== 0) {
      return {
        success: false,
        error: `Claude CLI fix exited with code ${result.status}`,
      };
    }

    const afterContent = fs.readFileSync(strategyFile, "utf8");
    const changed = beforeContent !== afterContent;

    // Verify typecheck after fix
    if (changed) {
      try {
        execaSync("pnpm", ["--filter", "@breaker/backtest", "typecheck"], {
          cwd: repoRoot,
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        writeFileAtomic.sync(strategyFile, beforeContent, "utf8");
        return {
          success: false,
          error: "Fix attempt did not resolve typecheck errors",
          errorClass: "compile_error",
        };
      }
    }

    return { success: true, data: { changed } };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message || "fix failed",
    };
  }
}
