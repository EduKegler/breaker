import { describe, it, expect, vi, afterEach } from "vitest";
import type { Page } from "playwright";

const { mockWriteFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      writeFile: mockWriteFile,
    },
    writeFile: mockWriteFile,
  };
});

import {
  generateToken,
  injectToken,
  parseStrategyTitle,
  buildSaveName,
  launchArgs,
  runStep,
  readCompilationErrorsFromDom,
  assertNoCompilationErrors,
  parseDateRange,
} from "./run-backtest.js";

describe("generateToken", () => {
  it("returns a 6 character uppercase hex string", () => {
    const token = generateToken();
    expect(token.length).toBe(6);
    expect(token).toBe(token.toUpperCase());
  });

  it("generates different tokens on consecutive calls", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateToken()));
    // With 36^6 possibilities, 10 unique tokens is extremely likely
    expect(tokens.size).toBeGreaterThan(1);
  });
});

describe("injectToken", () => {
  it("injects token into strategy title", () => {
    const code = `strategy("STR Updated", overlay=true)`;
    const result = injectToken(code, "ABC123");
    expect(result).toBe(`strategy("STR Updated [ABC123]", overlay=true)`);
  });

  it("handles single quotes", () => {
    const code = `strategy('My Strategy', overlay=true)`;
    const result = injectToken(code, "XYZ");
    expect(result).toBe(`strategy('My Strategy [XYZ]', overlay=true)`);
  });

  it("does not modify code without strategy()", () => {
    const code = `indicator("My Indicator", overlay=true)`;
    const result = injectToken(code, "ABC");
    expect(result).toBe(code);
  });
});

describe("parseStrategyTitle", () => {
  it("extracts title from strategy() declaration", () => {
    expect(parseStrategyTitle(`strategy("STR Updated", overlay=true)`)).toBe(
      "STR Updated",
    );
  });

  it("returns null for non-strategy code", () => {
    expect(parseStrategyTitle(`indicator("My Indicator")`)).toBeNull();
  });

  it("handles single quotes", () => {
    expect(parseStrategyTitle(`strategy('Test')`)).toBe("Test");
  });
});

describe("buildSaveName", () => {
  it("derives name from strategy title", () => {
    const code = `strategy("Donchian Breakout", overlay=true)`;
    expect(buildSaveName(code)).toBe("Donchian Breakout - AUTO");
  });

  it("generates fallback name for non-strategy code", () => {
    const name = buildSaveName("// no strategy here");
    expect(name).toMatch(/^pine-auto-/);
  });

  it("truncates long names to 120 chars", () => {
    const longTitle = "A".repeat(200);
    const code = `strategy("${longTitle}", overlay=true)`;
    expect(buildSaveName(code).length).toBeLessThanOrEqual(120);
  });
});

describe("launchArgs", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns maximized/fullscreen args when not headless and fullscreen", () => {
    const args = launchArgs();
    expect(Array.isArray(args)).toBe(true);
  });

  it("returns array type", () => {
    const args = launchArgs();
    expect(args).toBeInstanceOf(Array);
    args.forEach((arg) => expect(typeof arg).toBe("string"));
  });
});

describe("runStep", () => {
  it("returns result on success", async () => {
    const result = await runStep("test-label", async () => 42);
    expect(result).toBe(42);
  });

  it("throws on error", async () => {
    await expect(
      runStep("fail-label", async () => {
        throw new Error("step failed");
      }),
    ).rejects.toThrow("step failed");
  });

  it("logs start and end", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStep("my-step", async () => "ok");
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: string) => c.includes("START my-step"))).toBe(true);
    expect(calls.some((c: string) => c.includes("END my-step") && c.includes("OK"))).toBe(true);
    spy.mockRestore();
  });

  it("logs error status on failure", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runStep("err-step", async () => { throw new Error("fail"); });
    } catch { /* expected */ }
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: string) => c.includes("END err-step") && c.includes("ERROR"))).toBe(true);
    spy.mockRestore();
  });
});

describe("parseDateRange", () => {
  it("parses preset 'last365'", () => {
    expect(parseDateRange("last365")).toEqual({ type: "preset", preset: "last365" });
  });

  it("parses preset 'all'", () => {
    expect(parseDateRange("all")).toEqual({ type: "preset", preset: "all" });
  });

  it("parses preset 'last7'", () => {
    expect(parseDateRange("last7")).toEqual({ type: "preset", preset: "last7" });
  });

  it("parses preset 'last30'", () => {
    expect(parseDateRange("last30")).toEqual({ type: "preset", preset: "last30" });
  });

  it("parses preset 'last90'", () => {
    expect(parseDateRange("last90")).toEqual({ type: "preset", preset: "last90" });
  });

  it("parses custom date range", () => {
    expect(parseDateRange("custom:2025-08-01:2026-02-01")).toEqual({
      type: "custom",
      startDate: "2025-08-01",
      endDate: "2026-02-01",
    });
  });

  it("throws on invalid preset", () => {
    expect(() => parseDateRange("last60")).toThrow(/Invalid date range/);
  });

  it("throws on custom with missing end date", () => {
    expect(() => parseDateRange("custom:2025-08-01")).toThrow(/Invalid custom date range/);
  });

  it("throws on empty string", () => {
    expect(() => parseDateRange("")).toThrow(/Invalid date range/);
  });
});

describe("readCompilationErrorsFromDom", () => {
  it("returns errors from page.evaluate", async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([
        { message: "Unexpected token", line: 10, column: 5 },
        { message: "Undeclared identifier", line: 20, column: 1 },
      ]),
    } as unknown as Page;

    const errors = await readCompilationErrorsFromDom(mockPage);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toBe("Unexpected token");
    expect(errors[0].line).toBe(10);
    expect(errors[1].message).toBe("Undeclared identifier");
  });

  it("returns empty array when no errors", async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([]),
    } as unknown as Page;

    const errors = await readCompilationErrorsFromDom(mockPage);
    expect(errors).toHaveLength(0);
  });

  it("returns fallback error when evaluate throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockPage = {
      evaluate: vi.fn().mockRejectedValue(new Error("page crashed")),
    } as unknown as Page;

    const errors = await readCompilationErrorsFromDom(mockPage);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("DOM evaluation failed");
    spy.mockRestore();
  });
});

describe("assertNoCompilationErrors", () => {
  afterEach(() => {
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it("does not throw when no errors", async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([]),
    } as unknown as Page;

    await expect(
      assertNoCompilationErrors(mockPage, "strategy('test')", "/tmp/errors.json"),
    ).resolves.not.toThrow();
  });

  it("throws and writes JSON when errors exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([
        { message: "Unexpected token", line: 2, column: 5 },
      ]),
    } as unknown as Page;

    const code = "line1\nline2\nline3\nline4\nline5";

    await expect(
      assertNoCompilationErrors(mockPage, code, "/tmp/test-errors.json"),
    ).rejects.toThrow("1 compilation error(s).");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/test-errors.json",
      expect.stringContaining("Unexpected token"),
      "utf8",
    );

    logSpy.mockRestore();
  });

  it("enriches errors with code snippets", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([
        { message: "Error on line 3", line: 3, column: 1 },
      ]),
    } as unknown as Page;

    const code = "line1\nline2\nline3_with_error\nline4\nline5";

    try {
      await assertNoCompilationErrors(mockPage, code, "/tmp/snippet-errors.json");
    } catch { /* expected */ }

    expect(mockWriteFile).toHaveBeenCalled();
    const writtenJson = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed.errors[0].snippet).toContain("line3_with_error");

    logSpy.mockRestore();
  });
});
