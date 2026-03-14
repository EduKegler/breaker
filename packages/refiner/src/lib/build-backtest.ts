import path from "node:path";
import { execaSync } from "execa";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import fs from "node:fs";

const BUILD_LOCK_SENTINEL = "/tmp/breaker-build.lock";

function ensureSentinel(): string {
  if (!fs.existsSync(BUILD_LOCK_SENTINEL)) {
    writeFileAtomic.sync(BUILD_LOCK_SENTINEL, "");
  }
  return BUILD_LOCK_SENTINEL;
}

/**
 * Build @breaker/backtest with a cross-process mutex.
 *
 * Multiple refiner instances may trigger builds concurrently (seed generation,
 * variant switch, restructure). Since they all write to the same `dist/`,
 * we serialize builds via proper-lockfile.
 *
 * @param repoRoot — the refiner's repoRoot (packages/refiner). The monorepo
 *   root is resolved automatically.
 */
export async function buildBacktest(repoRoot: string): Promise<void> {
  const sentinel = ensureSentinel();
  const release = await lockfile.lock(sentinel, {
    stale: 120_000,
    realpath: false,
    retries: { retries: 20, minTimeout: 500, maxTimeout: 5_000 },
  });
  try {
    const monorepoRoot = path.resolve(repoRoot, "../..");
    execaSync("pnpm", ["--filter", "@breaker/backtest", "build"], {
      cwd: monorepoRoot,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    try {
      await release();
    } catch {
      // Already unlocked or stale — safe to ignore
    }
  }
}
