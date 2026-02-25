import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Mock child_process BEFORE importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { runClaudeAsync, checkPineSyntax, optimizeStrategy, fixStrategy } from "./optimize.js";

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
      // Simulate the process closing after being killed
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

  it("destroys stdout and stderr streams on timeout", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    const stdoutDestroy = vi.spyOn(proc.stdout, "destroy");
    const stderrDestroy = vi.spyOn(proc.stderr, "destroy");
    vi.mocked(spawn).mockReturnValue(proc as any);

    await runClaudeAsync([], {
      ...defaultOpts,
      timeoutMs: 20,
    });

    expect(stdoutDestroy).toHaveBeenCalled();
    expect(stderrDestroy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkPineSyntax
// ---------------------------------------------------------------------------

describe("checkPineSyntax", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no errors in output", async () => {
    vi.mocked(execFileSync).mockReturnValue("OK: no issues found\n");

    const result = await checkPineSyntax("//@version=5\nstrategy('test')");

    expect(result).toBeNull();
  });

  it("always returns null (no-op stub — MCP server, not CLI)", async () => {
    const result = await checkPineSyntax("bad pine code");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// optimizeStrategy
// ---------------------------------------------------------------------------

describe("optimizeStrategy", () => {
  const baseOpts = {
    repoRoot: "/repo",
    resultJsonPath: "/repo/results.json",
    iter: 1,
    maxIter: 10,
    asset: "BTC",
    strategyFile: "/repo/assets/BTC/strategy.pine",
    model: "sonnet",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success with changed=true when content differs after Claude", async () => {
    // execFileSync: 1) build prompt (syntax check is now a no-op)
    vi.mocked(execFileSync)
      .mockReturnValueOnce("optimize prompt");
    // spawn runs Claude
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    // readFileSync: first call returns before, second returns after (different)
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before content")
      .mockReturnValueOnce("// after content");
    // execSync used for git diff
    vi.mocked(execSync).mockReturnValueOnce("diff output here");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    readSpy.mockRestore();
  });

  it("returns success with changed=false when content is same", async () => {
    vi.mocked(execFileSync).mockReturnValue("optimize prompt");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// same content")
      .mockReturnValueOnce("// same content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(false);
    expect(result.data?.diff).toBeUndefined();
    readSpy.mockRestore();
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(execFileSync).mockReturnValue("optimize prompt");
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, "", "claude error") as any);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("// content");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
    readSpy.mockRestore();
  });

  it("calls execFileSync to build prompt with correct args", async () => {
    vi.mocked(execFileSync).mockReturnValue("prompt text");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValue("// same");

    await optimizeStrategy({
      ...baseOpts,
      xlsxPath: "/repo/data.xlsx",
      phase: "refine",
      researchBriefPath: "/repo/brief.md",
    });

    expect(execFileSync).toHaveBeenCalledWith(
      "node",
      expect.arrayContaining([
        expect.stringContaining("build-optimize-prompt.js"),
        "/repo/results.json",
        "1",
        "10",
        "/repo/data.xlsx",
        "--phase=refine",
        "--research-brief-path=/repo/brief.md",
      ]),
      expect.objectContaining({ cwd: "/repo" }),
    );
    readSpy.mockRestore();
  });

  it("invokes Claude with correct model and flags", async () => {
    vi.mocked(execFileSync).mockReturnValue("prompt text");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValue("// same");

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

  it("succeeds even with changed content since syntax check is no-op", async () => {
    vi.mocked(execFileSync).mockReturnValueOnce("optimize prompt");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before content")
      .mockReturnValueOnce("// bad syntax content");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.mocked(execSync).mockReturnValueOnce("diff output");

    const result = await optimizeStrategy(baseOpts);

    // checkPineSyntax is a no-op now — changed content always succeeds
    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
    readSpy.mockRestore();
  });

  it("captures diff via git diff", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("optimize prompt");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    // execSync used for git diff
    vi.mocked(execSync).mockReturnValueOnce("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-// before\n+// after changed\n");

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.diff).toContain("+++ b/file");
    readSpy.mockRestore();
  });

  it('returns "(diff unavailable)" when git diff fails', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("optimize prompt")
      .mockReturnValueOnce("OK: no issues\n");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed");
    // git diff throws
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error("git error"); });

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(true);
    expect(result.data?.diff).toBe("(diff unavailable)");
    readSpy.mockRestore();
  });

  it("reads changeScale from metadata file", async () => {
    const optsWithArtifacts = {
      ...baseOpts,
      artifactsDir: "/repo/artifacts",
      globalIter: 3,
    };
    vi.mocked(execFileSync)
      .mockReturnValueOnce("optimize prompt")
      .mockReturnValueOnce("OK: no issues\n");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "done") as any);
    const readSpy = vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce("// before")
      .mockReturnValueOnce("// after changed")
      .mockReturnValueOnce(JSON.stringify({ changeApplied: { scale: "parametric" } }));
    vi.mocked(execSync).mockReturnValueOnce("diff text");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const result = await optimizeStrategy(optsWithArtifacts);

    expect(result.success).toBe(true);
    expect(result.data?.changeScale).toBe("parametric");
    readSpy.mockRestore();
  });

  it("returns failure when prompt build fails (execFileSync throws)", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("node script failed");
    });

    const result = await optimizeStrategy(baseOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("node script failed");
  });
});

// ---------------------------------------------------------------------------
// fixStrategy
// ---------------------------------------------------------------------------

describe("fixStrategy", () => {
  const fixOpts = {
    repoRoot: "/repo",
    model: "sonnet",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success on happy path", async () => {
    vi.mocked(execFileSync).mockReturnValue("fix prompt text");
    vi.mocked(spawn).mockReturnValue(createMockProcess(0, "fixed") as any);

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(true);
    expect(result.data?.changed).toBe(true);
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(execFileSync).mockReturnValue("fix prompt text");
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, "", "fix error") as any);

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exited with code 1");
  });

  it("returns failure when execFileSync throws", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("build-fix-prompt not found");
    });

    const result = await fixStrategy(fixOpts);

    expect(result.success).toBe(false);
    expect(result.error).toContain("build-fix-prompt not found");
  });
});
