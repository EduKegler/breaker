import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Mock child_process BEFORE importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { runClaudeAsync, extractParamOverrides, optimizeStrategy, fixStrategy } from "./optimize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcess(
  exitCode: number,
  stdoutData?: string,
  stderrData?: string,
) {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  setTimeout(() => {
    if (stdoutData) proc.stdout.push(stdoutData);
    if (stderrData) proc.stderr.push(stderrData);
    proc.stdout.push(null);
    proc.stderr.push(null);
    proc.emit("close", exitCode);
  }, 10);
  return proc;
}

const defaultOpts = {
  env: process.env as NodeJS.ProcessEnv,
  cwd: "/tmp",
  timeoutMs: 5000,
  label: "test",
};

// ---------------------------------------------------------------------------
// runClaudeAsync
// ---------------------------------------------------------------------------

describe("runClaudeAsync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with exit code 0 and collected stdout", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "hello world") as any);

    const result = await runClaudeAsync(["--model", "opus"], defaultOpts);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(spawn).toHaveBeenCalledWith("claude", ["--model", "opus"], expect.objectContaining({ cwd: "/tmp" }));
  });

  it("resolves with non-zero exit code", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, "", "bad input") as any);

    const result = await runClaudeAsync(["arg"], defaultOpts);

    expect(result.status).toBe(1);
  });

  it("collects stderr data", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "", "warning msg") as any);

    const result = await runClaudeAsync([], defaultOpts);

    expect(result.stderr).toBe("warning msg");
  });

  it("timeout kills process with SIGTERM and returns status null", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn(() => {
      setTimeout(() => {
        proc.stdout.push(null);
        proc.stderr.push(null);
      }, 5);
    });
    vi.mocked(spawn).mockReturnValue(proc as any);

    const result = await runClaudeAsync([], {
      ...defaultOpts,
      timeoutMs: 20,
    });

    expect(result.status).toBeNull();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns stderr with timeout marker on timeout", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(proc as any);

    const result = await runClaudeAsync([], {
      ...defaultOpts,
      timeoutMs: 20,
    });

    expect(result.status).toBeNull();
    expect(result.stderr).toContain("Killed: timeout");
  });
});

// ---------------------------------------------------------------------------
// extractParamOverrides
// ---------------------------------------------------------------------------

describe("extractParamOverrides", () => {
  it("extracts from JSON code block", () => {
    const text = `I'll change dcSlow to 55.\n\`\`\`json\n{ "paramOverrides": { "dcSlow": 55 } }\n\`\`\`\nDone.`;
    const result = extractParamOverrides(text);
    expect(result).toEqual({ dcSlow: 55 });
  });

  it("extracts from inline JSON", () => {
    const text = `Output: { "paramOverrides": { "atrLen": 14, "rsiLen": 2 } }`;
    const result = extractParamOverrides(text);
    expect(result).toEqual({ atrLen: 14, rsiLen: 2 });
  });

  it("returns null when no paramOverrides found", () => {
    const text = "I analyzed the strategy but couldn't find improvements.";
    expect(extractParamOverrides(text)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const text = '{ "paramOverrides": { "bad": }}';
    expect(extractParamOverrides(text)).toBeNull();
  });

  it("handles code block without json language tag", () => {
    const text = "```\n{ \"paramOverrides\": { \"dcFast\": 10 } }\n```";
    const result = extractParamOverrides(text);
    expect(result).toEqual({ dcFast: 10 });
  });
});

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
    vi.mocked(spawn).mockReturnValue(
      createMockProcess(0, '```json\n{ "paramOverrides": { "dcSlow": 55 } }\n```') as any,
    );
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
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "no changes needed") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("refine: reverts file if Claude unexpectedly edited it", async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockProcess(0, '{ "paramOverrides": { "dcSlow": 55 } }') as any,
    );
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before content")
      .mockReturnValueOnce("// after changed unexpectedly");
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    const result = await optimizeStrategy(baseOpts);

    expect(writeSpy).toHaveBeenCalledWith(baseOpts.strategyFile, "// before content", "utf8");
    expect(result.success).toBe(true);
    expect(result.data?.paramOverrides).toEqual({ dcSlow: 55 });
    readSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("restructure: returns changed=true when file changed and typecheck passes", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "restructured") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    vi.mocked(execSync)
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
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "restructured") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("type error"), { stderr: "TS2345: blah" });
    });

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("typecheck_error");
    expect(writeSpy).toHaveBeenCalledWith(baseOpts.strategyFile, "// before", "utf8");
    readSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("returns changed=false when restructure produces no file change", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, "", "claude error") as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
    readSpy.mockRestore();
  });

  it("invokes Claude with correct model and flags", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// same");

    await optimizeStrategy(baseOpts);

    expect(spawn).toHaveBeenCalledWith(
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
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// same");

    await optimizeStrategy({ ...baseOpts, phase: "restructure" });

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--max-turns", "25"]),
      expect.any(Object),
    );
    readSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fixStrategy
// ---------------------------------------------------------------------------

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
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "fixed") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after fixed");
    vi.mocked(execSync).mockReturnValue(""); // typecheck passes

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    readSpy.mockRestore();
  });

  it("reverts and returns failure when typecheck still fails after fix", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "tried fixing") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after still broken");
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.mocked(execSync).mockImplementation(() => { throw new Error("TS error"); });

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("typecheck errors");
    expect(writeSpy).toHaveBeenCalledWith(fixOpts.strategyFile, "// before", "utf8");
    readSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("returns success with changed=false when file unchanged", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "no changes") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same")
      .mockReturnValueOnce("// same");

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    readSpy.mockRestore();
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, "", "fix error") as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// content");

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
    readSpy.mockRestore();
  });
});
