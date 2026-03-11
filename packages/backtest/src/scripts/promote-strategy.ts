import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import { cac } from "cac";
import { isMainModule } from "@breaker/kit";
import { bakeParamDefaults } from "../strategies/bake-param-defaults.js";
import { generateDeployedBarrel } from "./generate-deployed-barrel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover a strategy's asset and category by scanning the strategies directory.
 * Looks for `{asset}/{category}/{name}.ts` in the filesystem.
 */
export function findStrategy(
  name: string,
  strategiesDir: string,
): { asset: string; category: string } | null {
  if (!existsSync(strategiesDir)) return null;
  for (const asset of readdirSync(strategiesDir, { withFileTypes: true })) {
    if (!asset.isDirectory() || asset.name === "deployed") continue;
    const assetDir = join(strategiesDir, asset.name);
    for (const category of readdirSync(assetDir, { withFileTypes: true })) {
      if (!category.isDirectory() || category.name === "deployed") continue;
      const candidate = join(assetDir, category.name, `${name}.ts`);
      if (existsSync(candidate)) {
        return { asset: asset.name, category: category.name };
      }
    }
  }
  return null;
}

/**
 * Rewrite relative imports: add one extra `../` level of depth.
 * Source strategies use `../../../types/` etc; deployed need `../../../../types/`.
 * Handles both single and double quotes.
 */
export function rewriteImports(content: string): string {
  // Match: from "../../../ (source level) → from "../../../../ (deployed level)
  return content.replace(/from\s+(["'])(\.\.\/)/g, 'from $1../$2');
}

interface PromoteOptions {
  strategiesDir?: string;
  fromCheckpoint?: string;
  asset?: string;
  category?: string;
  /** Path to best-params.json to bake into defaults (auto-discovered if not set) */
  paramsFile?: string;
}

interface PromoteResult {
  success: boolean;
  error?: string;
  hash?: string;
  bakedParams?: string[];
  staleParams?: string[];
}

/**
 * Try to auto-discover best-params.json from the refiner assets directory.
 * Convention: packages/refiner/assets/{asset}/{category}/checkpoints/best-params.json
 */
function discoverParamsFile(strategiesDir: string, asset: string, category: string): string | null {
  const backtest = join(strategiesDir, "../..");
  const refinerAssets = join(backtest, "../../refiner/assets", asset);
  const paramsPath = join(refinerAssets, category, "checkpoints", "best-params.json");
  return existsSync(paramsPath) ? paramsPath : null;
}

/**
 * Promote a strategy to the deployed/ directory.
 * Reads source from `strategies/{asset}/{category}/{name}.ts` → bakes checkpoint params → rewrites imports → writes to `strategies/{asset}/{category}/deployed/{name}.ts`.
 */
export function promoteStrategy(
  name: string,
  options: PromoteOptions = {},
): PromoteResult {
  const strategiesDir = options.strategiesDir ?? join(__dirname, "../strategies");
  const found = findStrategy(name, strategiesDir);
  const asset = options.asset ?? found?.asset;
  const category = options.category ?? found?.category;

  if (!asset) {
    return { success: false, error: `Unknown strategy "${name}" — cannot determine asset` };
  }
  if (!category) {
    return { success: false, error: `Unknown strategy "${name}" — cannot determine category` };
  }

  const deployedDir = join(strategiesDir, asset, category, "deployed");
  mkdirSync(deployedDir, { recursive: true });

  const sourcePath = options.fromCheckpoint
    ? join(options.fromCheckpoint, `${name}.ts`)
    : join(strategiesDir, asset, category, `${name}.ts`);

  if (!existsSync(sourcePath)) {
    return { success: false, error: `Source file not found: ${sourcePath}` };
  }

  let sourceContent = readFileSync(sourcePath, "utf-8");

  // Bake checkpoint params into DEFAULT_PARAMS
  let bakedParams: string[] | undefined;
  let staleParams: string[] | undefined;
  const paramsFile = options.paramsFile ?? discoverParamsFile(strategiesDir, asset, category);
  if (paramsFile) {
    try {
      const params = JSON.parse(readFileSync(paramsFile, "utf-8")) as Record<string, number>;
      const result = bakeParamDefaults(sourceContent, params);
      sourceContent = result.source;
      if (result.applied.length > 0) bakedParams = result.applied;
      if (result.stale.length > 0) staleParams = result.stale;
    } catch { /* ignore corrupt params file */ }
  }

  const rewritten = rewriteImports(sourceContent);
  const destPath = join(deployedDir, `${name}.ts`);

  writeFileAtomic.sync(destPath, rewritten);

  const hash = createHash("sha256").update(rewritten).digest("hex").slice(0, 12);

  return { success: true, hash, bakedParams, staleParams };
}

/**
 * List all promotable strategies by scanning the strategies directory.
 */
function listStrategies(strategiesDir: string): Array<{ name: string; asset: string; category: string }> {
  const results: Array<{ name: string; asset: string; category: string }> = [];
  if (!existsSync(strategiesDir)) return results;
  for (const asset of readdirSync(strategiesDir, { withFileTypes: true })) {
    if (!asset.isDirectory() || asset.name === "deployed") continue;
    const assetDir = join(strategiesDir, asset.name);
    for (const category of readdirSync(assetDir, { withFileTypes: true })) {
      if (!category.isDirectory() || category.name === "deployed") continue;
      const catDir = join(assetDir, category.name);
      for (const file of readdirSync(catDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".ts")) continue;
        results.push({ name: file.name.replace(/\.ts$/, ""), asset: asset.name, category: category.name });
      }
    }
  }
  return results;
}

function main() {
  const cli = cac("promote");

  cli
    .command("[strategy]", "Promote a strategy to deployed/")
    .option("--all", "Promote all strategies found in strategies directory")
    .option("--asset <asset>", "Asset for the strategy (btc, sol)")
    .option("--category <category>", "Category for the strategy (breakout, mean-reversion)")
    .option("--from-checkpoint <path>", "Promote from a refiner checkpoint directory")
    .action((strategy: string | undefined, options: { all?: boolean; asset?: string; category?: string; fromCheckpoint?: string }) => {
      const strategiesDir = join(__dirname, "../strategies");
      const strategies = options.all
        ? listStrategies(strategiesDir)
        : strategy
          ? (() => {
              const found = findStrategy(strategy, strategiesDir);
              return [{ name: strategy, asset: options.asset ?? found?.asset ?? "", category: options.category ?? found?.category ?? "" }];
            })()
          : [];

      if (strategies.length === 0) {
        const all = listStrategies(strategiesDir);
        console.error("Usage: pnpm promote <strategy-name> or pnpm promote --all");
        if (all.length > 0) {
          console.error(`Available strategies: ${all.map((s) => `${s.name} (${s.asset}/${s.category})`).join(", ")}`);
        }
        process.exit(1);
      }

      const results: Array<{ name: string; result: PromoteResult }> = [];

      for (const { name, asset, category } of strategies) {
        console.log(`Promoting ${name} (${asset}/${category})...`);
        const result = promoteStrategy(name, {
          asset,
          category,
          fromCheckpoint: options.fromCheckpoint,
        });

        results.push({ name, result });

        if (!result.success) {
          console.error(`  FAILED: ${result.error}`);
        } else {
          console.log(`  OK (hash: ${result.hash})`);
          if (result.bakedParams?.length) {
            console.log(`  Baked params: ${result.bakedParams.join(", ")}`);
          }
          if (result.staleParams?.length) {
            console.log(`  Stale params (ignored): ${result.staleParams.join(", ")}`);
          }
        }
      }

      const failed = results.filter((r) => !r.result.success);
      if (failed.length > 0) {
        console.error(`\n${failed.length} strategy(ies) failed to promote.`);
        process.exit(1);
      }

      // Regenerate deployed barrel
      console.log("\nRegenerating deployed barrel...");
      generateDeployedBarrel();

      // Typecheck after promotion
      console.log("Running typecheck...");
      try {
        const pkgRoot = join(__dirname, "../..");
        execaSync("pnpm", ["typecheck"], { cwd: pkgRoot, stdio: "inherit" });
        console.log("Typecheck passed.");
      } catch {
        console.error("Typecheck FAILED. Deployed files may have import errors.");
        process.exit(1);
      }

      console.log(`\nPromoted ${results.length} strategy(ies). Run \`pnpm build\` to compile.`);
    });

  cli.help();
  cli.parse();
}

if (isMainModule(import.meta.url)) {
  main();
}
