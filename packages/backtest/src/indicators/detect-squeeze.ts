import type { BollingerBandsResult } from "./bollinger-bands.js";
import type { KeltnerResult } from "./keltner.js";

export interface SqueezeResult {
  /** Per-bar: BB fully inside KC */
  squeezeOn: boolean[];
  /** Per-bar: squeezeOn AND BB width decreasing/flat for >= minBars */
  squeezeActive: boolean[];
  /** Per-bar: BB upper - BB lower */
  bbWidth: number[];
}

/**
 * Detects Bollinger Band squeeze (BB inside Keltner Channel).
 * Single-pass O(N) — tracks consecutive decreasing-width count.
 */
export function detectSqueeze(
  bb: BollingerBandsResult,
  kc: KeltnerResult,
  minBars = 4,
): SqueezeResult {
  const len = bb.upper.length;
  if (len === 0) return { squeezeOn: [], squeezeActive: [], bbWidth: [] };

  const squeezeOn = new Array<boolean>(len);
  const squeezeActive = new Array<boolean>(len);
  const bbWidth = new Array<number>(len);

  let decreasingCount = 0;

  for (let i = 0; i < len; i++) {
    const bU = bb.upper[i];
    const bL = bb.lower[i];
    const kU = kc.upper[i];
    const kL = kc.lower[i];

    const width = bU - bL;
    bbWidth[i] = width;

    // NaN guard: any NaN means no squeeze
    const on = !isNaN(bU) && !isNaN(bL) && !isNaN(kU) && !isNaN(kL) &&
      bL > kL && bU < kU;
    squeezeOn[i] = on;

    if (!on) {
      decreasingCount = 0;
      squeezeActive[i] = false;
      continue;
    }

    // Track width decreasing (or flat) — only relative to previous squeeze bar
    if (i > 0 && squeezeOn[i - 1] && !isNaN(bbWidth[i - 1]) && width <= bbWidth[i - 1]) {
      decreasingCount++;
    } else {
      decreasingCount = 0;
    }

    squeezeActive[i] = decreasingCount >= minBars;
  }

  return { squeezeOn, squeezeActive, bbWidth };
}
