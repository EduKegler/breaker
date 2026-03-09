import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { buildSkeleton, kebabToFactory, generateSeed } from "./seed-generator.js";
import type { GenerateSeedOptions } from "./seed-generator.js";
import type { ModuleContext } from "../lib/build-module-context.js";

vi.mock("./stages/optimize.js", () => ({
  optimizeStrategy: vi.fn(),
}));

vi.mock("./stages/fix-strategy.js", () => ({
  fixStrategy: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { optimizeStrategy } from "./stages/optimize.js";
import { fixStrategy } from "./stages/fix-strategy.js";
import writeFileAtomic from "write-file-atomic";

const MODULE_CONTEXT: ModuleContext = {
  profile: "breakout",
  moduleId: "M1",
  moduleName: "Breakout",
  fixedRules: "1. Max free variables: 8",
  restructureLocks: "",
  varCap: 8,
  stoppingCriteria: "PF >= 1.3",
  signalTF: "15m",
  regimeTF: "4H or Daily",
  catalog: { slots: [] },
};

describe("kebabToFactory", () => {
  it("converts donchian-ema-timeout → createDonchianEmaTimeout", () => {
    expect(kebabToFactory("donchian-ema-timeout")).toBe("createDonchianEmaTimeout");
  });

  it("converts test-mean-reversion → createTestMeanReversion", () => {
    expect(kebabToFactory("test-mean-reversion")).toBe("createTestMeanReversion");
  });

  it("converts supertrend-adx-supertrend → createSupertrendAdxSupertrend", () => {
    expect(kebabToFactory("supertrend-adx-supertrend")).toBe("createSupertrendAdxSupertrend");
  });
});

describe("buildSkeleton", () => {
  it("produces a skeleton with the correct factory name", () => {
    const skeleton = buildSkeleton("createDonchianEmaTimeout");
    expect(skeleton).toContain("export function createDonchianEmaTimeout(");
    expect(skeleton).toContain("throw new Error");
    expect(skeleton).toContain("DEFAULT_PARAMS");
  });

  it("includes correct type imports", () => {
    const skeleton = buildSkeleton("createDonchianEmaTimeout");
    expect(skeleton).toContain('from "../../../types/strategy.js"');
    expect(skeleton).toContain('from "../../../types/candle.js"');
  });
});

describe("generateSeed", () => {
  const baseOpts: GenerateSeedOptions = {
    strategyDir: "/repo/packages/backtest/src/strategies/btc/breakout",
    repoRoot: "/repo/packages/refiner",
    kbPath: "/repo/packages/refiner/docs/knowledge-base.md",
    kbSection: 3,
    moduleContext: MODULE_CONTEXT,
    model: "claude-sonnet-4-6",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    vi.spyOn(fs, "readFileSync").mockReturnValue("## 3. Module 1: Breakout\n\n**Recommended first iteration:**\n\n> Donchian(20)\n\n**Variable budget:**\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives variant ID from KB starting components for M1", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: true,
      data: { changed: true, summary: "Generated strategy" },
    });

    const result = await generateSeed(baseOpts);

    expect(result.variantId).toBe("donchian-ema-timeout");
    expect(result.factoryName).toBe("createDonchianEmaTimeout");
    expect(result.strategyFile).toContain("donchian-ema-timeout.ts");
    expect(result.components["Entry Signal"]).toBe("donchian");
  });

  it("calls optimizeStrategy with restructure phase", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: true,
      data: { changed: true },
    });

    await generateSeed(baseOpts);

    const call = vi.mocked(optimizeStrategy).mock.calls[0][0];
    expect(call.phase).toBe("restructure");
    expect(call.prompt).toContain("createDonchianEmaTimeout");
    expect(call.prompt).toContain("Donchian(20)");
  });

  it("creates skeleton file with variant-derived factory name", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: true,
      data: { changed: true },
    });

    await generateSeed(baseOpts);

    expect(writeFileAtomic.sync).toHaveBeenCalledWith(
      expect.stringContaining("donchian-ema-timeout.ts"),
      expect.stringContaining("createDonchianEmaTimeout"),
      "utf8",
    );
  });

  it("falls back to fixStrategy on compile error", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: false,
      error: "typecheck_error: TS2345",
      errorClass: "compile_error",
    });
    vi.mocked(fixStrategy).mockResolvedValue({
      success: true,
      data: { changed: true },
    });

    const result = await generateSeed(baseOpts);

    expect(fixStrategy).toHaveBeenCalledOnce();
    expect(result.variantId).toBe("donchian-ema-timeout");
  });

  it("throws when both optimize and fix fail", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: false,
      error: "typecheck_error: TS2345",
      errorClass: "compile_error",
    });
    vi.mocked(fixStrategy).mockResolvedValue({
      success: false,
      error: "Fix did not resolve errors",
    });

    await expect(generateSeed(baseOpts)).rejects.toThrow(/Seed generation failed/);
  });

  it("throws when optimize produces no changes", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: true,
      data: { changed: false },
    });

    await expect(generateSeed(baseOpts)).rejects.toThrow(/Seed generation failed/);
  });

  it("uses M2 components when moduleId is M2", async () => {
    vi.mocked(optimizeStrategy).mockResolvedValue({
      success: true,
      data: { changed: true },
    });

    const m2Context: ModuleContext = { ...MODULE_CONTEXT, moduleId: "M2", moduleName: "Mean Reversion" };
    const result = await generateSeed({ ...baseOpts, moduleContext: m2Context });

    expect(result.variantId).toBe("keltner-rsi2-adx-low-midline");
    expect(result.factoryName).toBe("createKeltnerRsi2AdxLowMidline");
  });
});
