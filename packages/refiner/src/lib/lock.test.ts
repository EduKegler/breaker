import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { lock } from "./lock.js";

const TEST_ASSET = "TEST_LOCK_" + process.pid;

afterEach(() => {
  const file = lock.path(TEST_ASSET);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  try { fs.rmSync(file + ".lock", { recursive: true }); } catch { /* ignore */ }
});

describe("lock.acquire / lock.release", () => {
  it("acquires lock when none exists", () => {
    lock.acquire(TEST_ASSET);
    const data = lock.read(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(data!.asset).toBe(TEST_ASSET);
    lock.release(TEST_ASSET);
  });

  it("throws when lock is already held", () => {
    lock.acquire(TEST_ASSET);
    expect(() => lock.acquire(TEST_ASSET)).toThrow(/already held/);
    lock.release(TEST_ASSET);
  });

  it("releases lock and allows re-acquire", () => {
    lock.acquire(TEST_ASSET);
    lock.release(TEST_ASSET);
    lock.acquire(TEST_ASSET);
    const data = lock.read(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    lock.release(TEST_ASSET);
  });

  it("release is safe when no lock exists", () => {
    expect(() => lock.release(TEST_ASSET)).not.toThrow();
  });

  it("release does not remove lock held by another acquirer", () => {
    // Write a sentinel file without actually acquiring via proper-lockfile
    const file = lock.path(TEST_ASSET);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, ts: Date.now(), asset: TEST_ASSET }));

    // release should not throw (we don't hold this lock)
    expect(() => lock.release(TEST_ASSET)).not.toThrow();
  });

  it("read returns null when no lock exists", () => {
    expect(lock.read(TEST_ASSET)).toBeNull();
  });

  it("read returns LockData when lock is held", () => {
    lock.acquire(TEST_ASSET);
    const data = lock.read(TEST_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(typeof data!.ts).toBe("number");
    expect(data!.asset).toBe(TEST_ASSET);
    lock.release(TEST_ASSET);
  });
});

const BLOCKING_ASSET = "TEST_BLOCKING_" + process.pid;

afterEach(() => {
  const file = lock.path(BLOCKING_ASSET);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  try { fs.rmSync(file + ".lock", { recursive: true }); } catch { /* ignore */ }
});

describe("lock.acquireBlocking", () => {
  it("acquires immediately when lock is free", async () => {
    await lock.acquireBlocking(BLOCKING_ASSET, { timeoutMs: 1000, pollMs: 50 });
    const data = lock.read(BLOCKING_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    lock.release(BLOCKING_ASSET);
  });

  it("waits and acquires when lock is released", async () => {
    lock.acquire(BLOCKING_ASSET);

    // Release after 150ms
    setTimeout(() => lock.release(BLOCKING_ASSET), 150);

    await lock.acquireBlocking(BLOCKING_ASSET, { timeoutMs: 2000, pollMs: 50 });
    const data = lock.read(BLOCKING_ASSET);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    lock.release(BLOCKING_ASSET);
  });

  it("throws on timeout when lock is never released", async () => {
    lock.acquire(BLOCKING_ASSET);

    await expect(
      lock.acquireBlocking(BLOCKING_ASSET, { timeoutMs: 200, pollMs: 50 }),
    ).rejects.toThrow(/Timeout/);

    lock.release(BLOCKING_ASSET);
  });
});
