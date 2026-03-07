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
 * Canonical short names for known KB catalog components.
 * Used to build deterministic, human-readable variant file names.
 */
const CANONICAL_NAMES: Record<string, string> = {
  // ── M1 Breakout: Entry Signal ──
  "Donchian Channel": "donchian",
  "Bollinger Band squeeze release": "squeeze",
  "Opening Range Breakout (ORB)": "orb",
  "Range breakout": "range",
  "Volatility expansion": "expansion",
  // ── M1 Breakout: Entry Timing ──
  "Breakout close": "close",
  "Retest entry": "retest",
  // ── M1 Breakout: Regime Filter ──
  "EMA direction": "ema",
  "ADX threshold": "adx",
  "4H consolidation": "consolidation",
  // ── M1 Breakout: Confirmation ──
  "RSI momentum": "rsi",
  "MACD alignment": "macd",
  // ── M1 Breakout: Exit ──
  "Trailing channel (Donchian fast)": "trail-dc",
  "ATR trailing stop": "atr-trail",
  "Time-based timeout": "timeout",
  "Partial TP + trail": "partial-tp",
  // ── M2 Mean-Reversion: Band/Channel ──
  "Bollinger Bands": "bollinger",
  "Keltner Channels": "keltner",
  "Percentage bands": "pct-bands",
  "VWAP bands": "vwap",
  // ── M2 Mean-Reversion: Exhaustion ──
  "RSI(2)": "rsi2",
  "Williams %R": "williams",
  "RSI(3-5)": "rsi35",
  "Stochastic": "stochastic",
  // ── M2 Mean-Reversion: Regime Filter ──
  "ADX threshold (low)": "adx-low",
  "BB width / volatility percentile": "bb-width",
  "MA slope flat": "ma-flat",
  // ── M2 Mean-Reversion: Exit ──
  "Channel midline": "midline",
  "Opposite band": "opposite",
  "First up/down close": "first-close",
  "Timeout": "timeout",
  "Catastrophic stop": "cat-stop",
  // ── M3 Pullback: Trend Filter ──
  // "EMA direction" already mapped above
  "HH/HL structure": "hhhl",
  "ADX > threshold": "adx-high",
  // ── M3 Pullback: Pullback Zone ──
  "Fibonacci retracement": "fib",
  "EMA dynamic support": "ema-support",
  "9/30 pullback zone": "930",
  "Prior S/R level": "sr",
  // ── M3 Pullback: Pullback Confirm ──
  "RSI neutral reset": "rsi-reset",
  "Candlestick pattern": "candle",
  "Volume expansion": "volume",
  "Candle close beyond pullback extreme": "close-beyond",
  // ── M3 Pullback: Exit ──
  "Prior swing high/low": "swing",
  // "ATR trailing stop" already mapped above
  "Fibonacci extension": "fib-ext",
  // "Time-based timeout" already mapped above
  // "Partial TP + trail" already mapped above
  // ── M4 Trend Following: Entry Signal ──
  "SuperTrend flip": "supertrend",
  "EMA crossover": "ema-cross",
  "Donchian channel breakout": "donchian-daily",
  "MACD crossover + HTF filter": "macd-htf",
  // ── M4 Trend Following: Regime Filter ──
  // "ADX > threshold" already mapped above
  "EMA slope + price position": "ema-slope",
  // ── M4 Trend Following: Trailing Exit ──
  "Chandelier Exit": "chandelier",
  "SuperTrend flip exit": "supertrend",
  // "ATR trailing stop" already mapped above
  "MA crossover exit": "ma-exit",
  // "Time-based timeout" already mapped above
};

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

/** Max kebab segments per component (keeps names short). */
const MAX_SEGMENTS_PER_COMPONENT = 3;
/** Max total length for variant IDs. */
const MAX_VARIANT_ID_LENGTH = 60;

/**
 * Convert a catalog component name to its canonical kebab-case form.
 * Known names get a short alias; unknown names are kebab-cased and
 * truncated to MAX_SEGMENTS_PER_COMPONENT words.
 */
export function toCanonical(name: string): string {
  const canonical = CANONICAL_NAMES[name];
  if (canonical) return canonical;
  const segments = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean);
  return segments.slice(0, MAX_SEGMENTS_PER_COMPONENT).join("-");
}

/**
 * Build a deterministic variant ID from selected catalog components.
 * Components are ordered by slot priority, then joined with hyphens.
 * Total length is capped at MAX_VARIANT_ID_LENGTH; a 4-char hash is
 * appended when truncation occurs to preserve uniqueness.
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

  const full = entries.map(([, name]) => toCanonical(name)).join("-");
  if (full.length <= MAX_VARIANT_ID_LENGTH) return full;

  // Truncate at a segment boundary and append a short hash for uniqueness
  let hash = 0;
  for (let i = 0; i < full.length; i++) hash = ((hash << 5) - hash + full.charCodeAt(i)) | 0;
  const suffix = Math.abs(hash).toString(36).slice(0, 4);
  const maxBase = MAX_VARIANT_ID_LENGTH - suffix.length - 1; // -1 for the joining hyphen
  const truncated = full.slice(0, maxBase).replace(/-[^-]*$/, ""); // cut at last full segment
  return `${truncated}-${suffix}`;
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
