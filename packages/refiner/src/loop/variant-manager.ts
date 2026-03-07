/**
 * variant-manager.ts — Manages strategy variants across multiple CLI runs.
 *
 * Persists a variant-registry.json to track which variants have been tested,
 * their scores, and which is currently active. Each variant has its own
 * strategy file, checkpoint dir, and param history.
 *
 * Design: each CLI run refines ONE variant. When a variant plateaus, the run
 * ends. On the next run, a new variant is generated and refined. The user
 * manually compares scores and promotes the winner.
 */

import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

// ---------------------------------------------------------------------------
// Component naming
// ---------------------------------------------------------------------------

/**
 * Slot ordering for deterministic variant ID construction.
 * Lower numbers come first. Unknown slots get priority 99.
 */
const SLOT_PRIORITY: Record<string, number> = {
  // M1 + M4
  "Entry Signal": 1,
  "Entry Timing": 2,
  // M2
  "Band/Channel": 1,
  "Exhaustion": 2,
  // M3
  "Trend Filter": 1,
  "Pullback Zone": 2,
  "Pullback Confirm": 3,
  // Shared
  "Regime Filter": 3,
  "Confirmation": 4,
  "Exit": 5,
  "Trailing Exit": 5,
};

/**
 * Build a deterministic variant ID from slug-based catalog components.
 * Components are ordered by slot priority, then joined with hyphens.
 * Since slugs are already short, no truncation is needed.
 */
export function buildVariantId(components: Record<string, string>): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return "";

  entries.sort(([a], [b]) => {
    const pa = SLOT_PRIORITY[a] ?? 99;
    const pb = SLOT_PRIORITY[b] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  return entries.map(([, slug]) => slug).join("-");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VariantInfo {
  /** Deterministic ID derived from catalog components (e.g., "bb-squeeze-adx-chandelier") */
  id: string;
  /** KB catalog components: { "Entry Signal": "BB Squeeze", ... } */
  components: Record<string, string>;
  /** Absolute path to the strategy .ts file */
  strategyFile: string;
  /** Absolute path to the checkpoint directory */
  checkpointDir: string;
  /** Absolute path to the parameter history JSON */
  paramHistoryFile: string;
  /** Best composite score achieved */
  bestScore: number;
  /** Best PnL achieved */
  bestPnl: number;
  /** Global iteration at which best was achieved */
  bestIter: number;
  /** Current lifecycle status */
  status: "active" | "plateaued" | "complete";
  /** Iterations consumed by this variant */
  iterationsUsed: number;
  /** Why it plateaued (if applicable) */
  plateauReason?: string;
}

export interface VariantRegistry {
  variants: VariantInfo[];
  activeVariantId: string | null;
}

// ---------------------------------------------------------------------------
// VariantManager
// ---------------------------------------------------------------------------

export class VariantManager {
  private registry: VariantRegistry;
  private readonly registryPath: string;
  private readonly baseDir: string;
  private readonly strategyDir: string;

  constructor(baseDir: string, mainStrategyFile: string) {
    this.baseDir = baseDir;
    this.strategyDir = path.dirname(mainStrategyFile);
    this.registryPath = path.join(baseDir, "variant-registry.json");
    this.registry = { variants: [], activeVariantId: null };
  }

  /**
   * Load registry from disk, or initialize with the seed variant.
   */
  loadOrInit(
    mainStrategyFile: string,
    seedCheckpointDir: string,
    seedParamHistoryFile: string,
  ): void {
    if (fs.existsSync(this.registryPath)) {
      const raw = fs.readFileSync(this.registryPath, "utf8");
      this.registry = JSON.parse(raw) as VariantRegistry;
      return;
    }

    const seedId = path.basename(mainStrategyFile, ".ts");
    const seed: VariantInfo = {
      id: seedId,
      components: {},
      strategyFile: mainStrategyFile,
      checkpointDir: seedCheckpointDir,
      paramHistoryFile: seedParamHistoryFile,
      bestScore: 0,
      bestPnl: 0,
      bestIter: 0,
      status: "active",
      iterationsUsed: 0,
    };
    this.registry.variants.push(seed);
    this.registry.activeVariantId = seedId;
  }

  /** Return the currently active variant, or null. */
  getActive(): VariantInfo | null {
    if (!this.registry.activeVariantId) return null;
    return (
      this.registry.variants.find(
        (v) => v.id === this.registry.activeVariantId,
      ) ?? null
    );
  }

  /** Mark the active variant as plateaued. Clears active. */
  markPlateaued(
    reason: string,
    bestScore: number,
    bestPnl: number,
    bestIter: number,
    iterationsUsed: number,
  ): void {
    const active = this.getActive();
    if (!active) return;

    active.status = "plateaued";
    active.plateauReason = reason;
    active.bestScore = bestScore;
    active.bestPnl = bestPnl;
    active.bestIter = bestIter;
    active.iterationsUsed = iterationsUsed;
    this.registry.activeVariantId = null;
  }

  /** Mark the active variant as complete (criteria + stretch met). Clears active. */
  markComplete(
    bestScore: number,
    bestPnl: number,
    bestIter: number,
    iterationsUsed: number,
  ): void {
    const active = this.getActive();
    if (!active) return;

    active.status = "complete";
    active.bestScore = bestScore;
    active.bestPnl = bestPnl;
    active.bestIter = bestIter;
    active.iterationsUsed = iterationsUsed;
    this.registry.activeVariantId = null;
  }

  /**
   * Create a new variant from generated source code.
   * ID is derived deterministically from catalog components.
   * Throws if an active variant already exists, if components are empty,
   * or if the combination has already been tested.
   */
  createVariant(
    components: Record<string, string>,
    sourceCode: string,
  ): VariantInfo {
    const id = buildVariantId(components);
    if (!id) throw new Error("Cannot create variant with empty components");

    if (this.registry.activeVariantId) {
      throw new Error(
        `Cannot create variant: there is already an active variant "${this.registry.activeVariantId}"`,
      );
    }

    const existing = this.registry.variants.find((v) => v.id === id);
    if (existing) {
      throw new Error(
        `Variant "${id}" already exists (components already tested)`,
      );
    }

    // Strategy file lives next to the seed strategy
    const strategyFile = path.join(this.strategyDir, `${id}.ts`);
    writeFileAtomic.sync(strategyFile, sourceCode, "utf8");

    // Data directories under variants/ in the base dir
    const variantDataDir = path.join(this.baseDir, "variants", id);
    const variantCheckpointDir = path.join(variantDataDir, "checkpoints");
    const variantParamHistoryFile = path.join(
      variantDataDir,
      "parameter-history.json",
    );
    if (!fs.existsSync(variantCheckpointDir)) {
      fs.mkdirSync(variantCheckpointDir, { recursive: true });
    }

    const variant: VariantInfo = {
      id,
      components,
      strategyFile,
      checkpointDir: variantCheckpointDir,
      paramHistoryFile: variantParamHistoryFile,
      bestScore: 0,
      bestPnl: 0,
      bestIter: 0,
      status: "active",
      iterationsUsed: 0,
    };

    this.registry.variants.push(variant);
    this.registry.activeVariantId = id;
    return variant;
  }

  /** Update the active variant's best scores. */
  updateBest(bestScore: number, bestPnl: number, bestIter: number): void {
    const active = this.getActive();
    if (!active) return;
    active.bestScore = bestScore;
    active.bestPnl = bestPnl;
    active.bestIter = bestIter;
  }

  /** Increment iterations used for the active variant. */
  incrementIterations(): void {
    const active = this.getActive();
    if (active) active.iterationsUsed++;
  }

  /** Return all variants. */
  getAll(): readonly VariantInfo[] {
    return this.registry.variants;
  }

  /** Return the variant with the highest bestScore among non-active. */
  getBest(): VariantInfo | null {
    const finished = this.registry.variants.filter(
      (v) => v.status !== "active",
    );
    if (finished.length === 0) return null;
    return finished.reduce((best, v) =>
      v.bestScore > best.bestScore ? v : best,
    );
  }

  /** Check if a component combination has already been tested. */
  isTestedCombination(components: Record<string, string>): boolean {
    const id = buildVariantId(components);
    return this.registry.variants.some((v) => v.id === id);
  }

  /** Persist registry to disk. */
  save(): void {
    writeFileAtomic.sync(
      this.registryPath,
      JSON.stringify(this.registry, null, 2),
      "utf8",
    );
  }
}
