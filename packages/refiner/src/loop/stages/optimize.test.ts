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
import { optimizeStrategy } from "./optimize.js";

// ---------------------------------------------------------------------------
// optimizeStrategy
// ---------------------------------------------------------------------------

describe("optimizeStrategy", () => {
  const baseOpts = {
    prompt: "optimize prompt text",
    strategyFile: "/repo/packages/backtest/src/strategies/donchian-adx.ts",
    repoRoot: "/repo",
    model: "sonnet",
    phase: "refine" as const,
    artifactsDir: "/repo/artifacts",
    globalIter: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refine: returns paramOverrides from Claude's output", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '```json\n{ "paramOverrides": { "dcSlow": 55 } }\n```', stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same content")
      .mockReturnValueOnce("// same content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ dcSlow: 55 });
    expect(result.data?.changeScale).toBe("parametric");
    readSpy.mockRestore();
  });

  it("refine: returns changed=false when no paramOverrides in output", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "no changes needed", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("refine: reverts file if Claude unexpectedly edited it", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '{ "paramOverrides": { "dcSlow": 55 } }', stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before content")
      .mockReturnValueOnce("// after changed unexpectedly");

    const result = await optimizeStrategy(baseOpts);

    expect(vi.mocked(writeFileAtomic.sync)).toHaveBeenCalledWith(baseOpts.strategyFile, "// before content", "utf8");
    expect(result.success).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ dcSlow: 55 });
    readSpy.mockRestore();
  });

  it("restructure: returns changed=true when file changed and typecheck passes", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "restructured", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    vi.mocked(execaSync)
      .mockReturnValueOnce("") // typecheck passes
      .mockReturnValueOnce("diff output"); // git diff
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    expect(result.data?.changeScale).toBe("structural");
    readSpy.mockRestore();
  });

  it("restructure: reverts and returns error when typecheck fails", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "restructured", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    vi.mocked(execaSync).mockImplementation(() => {
      throw Object.assign(new Error("type error"), { stderr: "TS2345: blah" });
    });

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("typecheck_error");
    expect(vi.mocked(writeFileAtomic.sync)).toHaveBeenCalledWith(baseOpts.strategyFile, "// before", "utf8");
    readSpy.mockRestore();
  });

  it("returns changed=false when restructure produces no file change", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "claude error", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
    readSpy.mockRestore();
  });

  it("invokes Claude with correct model and flags", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// same");

    await optimizeStrategy(baseOpts);

    expect(execa).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--model", "sonnet",
        "--dangerously-skip-permissions",
        "--max-turns", "12",
        "-p",
      ]),
      expect.objectContaining({ cwd: "/repo" }),
    );
    readSpy.mockRestore();
  });

  it("uses max-turns 25 for restructure phase", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// same");

    await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(execa).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--max-turns", "25"]),
      expect.any(Object),
    );
    readSpy.mockRestore();
  });
});
