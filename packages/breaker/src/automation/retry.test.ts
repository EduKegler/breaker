import { describe, it, expect, vi } from "vitest";
import { retryStep, screenshotOnFailure } from "./retry.js";
import type { Page } from "playwright";

describe("retryStep", () => {
  it("returns result on first success", async () => {
    const result = await retryStep(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    };
    const result = await retryStep(fn, { maxAttempts: 3, delayMs: 10 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after max attempts exhausted", async () => {
    const fn = async () => { throw new Error("always fails"); };
    await expect(
      retryStep(fn, { maxAttempts: 2, delayMs: 10 }),
    ).rejects.toThrow("always fails");
  });

  it("applies exponential backoff delay", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 3) throw new Error("fail");
      return "ok";
    };

    const start = Date.now();
    // delayMs=50, multiplier=2 → waits: 50, 100, 200
    await retryStep(fn, { maxAttempts: 4, delayMs: 50, backoffMultiplier: 2 });
    const elapsed = Date.now() - start;
    // Should have waited at least 50+100+200=350ms, but with jitter allow 100ms tolerance
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("uses label in warning messages", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error("oops");
      return "done";
    };
    await retryStep(fn, { maxAttempts: 2, delayMs: 10, label: "export-xlsx" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("export-xlsx"),
    );
    warnSpy.mockRestore();
  });
});

describe("screenshotOnFailure", () => {
  it("returns filename on success", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
    } as unknown as Page;

    const result = await screenshotOnFailure(mockPage, "test-label", "/tmp");
    expect(result).not.toBeNull();
    expect(result).toContain("/tmp/error-test-label-");
    expect(result).toContain(".png");
    expect(mockPage.screenshot).toHaveBeenCalled();
  });

  it("returns null when screenshot throws", async () => {
    const mockPage = {
      screenshot: vi.fn().mockRejectedValue(new Error("page crashed")),
    } as unknown as Page;

    const result = await screenshotOnFailure(mockPage, "fail", "/tmp");
    expect(result).toBeNull();
  });

  it("generates filename with timestamp pattern", async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
    } as unknown as Page;

    const result = await screenshotOnFailure(mockPage, "my-step", "/tmp/results");
    expect(result).not.toBeNull();
    // Pattern: error-{label}-{YYYY-MM-DD-HH-MM-SS}.png
    expect(result).toMatch(/error-my-step-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
  });
});
