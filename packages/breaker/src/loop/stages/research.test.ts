import { describe, it, expect, vi } from "vitest";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { conductResearch } from "./research.js";
import type { ResearchBrief } from "./research.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

function createMockProcess(exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();
  // Emit close asynchronously
  setTimeout(() => proc.emit("close", exitCode), 10);
  return proc;
}

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

    // Mock spawn to create the file and exit 0
    (spawn as any).mockImplementation(() => {
      fs.writeFileSync(briefPath, JSON.stringify(brief));
      return createMockProcess(0);
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
    (spawn as any).mockImplementation(() => createMockProcess(1));

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
    (spawn as any).mockImplementation(() => createMockProcess(0));

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

    (spawn as any).mockImplementation(() => {
      fs.writeFileSync(briefPath, "not json {{{");
      return createMockProcess(0);
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
    (spawn as any).mockImplementation((_cmd: string, args: string[]) => {
      const prompt = args.find((a: string) => a.includes("Exhausted approaches"));
      expect(prompt).toBeDefined();
      return createMockProcess(1); // Will fail but we check the prompt
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
    // Create a process that never closes on its own
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn(() => {
      // Simulate process being killed
      proc.emit("close", null);
    });

    (spawn as any).mockImplementation(() => proc);

    const result = await conductResearch({
      asset: "BTC",
      currentMetrics: { pnl: 200, pf: 1.5, wr: 22, dd: 6 },
      exhaustedApproaches: [],
      artifactsDir: tmpDir,
      model: "claude-sonnet-4-6",
      timeoutMs: 50, // Very short timeout
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

    (spawn as any).mockImplementation(() => {
      fs.writeFileSync(briefPath, JSON.stringify(badBrief));
      return createMockProcess(0);
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

    // Mock spawn that does NOT create a new brief → should fail with "not created"
    // because the stale one was deleted
    (spawn as any).mockImplementation(() => createMockProcess(0));

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

    (spawn as any).mockImplementation(() => {
      fs.writeFileSync(briefPath, JSON.stringify(badBrief));
      return createMockProcess(0);
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
