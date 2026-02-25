import fs from "node:fs";
import path from "node:path";

export interface LockData {
  pid: number;
  ts: number;
  asset: string;
}

const LOCK_DIR = "/tmp";

export function lockPath(asset: string): string {
  return path.join(LOCK_DIR, `breaker-${asset}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(asset: string): void {
  const file = lockPath(asset);

  // Try atomic create first (O_EXCL fails if file exists)
  try {
    const data: LockData = { pid: process.pid, ts: Date.now(), asset };
    fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" });
    return; // Lock acquired atomically
  } catch {
    // File exists — check if stale
  }

  let existing: LockData;
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as LockData;
  } catch {
    // Corrupted lock file — remove and retry atomically
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    const data: LockData = { pid: process.pid, ts: Date.now(), asset };
    fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" });
    return;
  }

  if (isPidAlive(existing.pid)) {
    throw new Error(
      `Lock held by PID ${existing.pid} for asset ${asset} (since ${new Date(existing.ts).toISOString()})`,
    );
  }

  // Stale lock — PID is dead. Remove and retry atomically.
  console.warn(
    `[lock] Removing stale lock for ${asset} (PID ${existing.pid} is dead)`,
  );
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  const data: LockData = { pid: process.pid, ts: Date.now(), asset };
  try {
    fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" });
  } catch {
    throw new Error(`Lock race: another process acquired lock for ${asset}`);
  }
}

export function releaseLock(asset: string): void {
  const file = lockPath(asset);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as LockData;
      // Only remove if we own it
      if (data.pid === process.pid) {
        fs.unlinkSync(file);
      }
    } catch {
      // Corrupted — safe to remove
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

export async function acquireLockBlocking(
  name: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 600000; // 10min default
  const pollMs = opts?.pollMs ?? 5000; // 5s poll
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      acquireLock(name);
      return; // got it
    } catch {
      // lock held — wait and retry
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error(`Timeout waiting for lock "${name}" after ${timeoutMs}ms`);
}

export function readLock(asset: string): LockData | null {
  const file = lockPath(asset);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockData;
  } catch {
    return null;
  }
}
