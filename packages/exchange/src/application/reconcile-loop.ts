import type { HlClient } from "../types/hl-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { PositionBook } from "../domain/position-book.js";
import type { EventLog } from "../adapters/event-log.js";
import { resolveOrderStatus } from "../domain/order-status.js";
import { recoverSlTp } from "../domain/recover-sl-tp.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../lib/logger.js";

const log = logger.createChild("reconcileLoop");

export interface ReconciledData {
  positions: ReturnType<PositionBook["getAll"]>;
  openOrders: Awaited<ReturnType<HlClient["getOpenOrders"]>>;
  orders: ReturnType<SqliteStore["getRecentOrders"]>;
  equity: number;
}

interface ReconcileLoopDeps {
  hlClient: HlClient;
  positionBook: PositionBook;
  eventLog: EventLog;
  store: SqliteStore;
  walletAddress: string;
  intervalMs?: number;
  onReconciled?: (data: ReconciledData) => void;
  onApiDown?: () => void;
}

export class ReconcileLoop {
  private deps: ReconcileLoopDeps;
  private running = false;
  private consecutiveErrors = 0;

  constructor(deps: ReconcileLoopDeps) {
    this.deps = deps;
  }

  async check(): Promise<ReconcileResult> {
    const { hlClient, positionBook, eventLog, store, walletAddress } = this.deps;
    const actions: string[] = [];

    // 1. Fetch positions and open orders from HL
    const [hlPositions, allOpenOrders] = await Promise.all([
      hlClient.getPositions(walletAddress),
      hlClient.getOpenOrders(walletAddress),
    ]);
    const localPositions = positionBook.getAll();
    const result = reconcile(localPositions, hlPositions);

    // 2. Auto-correct positions
    const localMap = new Map(localPositions.map((p) => [p.coin, p]));
    const hlMap = new Map(hlPositions.map((p) => [p.coin, p]));

    if (result.drifts.length > 0) {
      log.warn({ action: "driftDetected", drifts: result.drifts }, "Position drift detected");
    }

    // 2a. HL has position, local doesn't → hydrate
    for (const [coin, hlPos] of hlMap) {
      if (!localMap.has(coin)) {
        const recovered = recoverSlTp(coin, hlPos.size, allOpenOrders);
        positionBook.open({
          coin,
          direction: hlPos.direction,
          entryPrice: hlPos.entryPrice,
          size: hlPos.size,
          stopLoss: recovered.stopLoss,
          takeProfits: recovered.takeProfits,
          liquidationPx: hlPos.liquidationPx,
          openedAt: new Date().toISOString(),
          signalId: -1,
        });
        actions.push(`position_hydrated:${coin}`);
        log.info({ action: "positionHydrated", coin, direction: hlPos.direction, size: hlPos.size }, "Position hydrated from HL");
      }
    }

    // 2b. Local has position, HL doesn't → auto-close
    for (const [coin] of localMap) {
      if (!hlMap.has(coin)) {
        positionBook.close(coin);
        actions.push(`position_auto_closed:${coin}`);
        log.info({ action: "positionAutoClosed", coin }, "Position auto-closed (not on HL)");
      }
    }

    // 2c. Update prices, liquidation, and recover lost SL/TP for all positions that exist on both sides
    for (const [coin, hlPos] of hlMap) {
      const localPos = positionBook.get(coin);
      if (!localPos) continue;

      positionBook.updateLiquidationPx(coin, hlPos.liquidationPx);

      // Recover SL/TP if lost (e.g. after daemon restart with partial state)
      if (localPos.stopLoss === 0) {
        const recovered = recoverSlTp(coin, hlPos.size, allOpenOrders);
        if (recovered.stopLoss > 0) {
          positionBook.updateStopLoss(coin, recovered.stopLoss);
        }
        if (recovered.takeProfits.length > 0) {
          positionBook.updateTakeProfits(coin, recovered.takeProfits);
        }
      }

      if (
        hlPos.size > 0
        && Number.isFinite(hlPos.unrealizedPnl) && Number.isFinite(hlPos.entryPrice)
        && hlPos.unrealizedPnl !== 0
      ) {
        const currentPrice = hlPos.direction === "long"
          ? hlPos.entryPrice + (hlPos.unrealizedPnl / hlPos.size)
          : hlPos.entryPrice - (hlPos.unrealizedPnl / hlPos.size);
        if (Number.isFinite(currentPrice) && currentPrice > 0) {
          positionBook.updatePrice(coin, currentPrice);
        }
      }
    }

    // 3. Sync order statuses
    const pendingOrders = store.getPendingOrders();
    const trackable = pendingOrders.filter((o) => {
      if (o.hl_order_id == null) return false;
      return !Number.isNaN(Number(o.hl_order_id));
    });

    if (trackable.length > 0) {
      const openOidSet = new Set(allOpenOrders.map((o) => o.oid));

      // Find resolved: pending locally but no longer open on HL
      const resolved = trackable.filter((o) => !openOidSet.has(Number(o.hl_order_id)));

      if (resolved.length > 0) {
        const historicalOrders = await hlClient.getHistoricalOrders(walletAddress);
        const historicalMap = new Map(historicalOrders.map((o) => [o.oid, o.status]));

        for (const order of resolved) {
          const oid = Number(order.hl_order_id);
          const hlStatus = historicalMap.get(oid);
          const positionExists = positionBook.get(order.coin) != null;
          const newStatus = resolveOrderStatus(hlStatus, positionExists);
          if (!newStatus) continue;

          const filledAt = newStatus === "filled" ? new Date().toISOString() : undefined;
          store.updateOrderStatus(order.id!, newStatus, filledAt);
          actions.push(`order_status_synced:${order.hl_order_id}:${newStatus}`);
          log.info({ action: "orderStatusSynced", oid: order.hl_order_id, newStatus, tag: order.tag }, "Order status synced");
        }
      }
    }

    // 4. Record equity snapshot
    const equity = await hlClient.getAccountEquity(walletAddress);
    if (Number.isFinite(equity) && equity > 0) {
      const allPositions = positionBook.getAll();
      store.insertEquitySnapshot({
        timestamp: new Date().toISOString(),
        equity,
        unrealized_pnl: allPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
        realized_pnl: store.getTodayRealizedPnl(),
        open_positions: allPositions.length,
      });
    }

    // 5. Log reconciliation event
    await eventLog.append({
      type: result.ok && actions.length === 0 ? "reconcile_ok" : "reconcile_drift",
      timestamp: new Date().toISOString(),
      data: { drifts: result.drifts, actions },
    });

    // 6. Notify callback with current state
    this.deps.onReconciled?.({
      positions: positionBook.getAll(),
      openOrders: allOpenOrders,
      orders: store.getRecentOrders(100),
      equity,
    });

    return {
      ...result,
      actions,
    };
  }

  async start(): Promise<void> {
    this.running = true;
    const intervalMs = this.deps.intervalMs ?? 60_000;

    while (this.running) {
      try {
        await this.check();
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        log.error({ action: "reconcileError", err, consecutiveErrors: this.consecutiveErrors }, "Reconcile loop error");
        if (this.consecutiveErrors === 3) {
          log.error({ action: "apiDownAlert" }, "Hyperliquid API appears down (3 consecutive failures)");
          this.deps.onApiDown?.();
        }
      }
      await sleep(intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }
}
