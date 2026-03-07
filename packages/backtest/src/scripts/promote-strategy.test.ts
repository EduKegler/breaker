import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteImports, promoteStrategy, KNOWN_STRATEGIES } from "./promote-strategy.js";

describe("rewriteImports", () => {
  it("rewrites ../../../ imports to ../../../../ (source → deployed depth)", () => {
    const input = `import { ema } from "../../../indicators/ema.js";
import type { Candle } from "../../../types/candle.js";
import { atr } from "../../../indicators/atr.js";`;

    const result = rewriteImports(input);

    expect(result).toBe(`import { ema } from "../../../../indicators/ema.js";
import type { Candle } from "../../../../types/candle.js";
import { atr } from "../../../../indicators/atr.js";`);
  });

  it("handles single-quoted imports", () => {
    const input = `import { ema } from '../../../indicators/ema.js';`;
    const result = rewriteImports(input);
    expect(result).toBe(`import { ema } from '../../../../indicators/ema.js';`);
  });

  it("does not rewrite non-relative imports", () => {
    const input = `import { something } from "some-package";`;
    const result = rewriteImports(input);
    expect(result).toBe(input);
  });

  it("does not rewrite ./ (same directory) imports", () => {
    const input = `import { helper } from "./helper.js";`;
    const result = rewriteImports(input);
    expect(result).toBe(input);
  });

  it("handles mixed relative and package imports", () => {
    const input = `import { donchian } from "../../../indicators/donchian.js";
import type { Strategy } from "../../../types/strategy.js";
import { isMainModule } from "@breaker/kit";`;

    const result = rewriteImports(input);

    expect(result).toContain(`from "../../../../indicators/donchian.js"`);
    expect(result).toContain(`from "../../../../types/strategy.js"`);
    expect(result).toContain(`from "@breaker/kit"`);
  });
});

describe("promoteStrategy", () => {
  let tmpDir: string;
  let strategiesDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `promote-test-${Date.now()}`);
    strategiesDir = join(tmpDir, "src/strategies");
    mkdirSync(join(strategiesDir, "btc", "breakout", "deployed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("promotes a strategy from source to {asset}/{category}/deployed/", () => {
    const sourceContent = `import { ema } from "../../../indicators/ema.js";
import type { Candle } from "../../../types/candle.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "breakout", "test-strat.ts"), sourceContent);

    const result = promoteStrategy("test-strat", { strategiesDir, asset: "btc", category: "breakout" });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(strategiesDir, "btc", "breakout", "deployed", "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../../../indicators/ema.js"`);
    expect(deployed).toContain(`from "../../../../types/candle.js"`);
    expect(deployed).not.toContain(`from "../../../indicators/ema.js"`);
  });

  it("promotes from a checkpoint path", () => {
    const checkpointDir = join(tmpDir, "checkpoints");
    mkdirSync(checkpointDir, { recursive: true });

    const checkpointContent = `import { rsi } from "../../../indicators/rsi.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(checkpointDir, "test-strat.ts"), checkpointContent);

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      asset: "btc",
      category: "breakout",
      fromCheckpoint: checkpointDir,
    });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(strategiesDir, "btc", "breakout", "deployed", "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../../../indicators/rsi.js"`);
  });

  it("returns error if source file does not exist", () => {
    const result = promoteStrategy("nonexistent", { strategiesDir, asset: "btc", category: "breakout" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error if checkpoint file does not exist", () => {
    const result = promoteStrategy("nonexistent", {
      strategiesDir,
      asset: "btc",
      category: "breakout",
      fromCheckpoint: join(tmpDir, "no-such-dir"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error for unknown strategy without explicit asset", () => {
    const result = promoteStrategy("unknown-strat", { strategiesDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot determine asset");
  });

  it("returns error for unknown strategy without explicit category", () => {
    const result = promoteStrategy("unknown-strat", { strategiesDir, asset: "btc" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot determine category");
  });

  it("auto-detects asset and category from KNOWN_STRATEGIES", () => {
    const sourceContent = `import { ema } from "../../../indicators/ema.js";
export function createDonchianAdx() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "breakout", "donchian-adx.ts"), sourceContent);

    const result = promoteStrategy("donchian-adx", { strategiesDir });
    expect(result.success).toBe(true);
  });
});

describe("promoteStrategy with params baking", () => {
  let tmpDir: string;
  let strategiesDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `promote-bake-${Date.now()}`);
    strategiesDir = join(tmpDir, "src/strategies");
    mkdirSync(join(strategiesDir, "btc", "breakout", "deployed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bakes params from explicit paramsFile into deployed source", () => {
    const sourceContent = `import { ema } from "../../../indicators/ema.js";
const DEFAULT_PARAMS = {
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true },
  tpRR: { value: 2, min: 1.5, max: 3, step: 0.5, optimizable: true },
};
export function createTestStrat() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "breakout", "test-strat.ts"), sourceContent);

    const paramsFile = join(tmpDir, "best-params.json");
    writeFileSync(paramsFile, JSON.stringify({ volMult: 2, tpRR: 1.5 }));

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      asset: "btc",
      category: "breakout",
      paramsFile,
    });

    expect(result.success).toBe(true);
    expect(result.bakedParams).toEqual(["volMult", "tpRR"]);

    const deployed = readFileSync(join(strategiesDir, "btc", "breakout", "deployed", "test-strat.ts"), "utf-8");
    expect(deployed).toContain("volMult: { value: 2,");
    expect(deployed).toContain("tpRR: { value: 1.5,");
  });

  it("reports stale params that don't exist in source", () => {
    const sourceContent = `const DEFAULT_PARAMS = {
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true },
};
export function createTestStrat() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "breakout", "test-strat.ts"), sourceContent);

    const paramsFile = join(tmpDir, "best-params.json");
    writeFileSync(paramsFile, JSON.stringify({ volMult: 2, dcSlow: 55 }));

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      asset: "btc",
      category: "breakout",
      paramsFile,
    });

    expect(result.success).toBe(true);
    expect(result.bakedParams).toEqual(["volMult"]);
    expect(result.staleParams).toEqual(["dcSlow"]);
  });

  it("ignores corrupt params file gracefully", () => {
    const sourceContent = `export function createTestStrat() { return {}; }`;
    writeFileSync(join(strategiesDir, "btc", "breakout", "test-strat.ts"), sourceContent);

    const paramsFile = join(tmpDir, "bad-params.json");
    writeFileSync(paramsFile, "not json{{{");

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      asset: "btc",
      category: "breakout",
      paramsFile,
    });

    expect(result.success).toBe(true);
    expect(result.bakedParams).toBeUndefined();
  });
});

describe("KNOWN_STRATEGIES", () => {
  it("lists the known strategies with assets and categories", () => {
    expect(KNOWN_STRATEGIES).toEqual([
      { name: "donchian-adx", asset: "btc", category: "breakout" },
    ]);
  });
});
