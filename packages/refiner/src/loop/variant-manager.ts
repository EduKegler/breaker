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

import type { ComponentCatalog, CatalogSlot } from "../lib/build-module-context.js";

// ---------------------------------------------------------------------------
// Component naming
// ---------------------------------------------------------------------------

/**
 * Slot ordering for deterministic variant ID construction.
 * Lower numbers come first. Unknown slots get priority 99.
 */
const SLOT_PRIORITY: Record<string, number> = {
  // M1 direction constraint (before entry)
  "Direction": 0,
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
/** Slugs that are excluded from variant ID (default/no-op values). */
const IDENTITY_SLUGS = new Set(["both"]);

export function buildVariantId(components: Record<string, string>): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return "";

  entries.sort(([a], [b]) => {
    const pa = SLOT_PRIORITY[a] ?? 99;
    const pb = SLOT_PRIORITY[b] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  return entries
    .filter(([, slug]) => !IDENTITY_SLUGS.has(slug))
    .map(([, slug]) => slug)
    .join("-");
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
  status: "active" | "plateaued" | "complete" | "killed";
  /** Iterations consumed by this variant */
  iterationsUsed: number;
  /** Why it plateaued (if applicable) */
  plateauReason?: string;
  /** Why it was killed (if applicable) */
  killReason?: string;
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

  /**
   * Find the next variant with status "active" that is NOT the current activeVariantId.
   * Returns null if none found. Used to reactivate user-queued variants before generating new ones.
   */
  findNextActive(): VariantInfo | null {
    return this.registry.variants.find(
      v => v.status === "active" && v.id !== this.registry.activeVariantId,
    ) ?? null;
  }

  /**
   * Reactivate an existing variant: set as activeVariantId and reset budget.
   * The variant must already have status "active" (set manually by user in registry).
   * Throws if another variant is already the activeVariantId or if variant not found.
   */
  reactivate(id: string): void {
    const variant = this.registry.variants.find(v => v.id === id);
    if (!variant) throw new Error(`Variant "${id}" not found`);
    if (this.registry.activeVariantId) {
      throw new Error(`Cannot reactivate: variant "${this.registry.activeVariantId}" is already active`);
    }
    variant.status = "active";
    variant.iterationsUsed = 0;
    this.registry.activeVariantId = id;
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

  /** Mark the active variant as killed (early termination due to no edge). Clears active. */
  markKilled(
    reason: string,
    bestScore: number,
    bestPnl: number,
    bestIter: number,
    iterationsUsed: number,
  ): void {
    const active = this.getActive();
    if (!active) return;

    active.status = "killed";
    active.killReason = reason;
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

  /** Reset iterations counter for the active variant (new CLI run = fresh budget). */
  resetBudget(): void {
    const active = this.getActive();
    if (active) active.iterationsUsed = 0;
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

// ---------------------------------------------------------------------------
// Factory name fix
// ---------------------------------------------------------------------------

/**
 * Fix factory function name in generated strategy source to match the variant ID.
 * Renames `createOldName` → `createNewName` and related PascalCase types.
 * Returns source unchanged if no `create*` export is found or name already matches.
 */
export function fixFactoryName(source: string, variantId: string): string {
  const expectedFactory = "create" + variantId.split("-").map(s => s[0].toUpperCase() + s.slice(1)).join("");
  const match = source.match(/export\s+function\s+(create\w+)/);
  if (!match || match[1] === expectedFactory) return source;

  const currentFactory = match[1];
  let fixed = source.replaceAll(currentFactory, expectedFactory);

  // Also rename PascalCase types (DonchianEmaTimeoutParams → SqueezeAdxTrailDcParams)
  const currentPascal = currentFactory.replace(/^create/, "");
  const expectedPascal = expectedFactory.replace(/^create/, "");
  fixed = fixed.replaceAll(currentPascal, expectedPascal);
  return fixed;
}

// ---------------------------------------------------------------------------
// Pre-selection of next component combination
// ---------------------------------------------------------------------------

/**
 * Generate all combinations from the cartesian product of candidate slugs
 * across the given slots. Each combo is a Record<slotName, slug>.
 */
function cartesianProduct(slots: CatalogSlot[]): Record<string, string>[] {
  if (slots.length === 0) return [{}];

  const [first, ...rest] = slots;
  const restCombos = cartesianProduct(rest);
  const result: Record<string, string>[] = [];

  // Optional slots get a null option (slot absent from combination)
  const options: (string | null)[] = first.candidates.map((c) => c.slug);
  if (first.optional) options.push(null);

  for (const slug of options) {
    for (const combo of restCombos) {
      if (slug === null) {
        result.push({ ...combo });
      } else {
        result.push({ [first.slotName]: slug, ...combo });
      }
    }
  }

  return result;
}

/**
 * Count how many tested IDs contain a given slug as a substring.
 * Used to score novelty — lower count = less tested = preferred.
 */
function slugUsageCount(slug: string, testedIds: Set<string>): number {
  let count = 0;
  for (const id of testedIds) {
    if (id.includes(slug)) count++;
  }
  return count;
}

/**
 * Sum of usage counts for all slugs in a combination.
 * Lower = more novel.
 */
function totalSlugUsage(
  combo: Record<string, string>,
  testedIds: Set<string>,
): number {
  let total = 0;
  for (const slug of Object.values(combo)) {
    total += slugUsageCount(slug, testedIds);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Quality-based selection helpers
// ---------------------------------------------------------------------------

export interface VariantPerformance {
  components: Record<string, string>;
  bestScore: number;
}

/**
 * Compute per-slug average bestScore within each slot.
 * Returns slotName → slug → avgScore.
 */
function computeSlugScores(
  catalog: ComponentCatalog,
  history: VariantPerformance[],
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();

  for (const slot of catalog.slots) {
    const accum = new Map<string, { total: number; count: number }>();

    for (const v of history) {
      const slug = v.components[slot.slotName];
      if (!slug) continue;
      const cur = accum.get(slug) ?? { total: 0, count: 0 };
      cur.total += v.bestScore;
      cur.count += 1;
      accum.set(slug, cur);
    }

    const avgMap = new Map<string, number>();
    for (const [slug, { total, count }] of accum) {
      avgMap.set(slug, total / count);
    }
    result.set(slot.slotName, avgMap);
  }

  return result;
}

/**
 * Expected quality of a combination based on historical slug performance.
 * Untested slugs receive the slot mean as a neutral prior.
 */
function expectedQuality(
  combo: Record<string, string>,
  slugScores: Map<string, Map<string, number>>,
): number {
  let total = 0;

  for (const [slotName, slug] of Object.entries(combo)) {
    const slotMap = slugScores.get(slotName);
    if (!slotMap || slotMap.size === 0) continue;

    const slugAvg = slotMap.get(slug);
    if (slugAvg !== undefined) {
      total += slugAvg;
    } else {
      // Untested slug → use slot mean (neutral prior)
      let slotSum = 0;
      for (const avg of slotMap.values()) slotSum += avg;
      total += slotSum / slotMap.size;
    }
  }

  return total;
}

/**
 * Select the next untested component combination from the catalog.
 *
 * Algorithm:
 * 1. All slots participate — optional slots get a null option (slot absent)
 * 2. Cartesian product of all slot candidates (with null for optionals)
 * 3. Filter out empty combos and those whose buildVariantId() is already in testedIds
 * 4. Sort by quality (when enough history) or novelty (early exploration)
 * 5. Return the first one, or null when exhausted
 *
 * Quality mode activates when variantHistory has at least as many entries
 * as required slots. Combinations are ranked by the sum of their slugs'
 * average bestScore. Untested slugs receive the slot mean as neutral prior.
 */
/**
 * Non-slot vars from KB variable budget tables (ATR stop, timeout, volume, etc.).
 * These consume var budget but aren't swappable catalog slots.
 * Source: docs/knowledge-base.md §5 (per-module variable budget tables).
 */
const FIXED_VAR_OVERHEAD: Record<string, number> = {
  M1: 3, // Volume(1) + ATR stop(1) + Timeout(1)
  M2: 1, // Timeout(1) — catastrophic stop is optional
  M3: 2, // ATR stop(1) + Timeout(1)
  M4: 2, // Stop(1) + Timeout(1)
};

/**
 * Estimate max variable count for a combination using per-slot typicalVars.
 * Parses "1-2" → 2 (takes upper bound for conservative filtering).
 *
 * @param slotMap - Map of slotName → CatalogSlot for O(1) lookups.
 */
export function estimateMaxVars(
  combo: Record<string, string>,
  slotMap: Map<string, CatalogSlot>,
  moduleId?: string,
): number {
  let total = 0;
  for (const slotName of Object.keys(combo)) {
    const slot = slotMap.get(slotName);
    if (!slot?.typicalVars) continue;
    const parts = slot.typicalVars.split("-").map(Number).filter((n) => !Number.isNaN(n));
    total += parts.length > 0 ? parts[parts.length - 1] : 0;
  }
  if (moduleId) {
    total += FIXED_VAR_OVERHEAD[moduleId] ?? 0;
  }
  return total;
}

export interface SelectNextOpts {
  variantHistory?: VariantPerformance[];
  varCap?: number;
  moduleId?: string;
}

export function selectNextCombination(
  catalog: ComponentCatalog,
  testedIds: Set<string>,
  opts?: SelectNextOpts,
): Record<string, string> | null {
  if (catalog.slots.length === 0) return null;

  const { variantHistory, varCap, moduleId } = opts ?? {};
  const combos = cartesianProduct(catalog.slots);

  let untested = combos.filter((combo) => {
    // Skip empty combos (all-optional slots all chose null)
    if (Object.keys(combo).length === 0) return false;
    return !testedIds.has(buildVariantId(combo));
  });

  if (untested.length === 0) return null;

  // Filter out combinations that exceed variable budget
  if (varCap != null) {
    const slotMap = new Map(catalog.slots.map((s) => [s.slotName, s]));
    untested = untested.filter(
      (combo) => estimateMaxVars(combo, slotMap, moduleId) <= varCap,
    );
    if (untested.length === 0) return null;
  }

  const requiredSlotCount = catalog.slots.filter((s) => !s.optional).length;
  const useQuality = variantHistory && variantHistory.length >= requiredSlotCount;

  if (useQuality) {
    // Exploitation mode: prefer combinations whose slugs scored well
    const slugScores = computeSlugScores(catalog, variantHistory);
    untested.sort((a, b) => expectedQuality(b, slugScores) - expectedQuality(a, slugScores));
  } else {
    // Exploration mode: prefer combos with less-tested slugs
    untested.sort((a, b) => totalSlugUsage(a, testedIds) - totalSlugUsage(b, testedIds));
  }

  return untested[0];
}
