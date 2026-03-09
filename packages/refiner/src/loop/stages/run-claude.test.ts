import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execa BEFORE importing
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { runClaude } from "./run-claude.js";

describe("runClaude", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exit code 0 and collected stdout/stderr", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
    } as any);

    const result = await runClaude(["--model", "opus"], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(execa).toHaveBeenCalledWith(
      "claude",
      ["--model", "opus", "--output-format", "json"],
      expect.objectContaining({
        stdin: "ignore",
        timeout: 5000,
        reject: false,
        cwd: "/tmp",
      }),
    );
  });

  it("returns non-zero exit code", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "bad input",
      timedOut: false,
    } as any);

    const result = await runClaude(["arg"], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("bad input");
  });

  it("parses JSON output envelope and extracts text + num_turns", async () => {
    const jsonOutput = JSON.stringify({
      type: "result",
      result: "SUMMARY: changed tpRR 2→1.5",
      num_turns: 4,
    });
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: jsonOutput,
      stderr: "",
      timedOut: false,
    } as any);

    const result = await runClaude([], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("SUMMARY: changed tpRR 2→1.5");
    expect(result.estimatedTurns).toBe(4);
  });

  it("falls back to raw text when stdout is not valid JSON", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "plain text output",
      stderr: "",
      timedOut: false,
    } as any);

    const result = await runClaude([], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
    });

    expect(result.stdout).toBe("plain text output");
    expect(result.estimatedTurns).toBe(0);
  });

  it("timeout returns status null and appends timeout marker to stderr", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: undefined,
      stdout: "partial",
      stderr: "some err",
      timedOut: true,
    } as any);

    const result = await runClaude([], {
      cwd: "/tmp",
      timeoutMs: 20,
      label: "test",
    });

    expect(result.status).toBeNull();
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toContain("some err");
    expect(result.stderr).toContain("Killed: timeout");
  });

  it("uses custom env when provided", async () => {
    const customEnv = { ...process.env, CUSTOM_VAR: "yes" };
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    } as any);

    await runClaude([], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
      env: customEnv,
    });

    expect(execa).toHaveBeenCalledWith(
      "claude",
      ["--output-format", "json"],
      expect.objectContaining({ env: customEnv }),
    );
  });

  it("defaults env to process.env when not provided", async () => {
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    } as any);

    await runClaude([], {
      cwd: "/tmp",
      timeoutMs: 5000,
      label: "test",
    });

    expect(execa).toHaveBeenCalledWith(
      "claude",
      ["--output-format", "json"],
      expect.objectContaining({ env: process.env }),
    );
  });
});
