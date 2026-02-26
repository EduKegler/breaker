import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_DIR = "/tmp";
const STALE_MS = 600_000;

export interface LockData {
  pid: number;
  ts: number;
  asset: string;
}

export function lockPath(asset: string): string {
  return path.join(LOCK_DIR, `breaker-${asset}`);
}

function ensureSentinel(asset: string): string {
  const sentinel = lockPath(asset);
  if (!fs.existsSync(sentinel)) {
    fs.writeFileSync(sentinel, "");
  }
  return sentinel;
}

export function acquireLock(asset: string): void {
  const sentinel = ensureSentinel(asset);
  try {
    lockfile.lockSync(sentinel, { stale: STALE_MS, realpath: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`Lock already held for asset ${asset}`);
    }
    throw err;
  }
  // Write metadata to sentinel for readLock
  fs.writeFileSync(sentinel, JSON.stringify({ pid: process.pid, ts: Date.now(), asset }));
}

export function releaseLock(asset: string): void {
  const sentinel = lockPath(asset);
  try {
    lockfile.unlockSync(sentinel, { realpath: false });
  } catch {
    // Already unlocked or doesn't exist — safe to ignore
  }
}

export async function acquireLockBlocking(
  name: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const pollMs = opts?.pollMs ?? 5000;
  const sentinel = ensureSentinel(name);
  const retries = Math.ceil(timeoutMs / pollMs);

  try {
    await lockfile.lock(sentinel, {
      stale: STALE_MS,
      realpath: false,
      retries: { retries, factor: 1, minTimeout: pollMs, maxTimeout: pollMs },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`Timeout waiting for lock "${name}" after ${timeoutMs}ms`);
    }
    throw err;
  }
  fs.writeFileSync(sentinel, JSON.stringify({ pid: process.pid, ts: Date.now(), asset: name }));
}

export function readLock(asset: string): LockData | null {
  const sentinel = lockPath(asset);
  if (!fs.existsSync(sentinel)) return null;
  try {
    const locked = lockfile.checkSync(sentinel, { stale: STALE_MS, realpath: false });
    if (!locked) return null;
    return JSON.parse(fs.readFileSync(sentinel, "utf8")) as LockData;
  } catch {
    return null;
  }
}
