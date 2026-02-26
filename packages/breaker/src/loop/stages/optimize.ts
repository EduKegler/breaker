import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "../types.js";

export interface OptimizeResult {
  changed: boolean;
  diff?: string;
  changeScale?: "parametric" | "structural";
  paramOverrides?: Record<string, number>;
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
 * Extract paramOverrides JSON from Claude's text output.
 * Looks for { "paramOverrides": { ... } } in code blocks or inline.
 */
export function extractParamOverrides(text: string): Record<string, number> | null {
  // Try JSON code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?"paramOverrides"[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed.paramOverrides && typeof parsed.paramOverrides === "object") {
        return parsed.paramOverrides;
      }
    } catch { /* try next pattern */ }
  }

  // Try inline JSON
  const inlineMatch = text.match(/\{\s*"paramOverrides"\s*:\s*\{[^}]*\}\s*\}/);
  if (inlineMatch) {
    try {
      const parsed = JSON.parse(inlineMatch[0]);
      if (parsed.paramOverrides && typeof parsed.paramOverrides === "object") {
        return parsed.paramOverrides;
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Invoke Claude CLI with a pre-built optimization prompt.
 * In refine phase: parses paramOverrides from Claude's output.
 * In restructure phase: checks if file changed, runs typecheck.
 */
export async function optimizeStrategy(opts: {
  prompt: string;
  strategyFile: string;
  repoRoot: string;
  model: string;
  phase: string;
  artifactsDir: string;
  globalIter: number;
  timeoutMs?: number;
}): Promise<StageResult<OptimizeResult>> {
  const { prompt, strategyFile, repoRoot, model, phase, artifactsDir, globalIter, timeoutMs = 900000 } = opts;

  try {
    const beforeContent = fs.readFileSync(strategyFile, "utf8");
    const maxTurns = phase === "restructure" ? 25 : 12;
    log(`  [optimize] prompt size: ${prompt.length} chars, model: ${model}, max-turns: ${maxTurns}`);

    const result = await runClaudeAsync(
      ["--model", model, "--dangerously-skip-permissions", "--max-turns", String(maxTurns), "-p", prompt],
      { env: process.env as NodeJS.ProcessEnv, cwd: repoRoot, timeoutMs, label: "optimize" },
    );

    if (result.status !== 0) {
      if (result.stdout) log(`  [optimize] stdout (last 500): ${result.stdout.slice(-500)}`);
      if (result.stderr) log(`  [optimize] stderr (last 500): ${result.stderr.slice(-500)}`);
      return {
        success: false,
        error: `Claude CLI exited with code ${result.status}: ${result.stderr?.slice(0, 500)}`,
      };
    }

    const afterContent = fs.readFileSync(strategyFile, "utf8");
    const fileChanged = beforeContent !== afterContent;

    // Refine phase: extract paramOverrides from Claude's output
    if (phase === "refine") {
      // Safety: if file changed during refine (unexpected), revert
      if (fileChanged) {
        log(`  [optimize] WARNING: file changed during refine phase — reverting`);
        fs.writeFileSync(strategyFile, beforeContent, "utf8");
      }

      const paramOverrides = extractParamOverrides(result.stdout);
      if (!paramOverrides || Object.keys(paramOverrides).length === 0) {
        return { success: true, data: { changed: false } };
      }

      return {
        success: true,
        data: { changed: true, changeScale: "parametric", paramOverrides },
      };
    }

    // Restructure/research phase: check if file changed, typecheck
    if (!fileChanged) {
      return { success: true, data: { changed: false } };
    }

    // Typecheck the modified strategy
    try {
      execSync("pnpm --filter @trading/backtest typecheck", {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      log("  [optimize] Typecheck passed");
    } catch (err) {
      const errMsg = (err as { stderr?: string }).stderr ?? (err as Error).message;
      log(`  [optimize] Typecheck FAILED: ${errMsg.slice(0, 300)}`);
      fs.writeFileSync(strategyFile, beforeContent, "utf8");
      return {
        success: false,
        error: `typecheck_error: ${errMsg.slice(0, 500)}`,
        errorClass: "compile_error",
      };
    }

    let diff: string | undefined;
    try {
      diff = execSync(`git diff --no-color "${strategyFile}"`, {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
      });
    } catch {
      diff = "(diff unavailable)";
    }

    // Read metadata for changeScale
    let changeScale: "parametric" | "structural" | undefined;
    try {
      const metaPath = path.join(artifactsDir, `iter${globalIter}-metadata.json`);
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        changeScale = meta.changeApplied?.scale;
      }
    } catch { /* ignore */ }

    return {
      success: true,
      data: { changed: true, diff, changeScale: changeScale ?? "structural" },
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message || "optimize failed",
    };
  }
}

/**
 * Invoke Claude CLI with a pre-built fix prompt for TypeScript compilation errors.
 */
export async function fixStrategy(opts: {
  prompt: string;
  strategyFile: string;
  repoRoot: string;
  model: string;
}): Promise<StageResult<OptimizeResult>> {
  const { prompt, strategyFile, repoRoot, model } = opts;

  try {
    const beforeContent = fs.readFileSync(strategyFile, "utf8");

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

    const afterContent = fs.readFileSync(strategyFile, "utf8");
    const changed = beforeContent !== afterContent;

    // Verify typecheck after fix
    if (changed) {
      try {
        execSync("pnpm --filter @trading/backtest typecheck", {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        fs.writeFileSync(strategyFile, beforeContent, "utf8");
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
