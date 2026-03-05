import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import { cac } from "cac";
import { isMainModule } from "@breaker/kit";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const KNOWN_STRATEGIES: ReadonlyArray<{ name: string; asset: string }> = [
  { name: "donchian-adx", asset: "btc" },
  { name: "keltner-rsi2", asset: "btc" },
  { name: "ema-pullback", asset: "sol" },
];

/**
 * Rewrite relative imports: add one extra `../` level of depth.
 * Source strategies use `../../types/` etc; deployed need `../../../types/`.
 * Handles both single and double quotes.
 */
export function rewriteImports(content: string): string {
  // Match: from "../../ (source level) → from "../../../ (deployed level)
  return content.replace(/from\s+(["'])(\.\.\/)/g, 'from $1../$2');
}

interface PromoteOptions {
  strategiesDir?: string;
  fromCheckpoint?: string;
  asset?: string;
}

interface PromoteResult {
  success: boolean;
  error?: string;
  hash?: string;
}

/**
 * Promote a strategy to the deployed/ directory.
 * Reads source from `strategies/{asset}/{name}.ts` → rewrites imports → writes to `strategies/{asset}/deployed/{name}.ts`.
 */
export function promoteStrategy(
  name: string,
  options: PromoteOptions = {},
): PromoteResult {
  const strategiesDir = options.strategiesDir ?? join(__dirname, "../strategies");
  const asset = options.asset ?? KNOWN_STRATEGIES.find((s) => s.name === name)?.asset;

  if (!asset) {
    return { success: false, error: `Unknown strategy "${name}" — cannot determine asset` };
  }

  const deployedDir = join(strategiesDir, asset, "deployed");

  const sourcePath = options.fromCheckpoint
    ? join(options.fromCheckpoint, `${name}.ts`)
    : join(strategiesDir, asset, `${name}.ts`);

  if (!existsSync(sourcePath)) {
    return { success: false, error: `Source file not found: ${sourcePath}` };
  }

  const sourceContent = readFileSync(sourcePath, "utf-8");
  const rewritten = rewriteImports(sourceContent);
  const destPath = join(deployedDir, `${name}.ts`);

  writeFileAtomic.sync(destPath, rewritten);

  const hash = createHash("sha256").update(rewritten).digest("hex").slice(0, 12);

  return { success: true, hash };
}

function main() {
  const cli = cac("promote");

  cli
    .command("[strategy]", "Promote a strategy to deployed/")
    .option("--all", "Promote all known strategies")
    .option("--asset <asset>", "Asset for the strategy (btc, sol)")
    .option("--from-checkpoint <path>", "Promote from a refiner checkpoint directory")
    .action((strategy: string | undefined, options: { all?: boolean; asset?: string; fromCheckpoint?: string }) => {
      const strategies = options.all
        ? KNOWN_STRATEGIES.map((s) => ({ name: s.name, asset: s.asset }))
        : strategy
          ? [{ name: strategy, asset: options.asset ?? KNOWN_STRATEGIES.find((s) => s.name === strategy)?.asset ?? "" }]
          : [];

      if (strategies.length === 0) {
        console.error("Usage: pnpm promote <strategy-name> or pnpm promote --all");
        console.error(`Known strategies: ${KNOWN_STRATEGIES.map((s) => `${s.name} (${s.asset})`).join(", ")}`);
        process.exit(1);
      }

      const results: Array<{ name: string; result: PromoteResult }> = [];

      for (const { name, asset } of strategies) {
        console.log(`Promoting ${name} (${asset})...`);
        const result = promoteStrategy(name, {
          asset,
          fromCheckpoint: options.fromCheckpoint,
        });

        results.push({ name, result });

        if (!result.success) {
          console.error(`  FAILED: ${result.error}`);
        } else {
          console.log(`  OK (hash: ${result.hash})`);
        }
      }

      const failed = results.filter((r) => !r.result.success);
      if (failed.length > 0) {
        console.error(`\n${failed.length} strategy(ies) failed to promote.`);
        process.exit(1);
      }

      // Typecheck after promotion
      console.log("\nRunning typecheck...");
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
