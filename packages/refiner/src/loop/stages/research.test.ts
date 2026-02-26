import { describe, it, expect, vi } from "vitest";

vi.mock("./run-claude.js", () => ({
  runClaude: vi.fn(),
}));

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conductResearch } from "./research.js";
import type { ResearchBrief } from "./research.js";
import { runClaude } from "./run-claude.js";


describe("conductResearch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns success when brief file is created and valid", async () => {
    const briefPath = path.join(tmpDir, "research-brief.json");
    const brief: ResearchBrief = {
      queries: ["BTC 15m strategy"],
      findings: [{ source: "test", summary: "found something" }],
      suggestedApproaches: [{ name: "Test", indicators: ["RSI"], entryLogic: "buy low", rationale: "because" }],
      timestamp: new Date().toISOString(),
    };

    vi.mocked(runClaude).mockImplementation(async () => {
      fs.writeFileSync(briefPath, JSON.stringify(brief));
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.suggestedApproaches).toHaveLength(1);
  });

  it("returns failure when Claude exits non-zero", async () => {
    vi.mocked(runClaude).mockResolvedValue({ status: 1, stdout: "", stderr: "" });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("exit code");
  });

  it("returns failure when brief file not created", async () => {
    vi.mocked(runClaude).mockResolvedValue({ status: 0, stdout: "", stderr: "" });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not created");
  });

  it("returns failure when brief is invalid JSON", async () => {
    const briefPath = path.join(tmpDir, "research-brief.json");

    vi.mocked(runClaude).mockImplementation(async () => {
      fs.writeFileSync(briefPath, "not json {{{");
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  it("includes exhausted approaches in prompt", async () => {
    vi.mocked(runClaude).mockImplementation(async (args) => {
      const prompt = args.find((a: string) => a.includes("Exhausted approaches"));
      expect(prompt).toBeDefined();
      return { status: 1, stdout: "", stderr: "" };
    });

    await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: ["ATR Breakout", "EMA Cross"],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });
  });

  it("timeout triggers SIGTERM and returns failure", async () => {
    vi.mocked(runClaude).mockResolvedValue({
      status: null,
      stdout: "",
      stderr: "\nKilled: timeout",
    });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 50,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
  });

  it("returns failure when brief has no suggestedApproaches", async () => {
    const briefPath = path.join(tmpDir, "research-brief.json");
    const badBrief = {
      queries: ["test"],
      findings: [],
      timestamp: new Date().toISOString(),
      // missing suggestedApproaches
    };

    vi.mocked(runClaude).mockImplementation(async () => {
      fs.writeFileSync(briefPath, JSON.stringify(badBrief));
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("suggestedApproaches");
  });

  it("deletes stale research-brief.json before starting", async () => {
    const briefPath = path.join(tmpDir, "research-brief.json");
    // Write a stale brief
    fs.writeFileSync(briefPath, JSON.stringify({ stale: true }));
    expect(fs.existsSync(briefPath)).toBe(true);

    // Mock runClaude that does NOT create a new brief → should fail with "not created"
    // because the stale one was deleted
    vi.mocked(runClaude).mockResolvedValue({ status: 0, stdout: "", stderr: "" });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not created");
  });

  it("returns failure when suggestedApproaches is not an array", async () => {
    const briefPath = path.join(tmpDir, "research-brief.json");
    const badBrief = {
      queries: ["test"],
      findings: [],
      suggestedApproaches: "not an array",
      timestamp: new Date().toISOString(),
    };

    vi.mocked(runClaude).mockImplementation(async () => {
      fs.writeFileSync(briefPath, JSON.stringify(badBrief));
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 5000,
      repoRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("suggestedApproaches");
  });
});
