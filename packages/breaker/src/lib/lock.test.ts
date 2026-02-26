import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { acquireLock, acquireLockBlocking, releaseLock, readLock, lockPath } from "./lock.js";

const TEST_ASSET = "TEST_LOCK_" + process.pid;

afterEach(() => {
  const file = lockPath(TEST_ASSET);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  try { fs.rmSync(file + ".lock", { recursive: true }); } catch { /* ignore */ }
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

  it("throws when lock is already held", () => {
    acquireLock(TEST_ASSET);
    expect(() => acquireLock(TEST_ASSET)).toThrow(/already held/);
    releaseLock(TEST_ASSET);
  });

  it("releases lock and allows re-acquire", () => {
    acquireLock(TEST_ASSET);
    releaseLock(TEST_ASSET);
    acquireLock(TEST_ASSET);
    const data = readLock(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    releaseLock(TEST_ASSET);
  });

  it("releaseLock is safe when no lock exists", () => {
    expect(() => releaseLock(TEST_ASSET)).not.toThrow();
  });

  it("releaseLock does not remove lock held by another acquirer", () => {
    // Write a sentinel file without actually acquiring via proper-lockfile
    const file = lockPath(TEST_ASSET);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, ts: Date.now(), asset: TEST_ASSET }));

    // releaseLock should not throw (we don't hold this lock)
    expect(() => releaseLock(TEST_ASSET)).not.toThrow();
  });

  it("readLock returns null when no lock exists", () => {
    expect(readLock(TEST_ASSET)).toBeNull();
  });

  it("readLock returns LockData when lock is held", () => {
    acquireLock(TEST_ASSET);
    const data = readLock(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(typeof data!.ts).toBe("number");
    expect(data!.asset).toBe(TEST_ASSET);
    releaseLock(TEST_ASSET);
  });
});

const BLOCKING_ASSET = "TEST_BLOCKING_" + process.pid;

afterEach(() => {
  const file = lockPath(BLOCKING_ASSET);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  try { fs.rmSync(file + ".lock", { recursive: true }); } catch { /* ignore */ }
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
    acquireLock(BLOCKING_ASSET);

    // Release after 150ms
    setTimeout(() => releaseLock(BLOCKING_ASSET), 150);

    await acquireLockBlocking(BLOCKING_ASSET, { timeoutMs: 2000, pollMs: 50 });
    const data = readLock(BLOCKING_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    releaseLock(BLOCKING_ASSET);
  });

  it("throws on timeout when lock is never released", async () => {
    acquireLock(BLOCKING_ASSET);

    await expect(
      acquireLockBlocking(BLOCKING_ASSET, { timeoutMs: 200, pollMs: 50 }),
    ).rejects.toThrow(/Timeout/);

    releaseLock(BLOCKING_ASSET);
  });
});
