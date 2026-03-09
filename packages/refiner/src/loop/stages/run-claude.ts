import { execa } from "execa";

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function log(msg: string): void {
  console.log(`\x1b[2m${ts()}\x1b[0m ${msg}`);
}

/**
 * Parse the JSON envelope from `--output-format json`.
 * Returns the text result and num_turns, or falls back to raw stdout.
 */
function parseJsonOutput(raw: string): { text: string; numTurns: number } {
  try {
    const parsed = JSON.parse(raw);
    return {
      text: typeof parsed.result === "string" ? parsed.result : raw,
      numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : 0,
    };
  } catch {
    // If JSON parse fails, fall back to raw text
    return { text: raw, numTurns: 0 };
  }
}

/**
 * Run Claude CLI as async child process with periodic "still thinking" logs.
 * Replaces the hand-rolled spawn wrappers in optimize.ts and research.ts.
 *
 * Uses `--output-format json` to capture structured metadata (num_turns).
 * The returned `stdout` contains the extracted text result (not the JSON envelope).
 */
export async function runClaude(
  args: string[],
  opts: { cwd: string; timeoutMs: number; label: string; env?: NodeJS.ProcessEnv; cancelSignal?: AbortSignal },
): Promise<{ status: number | null; stdout: string; stderr: string; durationMs: number; estimatedTurns: number }> {
  const startTime = Date.now();

  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`  [${opts.label}] Claude still thinking... (${elapsed}s)`);
  }, 60000);

  try {
    const result = await execa("claude", [...args, "--output-format", "json"], {
      stdin: "ignore",
      timeout: opts.timeoutMs,
      reject: false,
      cwd: opts.cwd,
      env: opts.env ?? (process.env as NodeJS.ProcessEnv),
      ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {}),
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const durationMs = Date.now() - startTime;

    // Parse JSON envelope to extract text and num_turns
    const { text, numTurns } = parseJsonOutput(result.stdout);

    if (result.isCanceled) {
      log(`  [${opts.label}] CANCELED after ${elapsed}s`);
      return {
        status: null,
        stdout: text,
        stderr: result.stderr + "\nKilled: canceled",
        durationMs,
        estimatedTurns: numTurns,
      };
    }

    if (result.timedOut) {
      log(`  [${opts.label}] TIMEOUT after ${elapsed}s`);
      return {
        status: null,
        stdout: text,
        stderr: result.stderr + "\nKilled: timeout",
        durationMs,
        estimatedTurns: numTurns,
      };
    }

    log(`  [${opts.label}] Claude finished in ${elapsed}s`);
    return {
      status: result.exitCode ?? null,
      stdout: text,
      stderr: result.stderr,
      durationMs,
      estimatedTurns: numTurns,
    };
  } finally {
    clearInterval(ticker);
  }
}
