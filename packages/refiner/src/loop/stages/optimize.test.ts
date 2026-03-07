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
import type { ModuleContext } from "../../lib/build-module-context.js";

// ---------------------------------------------------------------------------
// optimizeStrategy
// ---------------------------------------------------------------------------

const stubModuleContext: ModuleContext = {
  profile: "breakout",
  moduleId: "M1",
  moduleName: "Breakout",
  fixedRules: "1. Max free variables: 8",
  restructureLocks: "",
  varCap: 8,
  stoppingCriteria: "- Trades >= 50\n- PF >= 1.3",
  signalTF: "15m",
  regimeTF: "4H or Daily",
  catalog: { slots: [] },
};

describe("optimizeStrategy", () => {
  const baseOpts = {
    prompt: "optimize prompt text",
    strategyFile: "/repo/packages/backtest/src/strategies/donchian-adx.ts",
    repoRoot: "/repo",
    model: "sonnet",
    phase: "refine" as const,
    artifactsDir: "/repo/artifacts",
    globalIter: 1,
    moduleContext: stubModuleContext,
    existingParamCount: 5,
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

  it("refine: returns changed=false with summary when no paramOverrides in output", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "Analysis complete.\nNo single parameter change would improve the strategy.", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    expect(result.data?.summary).toContain("No single parameter change");
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

  it("returns changed=false with summary when restructure produces no file change", async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: "I reviewed the strategy but could not find a better structure.", stderr: "", timedOut: false } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    expect(result.data?.summary).toContain("could not find a better structure");
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

  it("refine: truncates multiple param changes to single change (KB §13.1)", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '```json\n{ "paramOverrides": { "dcSlow": 55, "volMult": 2.0, "tpRR": 3.0 } }\n```',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same content")
      .mockReturnValueOnce("// same content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    // Should only keep the first param change
    const keys = Object.keys(result.data?.paramOverrides ?? {});
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("dcSlow");
    readSpy.mockRestore();
  });

  it("refine: single param change passes through unchanged", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "timeoutBars": 48 } }',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ timeoutBars: 48 });
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

  // --- Fix 6: MODULE_CONSTRAINTS aligned with donchian-adx.ts params ---

  it("refine: bbKcPeriod clamped to constraint range", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "bbKcPeriod": 5 } }',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    // bbKcPeriod min is 14, so 5 should be clamped to 14
    expect(result.data?.paramOverrides).toEqual({ bbKcPeriod: 14 });
    expect(result.data?.validationWarnings).toBeDefined();
    readSpy.mockRestore();
  });

  it("refine: atrStopMult hard floor at 3.0", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "atrStopMult": 2.0 } }',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ atrStopMult: 3.0 });
    expect(result.data?.validationWarnings?.some((w) => w.includes("hard floor"))).toBe(true);
    readSpy.mockRestore();
  });

  it("refine: donchianPeriod accepted silently when not in MODULE_CONSTRAINTS", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "donchianPeriod": 30 } }',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    // donchianPeriod is NOT in M1 constraints but is accepted silently (seed/variant params differ from deployed)
    expect(result.data?.paramOverrides).toEqual({ donchianPeriod: 30 });
    const unknownWarnings = result.data?.validationWarnings?.filter((w) => w.includes("Unknown param")) ?? [];
    expect(unknownWarnings).toHaveLength(0);
    readSpy.mockRestore();
  });

  // --- Fix 1: extractParamOverrides SUMMARY fallback ---

  it("refine: extracts paramOverride from SUMMARY line with unicode arrow", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "Analysis complete.\nSUMMARY: tpRR 2→1.5\nDone.",
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ tpRR: 1.5 });
    readSpy.mockRestore();
  });

  it("refine: extracts paramOverride from SUMMARY line with ASCII arrow", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "SUMMARY: volMult 1.5 -> 2.0",
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ volMult: 2.0 });
    readSpy.mockRestore();
  });

  it("refine: SUMMARY multi-param keeps only first (KB §13.1)", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "SUMMARY: tpRR 2→1.5, volMult 1.5→2.0",
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    const keys = Object.keys(result.data?.paramOverrides ?? {});
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("tpRR");
    readSpy.mockRestore();
  });

  it("refine: extracts paramOverride from SUMMARY line with equals sign", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "SUMMARY: bbKcPeriod=20→14 para exaurir eixo",
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ bbKcPeriod: 14 });
    readSpy.mockRestore();
  });

  it("refine: JSON paramOverrides takes precedence over SUMMARY text", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "tpRR": 3.0 } }\nSUMMARY: tpRR 2→1.5',
      stderr: "", timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ tpRR: 3.0 });
    readSpy.mockRestore();
  });

  // --- Fix 2: max-turns revert in restructure ---

  it("restructure: reverts file when max-turns is hit", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "max turns reached",
      stderr: "warning: max turns (25) reached",
      timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before content")
      .mockReturnValueOnce("// after changed by partial edit");

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    expect(vi.mocked(writeFileAtomic.sync)).toHaveBeenCalledWith(baseOpts.strategyFile, "// before content", "utf8");
    readSpy.mockRestore();
  });

  it("restructure: does NOT revert when file is unchanged and max-turns is hit", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "max turns reached",
      stderr: "warning: max turns reached",
      timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same content")
      .mockReturnValueOnce("// same content");

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    // No revert needed since file didn't change
    expect(vi.mocked(writeFileAtomic.sync)).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("refine: ignores max-turns (param-only phase)", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '{ "paramOverrides": { "tpRR": 2.5 } }\nmax turns reached',
      stderr: "warning: max turns reached",
      timedOut: false,
    } as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    // Refine should still process paramOverrides even if max-turns hit
    expect(result.data?.changed).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ tpRR: 2.5 });
    readSpy.mockRestore();
  });
});
