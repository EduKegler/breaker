import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { extractStartingPoint, getStartingComponents } from "../lib/build-module-context.js";
import type { ModuleContext } from "../lib/build-module-context.js";
import { buildVariantId } from "./variant-manager.js";
import { optimizeStrategy } from "./stages/optimize.js";
import { fixStrategy } from "./stages/fix-strategy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateSeedOptions {
  /** Directory where strategy files live: packages/backtest/src/strategies/{asset}/{category} */
  strategyDir: string;
  repoRoot: string;
  kbPath: string;
  kbSection: number;
  moduleContext: ModuleContext;
  model: string;
  cancelSignal?: AbortSignal;
}

export interface GenerateSeedResult {
  strategyFile: string;
  factoryName: string;
  variantId: string;
  components: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function log(msg: string): void {
  console.log(`\x1b[2m${ts()}\x1b[0m ${msg}`);
}

/**
 * Convert a kebab-case variant ID to a PascalCase factory name.
 * e.g., "donchian-ema-timeout" → "createDonchianEmaTimeout"
 */
export function kebabToFactory(kebab: string): string {
  const pascal = kebab
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `create${pascal}`;
}

/**
 * Build a minimal skeleton strategy file that typechecks but throws at runtime.
 * Claude will replace the implementation via optimizeStrategy (restructure mode).
 */
export function buildSkeleton(factoryName: string): string {
  return `import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import type { Candle } from "../../../types/candle.js";

const DEFAULT_PARAMS: Record<string, StrategyParam> = {};

export function ${factoryName}(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  throw new Error("Not implemented — seed skeleton awaiting generation");
}
`;
}

function buildSeedPrompt(
  strategyFile: string,
  factoryName: string,
  startingPoint: string,
  moduleContext: ModuleContext,
): string {
  const parts: string[] = [];

  parts.push(`# Task: Implement a ${moduleContext.moduleName} strategy from scratch

You must implement the strategy factory function \`${factoryName}\` in the file:
\`${strategyFile}\`

The file currently contains a skeleton with \`throw new Error("Not implemented")\`.
Replace it with a complete, working implementation.`);

  if (startingPoint) {
    parts.push(`
## KB Starting Point (Recommended first iteration)

${startingPoint}`);
  }

  parts.push(`
## Fixed Rules (from Knowledge Base)

${moduleContext.fixedRules}`);

  parts.push(`
## Requirements

1. The function must return a \`Strategy\` object matching the interface in \`types/strategy.ts\`
2. Use \`DEFAULT_PARAMS\` with \`StrategyParam\` objects (value, min, max, step, optimizable, description)
3. Apply \`paramOverrides\` to override default values
4. Implement \`init(candles, higherTimeframes)\` for O(n) indicator pre-computation
5. Implement \`onCandle(ctx)\` returning Signal or null
6. Implement \`shouldExit(ctx)\` returning Signal or null
7. Set \`requiredWarmup\` with correct bars per timeframe
8. Use indicators from \`src/indicators/\` (ema, sma, atr, rsi, adx, donchian, keltner, bollinger-bands, detect-squeeze)
9. Import types from \`../../../types/strategy.js\` and \`../../../types/candle.js\`
10. Import indicators from \`../../../indicators/{name}.js\`
11. Variable cap: ${moduleContext.varCap} optimizable params maximum
12. The strategy name format: "{ASSET} {TF} ${moduleContext.moduleName} — {Strategy Name}"

## Important conventions

- \`pctOfPosition\` in \`takeProfits\` is a fraction (0-1), NOT a percentage. Use 0.50 for 50%.
- ATR stop multiplier must be >= 3.0 (KB §1.6)
- Use previous-bar indicator values to avoid look-ahead bias
- Higher timeframe candles: use \`higherTimeframes?.get("1h")\` etc.

Read the existing strategy files in \`src/strategies/\` for reference on the expected pattern.
After implementing, run \`pnpm --filter @breaker/backtest typecheck\` to verify.`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate a seed strategy from a KB starting point specification.
 *
 * The seed is named using the variant naming convention (buildVariantId from
 * KB starting components) — because the seed IS the first variant.
 *
 * Creates a skeleton file, then uses Claude (via optimizeStrategy in restructure
 * mode) to implement the strategy based on the KB spec.
 */
export async function generateSeed(opts: GenerateSeedOptions): Promise<GenerateSeedResult> {
  const {
    strategyDir, repoRoot, kbPath, kbSection,
    moduleContext, model, cancelSignal,
  } = opts;

  // 1. Derive naming from KB starting components (same system as variant naming)
  const components = getStartingComponents(moduleContext.moduleId);
  const variantId = buildVariantId(components);
  const factoryName = kebabToFactory(variantId);
  const strategyFile = path.join(strategyDir, `${variantId}.ts`);

  log(`  [seed] Variant ID: ${variantId}, factory: ${factoryName}`);

  // 2. Create skeleton
  fs.mkdirSync(strategyDir, { recursive: true });
  writeFileAtomic.sync(strategyFile, buildSkeleton(factoryName), "utf8");
  log(`  [seed] Skeleton created: ${strategyFile}`);

  // 3. Extract starting point from KB
  let startingPoint = "";
  try {
    const kbContent = fs.readFileSync(kbPath, "utf8");
    startingPoint = extractStartingPoint(kbContent, kbSection);
  } catch { /* KB not available — prompt will still work without starting point */ }

  // 4. Build prompt and call Claude via optimizeStrategy (restructure mode)
  const prompt = buildSeedPrompt(strategyFile, factoryName, startingPoint, moduleContext);
  const artifactsDir = path.join(strategyDir, ".seed-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const result = await optimizeStrategy({
    prompt,
    strategyFile,
    repoRoot,
    model,
    phase: "restructure",
    artifactsDir,
    globalIter: 0,
    moduleContext,
    existingParamCount: 0,
    timeoutMs: 300000,
    cancelSignal,
  });

  if (result.success && result.data?.changed) {
    log(`  [seed] Strategy generated successfully`);
    return { strategyFile, factoryName, variantId, components };
  }

  // 5. If typecheck failed, try fixStrategy once
  if (result.errorClass === "compile_error" && result.error) {
    log(`  [seed] Generation had compile errors, attempting fix...`);

    const fixPrompt = [
      `Fix the TypeScript compilation errors in ${strategyFile}.`,
      `The strategy factory \`${factoryName}\` must compile and implement the ${moduleContext.moduleName} strategy pattern.`,
      `Error: ${result.error}`,
      `Read the file, fix the errors, and ensure \`pnpm --filter @breaker/backtest typecheck\` passes.`,
    ].join("\n");

    const fixResult = await fixStrategy({
      prompt: fixPrompt,
      strategyFile,
      repoRoot,
      model,
      cancelSignal,
    });

    if (fixResult.success && fixResult.data?.changed) {
      log(`  [seed] Strategy fixed successfully`);
      return { strategyFile, factoryName, variantId, components };
    }
  }

  throw new Error(`Seed generation failed: ${result.error ?? "no changes produced"}`);
}
