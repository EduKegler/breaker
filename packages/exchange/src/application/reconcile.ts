import type { HlPosition } from "../types/hl-client.js";
import type { PositionBook } from "../domain/position-book.js";

export interface ReconcileResult {
  ok: boolean;
  drifts: string[];
  actions: string[];
}

export function reconcile(
  localPositions: ReturnType<PositionBook["getAll"]>,
  hlPositions: HlPosition[],
): ReconcileResult {
  const drifts: string[] = [];

  const localMap = new Map(localPositions.map((p) => [p.coin, p]));
  const hlMap = new Map(hlPositions.map((p) => [p.coin, p]));

  // Check for positions that exist locally but not on HL
  for (const [coin] of localMap) {
    if (!hlMap.has(coin)) {
      drifts.push(`${coin}: local position exists but not on Hyperliquid`);
    }
  }

  // Check for positions on HL but not locally
  for (const [coin] of hlMap) {
    if (!localMap.has(coin)) {
      drifts.push(`${coin}: Hyperliquid position exists but not tracked locally`);
    }
  }

  // Check for size mismatches
  for (const [coin, local] of localMap) {
    const hl = hlMap.get(coin);
    if (!hl) continue;

    const sizeDiff = Math.abs(local.size - hl.size);
    if (sizeDiff > local.size * 0.01) { // >1% tolerance
      drifts.push(`${coin}: size drift — local=${local.size}, HL=${hl.size}`);
    }
  }

  return {
    ok: drifts.length === 0,
    drifts,
    actions: [],
  };
}
