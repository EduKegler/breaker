import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { acquireLock, acquireLockBlocking, releaseLock, readLock, lockPath } from "./lock.js";

const TEST_ASSET = "TEST_LOCK_" + process.pid;

afterEach(() => {
  // Clean up test locks
  const file = lockPath(TEST_ASSET);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe("acquireLock / releaseLock", () => {
  it("acquires lock when none exists", () => {
    acquireLock(TEST_ASSET);
    const data = readLock(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(data!.asset).toBe(TEST_ASSET);
    releaseLock(TEST_ASSET);
  });

  it("throws when lock is held by a live process (self)", () => {
    acquireLock(TEST_ASSET);
    expect(() => acquireLock(TEST_ASSET)).toThrow(/Lock held by PID/);
    releaseLock(TEST_ASSET);
  });

  it("removes stale lock when PID is dead", () => {
    // Write a lock with a non-existent PID
    const file = lockPath(TEST_ASSET);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, ts: Date.now(), asset: TEST_ASSET }));

    // Should not throw — stale lock gets cleaned up
    acquireLock(TEST_ASSET);
    const data = readLock(TEST_ASSET);
    expect(data!.pid).toBe(process.pid);
    releaseLock(TEST_ASSET);
  });

  it("handles corrupted lock file gracefully", () => {
    const file = lockPath(TEST_ASSET);
    fs.writeFileSync(file, "not json{{{");

    // Should not throw — corrupted lock gets removed
    acquireLock(TEST_ASSET);
    const data = readLock(TEST_ASSET);
    expect(data!.pid).toBe(process.pid);
    releaseLock(TEST_ASSET);
  });

  it("releaseLock only removes own lock", () => {
    const file = lockPath(TEST_ASSET);
    const foreignLock = { pid: 999999, ts: Date.now(), asset: TEST_ASSET };
    fs.writeFileSync(file, JSON.stringify(foreignLock));

    // Should NOT remove — not our PID
    releaseLock(TEST_ASSET);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("releaseLock is safe when no lock exists", () => {
    // Should not throw
    expect(() => releaseLock(TEST_ASSET)).not.toThrow();
  });

  it("readLock returns null when no lock exists", () => {
    expect(readLock(TEST_ASSET)).toBeNull();
  });

  it("readLock returns null for corrupted lock file", () => {
    const file = lockPath(TEST_ASSET);
    fs.writeFileSync(file, "not valid json{{{");
    expect(readLock(TEST_ASSET)).toBeNull();
  });

  it("releaseLock removes corrupted lock file", () => {
    const file = lockPath(TEST_ASSET);
    fs.writeFileSync(file, "corrupted data!!!");
    releaseLock(TEST_ASSET);
    expect(fs.existsSync(file)).toBe(false);
  });
});

const BLOCKING_ASSET = "TEST_BLOCKING_" + process.pid;

afterEach(() => {
  try { fs.unlinkSync(lockPath(BLOCKING_ASSET)); } catch { /* ignore */ }
});

describe("acquireLockBlocking", () => {
  it("acquires immediately when lock is free", async () => {
    await acquireLockBlocking(BLOCKING_ASSET, { timeoutMs: 1000, pollMs: 50 });
    const data = readLock(BLOCKING_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    releaseLock(BLOCKING_ASSET);
  });

  it("waits and acquires when lock is released", async () => {
    // Simulate a lock held by a "live" PID (ourselves)
    acquireLock(BLOCKING_ASSET);

    // Release after 150ms
    setTimeout(() => releaseLock(BLOCKING_ASSET), 150);

    // Should wait and acquire (poll every 50ms, so picks it up within ~200ms)
    await acquireLockBlocking(BLOCKING_ASSET, { timeoutMs: 2000, pollMs: 50 });
    const data = readLock(BLOCKING_ASSET);
    expect(data!.pid).toBe(process.pid);
    releaseLock(BLOCKING_ASSET);
  });

  it("throws on timeout when lock is never released", async () => {
    // Write a lock with our own PID (alive, won't be cleaned as stale)
    acquireLock(BLOCKING_ASSET);

    await expect(
      acquireLockBlocking(BLOCKING_ASSET, { timeoutMs: 200, pollMs: 50 }),
    ).rejects.toThrow(/Timeout waiting for lock/);

    releaseLock(BLOCKING_ASSET);
  });
});
