import type { HlClient, HlPosition } from "../adapters/hyperliquid-client.js";
import type { PositionBook } from "../domain/position-book.js";
import type { EventLog } from "../adapters/event-log.js";
import { setTimeout as sleep } from "node:timers/promises";

export interface ReconcileResult {
  ok: boolean;
  drifts: string[];
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
  };
}

export interface ReconcileLoopDeps {
  hlClient: HlClient;
  positionBook: PositionBook;
  eventLog: EventLog;
  walletAddress: string;
  intervalMs?: number;
}

export class ReconcileLoop {
  private deps: ReconcileLoopDeps;
  private running = false;

  constructor(deps: ReconcileLoopDeps) {
    this.deps = deps;
  }

  async check(): Promise<ReconcileResult> {
    const hlPositions = await this.deps.hlClient.getPositions(this.deps.walletAddress);
    const localPositions = this.deps.positionBook.getAll();
    const result = reconcile(localPositions, hlPositions);

    await this.deps.eventLog.append({
      type: result.ok ? "reconcile_ok" : "reconcile_drift",
      timestamp: new Date().toISOString(),
      data: { drifts: result.drifts },
    });

    return result;
  }

  async start(): Promise<void> {
    this.running = true;
    const intervalMs = this.deps.intervalMs ?? 60_000;

    while (this.running) {
      try {
        await this.check();
      } catch {
        // Log but don't crash
      }
      await sleep(intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
