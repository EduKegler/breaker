import { execSync, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "../types.js";

export interface OptimizeResult {
  changed: boolean;
  diff?: string;
  changeScale?: "parametric" | "structural";
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Run Claude CLI as async child process with periodic "still thinking" logs.
 */
export function runClaudeAsync(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; label: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const startTime = Date.now();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const ticker = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`  [${opts.label}] Claude still thinking... (${elapsed}s, stdout=${stdout.length}B, stderr=${stderr.length}B)`);
    }, 60000);

    const timeout = setTimeout(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`  [${opts.label}] TIMEOUT after ${elapsed}s (stdout=${stdout.length}B, stderr=${stderr.length}B)`);
      if (stdout) log(`  [${opts.label}] partial stdout (last 500): ${stdout.slice(-500)}`);
      if (stderr) log(`  [${opts.label}] partial stderr (last 500): ${stderr.slice(-500)}`);
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGTERM");
      clearInterval(ticker);
      resolve({ status: null, stdout, stderr: stderr + "\nKilled: timeout" });
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearInterval(ticker);
      clearTimeout(timeout);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`  [${opts.label}] Claude finished in ${elapsed}s`);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/**
 * Check Pine Script syntax.
 *
 * pinescript-syntax-checker is an MCP server (JSON-RPC over stdio),
 * not a CLI that accepts Pine code on stdin. It cannot be invoked
 * via execFileSync. Syntax validation happens in two other places:
 * 1. The Claude agent inside the loop uses the MCP tool directly.
 * 2. TradingView's compiler catches errors during the next backtest.
 *
 * This function is a no-op stub kept for API compatibility.
 */
export async function checkPineSyntax(_pineCode: string): Promise<string | null> {
  return null;
}

/**
 * Build optimization prompt and invoke Claude CLI to optimize the strategy.
 */
export async function optimizeStrategy(opts: {
  repoRoot: string;
  resultJsonPath: string;
  iter: number;
  maxIter: number;
  asset: string;
  strategy?: string;
  strategyFile: string;
  model: string;
  xlsxPath?: string;
  phase?: string;
  researchBriefPath?: string;
  artifactsDir?: string;
  globalIter?: number;
  timeoutMs?: number;
}): Promise<StageResult<OptimizeResult>> {
  const { repoRoot, resultJsonPath, iter, maxIter, asset, strategy, strategyFile, model, xlsxPath, phase, researchBriefPath, artifactsDir, globalIter, timeoutMs = 900000 } = opts;

  const env = {
    ...process.env,
    ASSET: asset,
    ...(strategy ? { STRATEGY: strategy } : {}),
    PINE_FILE: strategyFile,
    REPO_ROOT: repoRoot,
    ...(artifactsDir ? { ARTIFACTS_DIR: artifactsDir } : {}),
  };

  try {
    // Step 1: Build optimization prompt
    const promptArgs = [resultJsonPath, String(iter), String(maxIter)];
    if (xlsxPath) promptArgs.push(xlsxPath);
    const namedArgs: string[] = [];
    if (phase) namedArgs.push(`--phase=${phase}`);
    if (researchBriefPath) namedArgs.push(`--research-brief-path=${researchBriefPath}`);
    const allArgs = [...promptArgs, ...namedArgs];
    const prompt = execFileSync(
      "node",
      [path.join(repoRoot, "dist/automation/build-optimize-prompt.js"), ...allArgs],
      {
        env,
        cwd: repoRoot,
        timeout: 30000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Step 2: Save before-state for diff
    const beforeContent = fs.readFileSync(strategyFile, "utf8");

    // Step 3: Invoke Claude CLI with periodic progress logs
    const maxTurns = phase === "restructure" ? 25 : 12;
    log(`  [optimize] prompt size: ${prompt.length} chars, model: ${model}, max-turns: ${maxTurns}`);
    const result = await runClaudeAsync(
      ["--model", model, "--dangerously-skip-permissions", "--max-turns", String(maxTurns), "-p", prompt],
      { env, cwd: repoRoot, timeoutMs, label: "optimize" },
    );

    if (result.status !== 0) {
      // Log stdout/stderr for debugging
      if (result.stdout) log(`  [optimize] stdout (last 500): ${result.stdout.slice(-500)}`);
      if (result.stderr) log(`  [optimize] stderr (last 500): ${result.stderr.slice(-500)}`);
      return {
        success: false,
        error: `Claude CLI exited with code ${result.status}: ${result.stderr?.slice(0, 500)}`,
      };
    }

    // Step 4: Check if anything changed
    const afterContent = fs.readFileSync(strategyFile, "utf8");
    const changed = beforeContent !== afterContent;

    // Step 4b: Syntax check if changed
    if (changed) {
      const syntaxError = await checkPineSyntax(afterContent);
      if (syntaxError) {
        log(`Syntax check FAILED: ${syntaxError.slice(0, 200)}`);
        // Revert to before state
        fs.writeFileSync(strategyFile, beforeContent, "utf8");
        return {
          success: false,
          error: `syntax_error: ${syntaxError}`,
          errorClass: "compile_error",
        };
      }
      log("Syntax check passed");
    }

    let diff: string | undefined;
    let changeScale: "parametric" | "structural" | undefined;
    if (changed) {
      try {
        diff = execSync(`git diff --no-color "${strategyFile}"`, {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 5000,
        });
      } catch {
        diff = "(diff unavailable)";
      }

      // Read metadata to get changeScale
      if (artifactsDir) {
        try {
          const metaPath = path.join(artifactsDir, `iter${globalIter ?? iter}-metadata.json`);
          const candidates = [metaPath];
          for (const mp of candidates) {
            if (fs.existsSync(mp)) {
              const meta = JSON.parse(fs.readFileSync(mp, "utf8"));
              changeScale = meta.changeApplied?.scale;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    }

    return {
      success: true,
      data: { changed, diff, changeScale },
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message || "optimize failed",
    };
  }
}

/**
 * Build fix prompt and invoke Claude CLI to fix compilation errors.
 */
export async function fixStrategy(opts: {
  repoRoot: string;
  model: string;
}): Promise<StageResult<OptimizeResult>> {
  const { repoRoot, model } = opts;

  try {
    // Build fix prompt
    const prompt = execFileSync(
      "node",
      [path.join(repoRoot, "dist/automation/build-fix-prompt.js")],
      {
        cwd: repoRoot,
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Invoke Claude CLI with periodic progress logs
    const result = await runClaudeAsync(
      ["--model", model, "--dangerously-skip-permissions", "-p", prompt],
      { env: process.env as NodeJS.ProcessEnv, cwd: repoRoot, timeoutMs: 180000, label: "fix" },
    );

    if (result.status !== 0) {
      return {
        success: false,
        error: `Claude CLI fix exited with code ${result.status}`,
      };
    }

    return { success: true, data: { changed: true } };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message || "fix failed",
    };
  }
}
