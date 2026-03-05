import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteImports, promoteStrategy, KNOWN_STRATEGIES } from "./promote-strategy.js";

describe("rewriteImports", () => {
  it("rewrites ../../ imports to ../../../ (source → deployed depth)", () => {
    const input = `import { ema } from "../../indicators/ema.js";
import type { Candle } from "../../types/candle.js";
import { atr } from "../../indicators/atr.js";`;

    const result = rewriteImports(input);

    expect(result).toBe(`import { ema } from "../../../indicators/ema.js";
import type { Candle } from "../../../types/candle.js";
import { atr } from "../../../indicators/atr.js";`);
  });

  it("handles single-quoted imports", () => {
    const input = `import { ema } from '../../indicators/ema.js';`;
    const result = rewriteImports(input);
    expect(result).toBe(`import { ema } from '../../../indicators/ema.js';`);
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
    const input = `import { donchian } from "../../indicators/donchian.js";
import type { Strategy } from "../../types/strategy.js";
import { isMainModule } from "@breaker/kit";`;

    const result = rewriteImports(input);

    expect(result).toContain(`from "../../../indicators/donchian.js"`);
    expect(result).toContain(`from "../../../types/strategy.js"`);
    expect(result).toContain(`from "@breaker/kit"`);
  });
});

describe("promoteStrategy", () => {
  let tmpDir: string;
  let strategiesDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `promote-test-${Date.now()}`);
    strategiesDir = join(tmpDir, "src/strategies");
    mkdirSync(join(strategiesDir, "btc", "deployed"), { recursive: true });
    mkdirSync(join(strategiesDir, "sol", "deployed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("promotes a strategy from source to {asset}/deployed/", () => {
    const sourceContent = `import { ema } from "../../indicators/ema.js";
import type { Candle } from "../../types/candle.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "test-strat.ts"), sourceContent);

    const result = promoteStrategy("test-strat", { strategiesDir, asset: "btc" });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(strategiesDir, "btc", "deployed", "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../../indicators/ema.js"`);
    expect(deployed).toContain(`from "../../../types/candle.js"`);
    expect(deployed).not.toContain(`from "../../indicators/ema.js"`);
  });

  it("promotes from a checkpoint path", () => {
    const checkpointDir = join(tmpDir, "checkpoints");
    mkdirSync(checkpointDir, { recursive: true });

    const checkpointContent = `import { rsi } from "../../indicators/rsi.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(checkpointDir, "test-strat.ts"), checkpointContent);

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      asset: "btc",
      fromCheckpoint: checkpointDir,
    });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(strategiesDir, "btc", "deployed", "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../../indicators/rsi.js"`);
  });

  it("returns error if source file does not exist", () => {
    const result = promoteStrategy("nonexistent", { strategiesDir, asset: "btc" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error if checkpoint file does not exist", () => {
    const result = promoteStrategy("nonexistent", {
      strategiesDir,
      asset: "btc",
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

  it("auto-detects asset from KNOWN_STRATEGIES", () => {
    const sourceContent = `import { ema } from "../../indicators/ema.js";
export function createDonchianAdx() { return {}; }
`;
    writeFileSync(join(strategiesDir, "btc", "donchian-adx.ts"), sourceContent);

    const result = promoteStrategy("donchian-adx", { strategiesDir });
    expect(result.success).toBe(true);
  });
});

describe("KNOWN_STRATEGIES", () => {
  it("lists the 3 known strategies with assets", () => {
    expect(KNOWN_STRATEGIES).toEqual([
      { name: "donchian-adx", asset: "btc" },
      { name: "keltner-rsi2", asset: "btc" },
      { name: "ema-pullback", asset: "sol" },
    ]);
  });
});
