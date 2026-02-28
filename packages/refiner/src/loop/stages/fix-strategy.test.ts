import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execa BEFORE importing the module under test
vi.mock("execa", () => ({
  execa: vi.fn(),
  execaSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: Object.assign(vi.fn().mockResolvedValue(undefined), {
    sync: vi.fn(),
  }),
}));

import { execa, execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import fs from "node:fs";
import { fixStrategy } from "./fix-strategy.js";

describe("fixStrategy", () => {
  const fixOpts = {
    prompt: "fix prompt text",
    strategyFile: "/repo/packages/backtest/src/strategies/donchian-adx.ts",
    repoRoot: "/repo",
    model: "haiku",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success when Claude fixes and typecheck passes", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "fixed", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after fixed");
    vi.mocked(execaSync).mockReturnValue(""); // typecheck passes

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    readSpy.mockRestore();
  });

  it("reverts and returns failure when typecheck still fails after fix", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "tried fixing", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after still broken");
    vi.mocked(execaSync).mockImplementation(() => { throw new Error("TS error"); });

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("typecheck errors");
    expect(vi.mocked(writeFileAtomic.sync)).toHaveBeenCalledWith(fixOpts.strategyFile, "// before", "utf8");
    readSpy.mockRestore();
  });

  it("returns success with changed=false when file unchanged", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "no changes", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "fix error", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// content");

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
    readSpy.mockRestore();
  });
});
