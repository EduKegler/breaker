import { execa } from "execa";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Run Claude CLI as async child process with periodic "still thinking" logs.
 * Replaces the hand-rolled spawn wrappers in optimize.ts and research.ts.
 */
export async function runClaude(
  args: string[],
  opts: { cwd: string; timeoutMs: number; label: string; env?: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const startTime = Date.now();

  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`  [${opts.label}] Claude still thinking... (${elapsed}s)`);
  }, 60000);

  try {
    const result = await execa("claude", args, {
      stdin: "ignore",
      timeout: opts.timeoutMs,
      reject: false,
      cwd: opts.cwd,
      env: opts.env ?? (process.env as NodeJS.ProcessEnv),
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      log(`  [${opts.label}] TIMEOUT after ${elapsed}s`);
      return {
        status: null,
        stdout: result.stdout,
        stderr: result.stderr + "\nKilled: timeout",
      };
    }

    log(`  [${opts.label}] Claude finished in ${elapsed}s`);
    return {
      status: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    clearInterval(ticker);
  }
}
