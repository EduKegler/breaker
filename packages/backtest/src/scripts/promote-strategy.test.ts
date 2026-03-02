import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteImports, promoteStrategy, KNOWN_STRATEGIES } from "./promote-strategy.js";

describe("rewriteImports", () => {
  it("rewrites ../ imports to ../../", () => {
    const input = `import { ema } from "../indicators/ema.js";
import type { Candle } from "../types/candle.js";
import { atr } from "../indicators/atr.js";`;

    const result = rewriteImports(input);

    expect(result).toBe(`import { ema } from "../../indicators/ema.js";
import type { Candle } from "../../types/candle.js";
import { atr } from "../../indicators/atr.js";`);
  });

  it("handles single-quoted imports", () => {
    const input = `import { ema } from '../indicators/ema.js';`;
    const result = rewriteImports(input);
    expect(result).toBe(`import { ema } from '../../indicators/ema.js';`);
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

  it("does not double-rewrite already ../../ imports", () => {
    const input = `import { ema } from "../../indicators/ema.js";`;
    const result = rewriteImports(input);
    expect(result).toBe(input);
  });

  it("handles mixed relative and package imports", () => {
    const input = `import { donchian } from "../indicators/donchian.js";
import type { Strategy } from "../types/strategy.js";
import { isMainModule } from "@breaker/kit";`;

    const result = rewriteImports(input);

    expect(result).toContain(`from "../../indicators/donchian.js"`);
    expect(result).toContain(`from "../../types/strategy.js"`);
    expect(result).toContain(`from "@breaker/kit"`);
  });
});

describe("promoteStrategy", () => {
  let tmpDir: string;
  let strategiesDir: string;
  let deployedDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `promote-test-${Date.now()}`);
    strategiesDir = join(tmpDir, "src/strategies");
    deployedDir = join(strategiesDir, "deployed");
    mkdirSync(deployedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("promotes a strategy from source to deployed/", () => {
    const sourceContent = `import { ema } from "../indicators/ema.js";
import type { Candle } from "../types/candle.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(strategiesDir, "test-strat.ts"), sourceContent);

    const result = promoteStrategy("test-strat", { strategiesDir });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(deployedDir, "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../indicators/ema.js"`);
    expect(deployed).toContain(`from "../../types/candle.js"`);
    expect(deployed).not.toContain(`from "../indicators/ema.js"`);
  });

  it("promotes from a checkpoint path", () => {
    const checkpointDir = join(tmpDir, "checkpoints");
    mkdirSync(checkpointDir, { recursive: true });

    const checkpointContent = `import { rsi } from "../indicators/rsi.js";

export function createTestStrategy() { return {}; }
`;
    writeFileSync(join(checkpointDir, "test-strat.ts"), checkpointContent);

    const result = promoteStrategy("test-strat", {
      strategiesDir,
      fromCheckpoint: checkpointDir,
    });

    expect(result.success).toBe(true);
    const deployed = readFileSync(join(deployedDir, "test-strat.ts"), "utf-8");
    expect(deployed).toContain(`from "../../indicators/rsi.js"`);
  });

  it("returns error if source file does not exist", () => {
    const result = promoteStrategy("nonexistent", { strategiesDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error if checkpoint file does not exist", () => {
    const result = promoteStrategy("nonexistent", {
      strategiesDir,
      fromCheckpoint: join(tmpDir, "no-such-dir"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("KNOWN_STRATEGIES", () => {
  it("lists the 3 known strategies", () => {
    expect(KNOWN_STRATEGIES).toEqual(["donchian-adx", "keltner-rsi2", "ema-pullback"]);
  });
});
