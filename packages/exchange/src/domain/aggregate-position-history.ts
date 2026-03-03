export interface PositionHistoryRow {
  signal_id: number;
  asset: string;
  side: string;
  strategy_name: string | null;
  created_at: string;
  order_id: number;
  tag: string;
  status: string;
  price: number | null;
  size: number;
  order_side: string;
  order_type: string;
  mode: string;
  order_created_at: string;
  filled_at: string | null;
  fill_price: number | null;
  fill_size: number | null;
  fee: number | null;
  fill_ts: string | null;
}

export interface PositionEvent {
  type: string;
  timestamp: string;
  details: string;
}

export interface PositionSummary {
  signalId: number;
  coin: string;
  direction: "LONG" | "SHORT";
  strategy: string | null;
  mode: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
  pnlPercent: number | null;
  totalFees: number;
  durationMs: number | null;
  openedAt: string;
  closedAt: string | null;
  status: "OPEN" | "CLOSED";
  events: PositionEvent[];
}

interface OrderGroup {
  orderId: number;
  tag: string;
  status: string;
  price: number | null;
  size: number;
  orderSide: string;
  orderType: string;
  mode: string;
  orderCreatedAt: string;
  filledAt: string | null;
  fillPrice: number | null;
  fillSize: number | null;
  fee: number | null;
  fillTs: string | null;
}

function toUtcMs(dt: string): number {
  return new Date(dt.endsWith("Z") ? dt : dt + "Z").getTime();
}

function buildEvents(signalCreatedAt: string, orders: OrderGroup[]): PositionEvent[] {
  const events: PositionEvent[] = [];

  events.push({
    type: "signal_received",
    timestamp: signalCreatedAt,
    details: "Signal received",
  });

  // Track trailing-sl cancelled orders for "moved" detection
  const trailingSlCancelled: OrderGroup[] = [];
  let firstTrailingSlSeen = false;

  for (const o of orders) {
    if (o.tag === "entry") {
      events.push({ type: "entry_placed", timestamp: o.orderCreatedAt, details: `Entry order placed @ ${o.price ?? "market"}` });
      if (o.status === "filled" && o.filledAt) {
        events.push({ type: "entry_filled", timestamp: o.filledAt, details: `Entry filled @ ${o.fillPrice}` });
      }
    } else if (o.tag === "sl") {
      events.push({ type: "sl_placed", timestamp: o.orderCreatedAt, details: `SL placed @ ${o.price}` });
      if (o.status === "filled" && o.filledAt) {
        events.push({ type: "sl_filled", timestamp: o.filledAt, details: `SL filled @ ${o.fillPrice}` });
      }
    } else if (o.tag.startsWith("tp")) {
      events.push({ type: "tp_placed", timestamp: o.orderCreatedAt, details: `TP placed @ ${o.price}` });
      if (o.status === "filled" && o.filledAt) {
        events.push({ type: "tp_filled", timestamp: o.filledAt, details: `TP filled @ ${o.fillPrice}` });
      }
    } else if (o.tag === "trailing-sl") {
      if (o.status === "cancelled") {
        trailingSlCancelled.push(o);
      } else if (o.status === "pending" || o.status === "filled") {
        if (!firstTrailingSlSeen && trailingSlCancelled.length === 0) {
          // First trailing SL ever placed
          events.push({ type: "trailing_sl_placed", timestamp: o.orderCreatedAt, details: `Trailing SL placed @ ${o.price}` });
          firstTrailingSlSeen = true;
        } else if (trailingSlCancelled.length > 0) {
          // There were cancelled trailing SLs before this one → "moved"
          if (!firstTrailingSlSeen) {
            events.push({ type: "trailing_sl_placed", timestamp: trailingSlCancelled[0].orderCreatedAt, details: `Trailing SL placed @ ${trailingSlCancelled[0].price}` });
            firstTrailingSlSeen = true;
          }
          const lastCancelled = trailingSlCancelled[trailingSlCancelled.length - 1];
          events.push({ type: "trailing_sl_moved", timestamp: o.orderCreatedAt, details: `Trailing SL moved ${lastCancelled.price} → ${o.price}` });
        }
        if (o.status === "filled" && o.filledAt) {
          events.push({ type: "trailing_sl_filled", timestamp: o.filledAt, details: `Trailing SL filled @ ${o.fillPrice}` });
        }
      }
    }
  }

  // Sort events by timestamp
  events.sort((a, b) => toUtcMs(a.timestamp) - toUtcMs(b.timestamp));

  return events;
}

export function aggregatePositionHistory(rows: PositionHistoryRow[]): PositionSummary[] {
  if (rows.length === 0) return [];

  // Group rows by signal_id
  const groups = new Map<number, { signalCreatedAt: string; asset: string; side: string; strategyName: string | null; orders: Map<number, OrderGroup> }>();

  for (const r of rows) {
    let group = groups.get(r.signal_id);
    if (!group) {
      group = {
        signalCreatedAt: r.created_at,
        asset: r.asset,
        side: r.side,
        strategyName: r.strategy_name,
        orders: new Map(),
      };
      groups.set(r.signal_id, group);
    }

    // Deduplicate orders (LEFT JOIN fills can produce multiple rows per order)
    if (!group.orders.has(r.order_id)) {
      group.orders.set(r.order_id, {
        orderId: r.order_id,
        tag: r.tag,
        status: r.status,
        price: r.price,
        size: r.size,
        orderSide: r.order_side,
        orderType: r.order_type,
        mode: r.mode,
        orderCreatedAt: r.order_created_at,
        filledAt: r.filled_at,
        fillPrice: r.fill_price,
        fillSize: r.fill_size,
        fee: r.fee,
        fillTs: r.fill_ts,
      });
    }
  }

  const positions: PositionSummary[] = [];

  for (const [signalId, group] of groups) {
    const orders = Array.from(group.orders.values()).sort((a, b) => a.orderId - b.orderId);
    const direction = group.side.toUpperCase() as "LONG" | "SHORT";

    // Find entry fill
    const entryOrder = orders.find((o) => o.tag === "entry" && o.status === "filled");
    if (!entryOrder || entryOrder.fillPrice == null) continue;

    const entryPrice = entryOrder.fillPrice;
    const size = entryOrder.fillSize ?? entryOrder.size;
    const mode = entryOrder.mode;
    const openedAt = entryOrder.filledAt ?? entryOrder.orderCreatedAt;

    // Collect exit fills (all non-entry filled orders)
    const exitFills = orders.filter((o) => o.tag !== "entry" && o.status === "filled" && o.fillPrice != null && o.fillSize != null);

    // Total fees from all fills (entry + exits)
    let totalFees = entryOrder.fee ?? 0;
    for (const ef of exitFills) {
      totalFees += ef.fee ?? 0;
    }

    const isOpen = exitFills.length === 0;

    let exitPrice: number | null = null;
    let realizedPnl: number | null = null;
    let pnlPercent: number | null = null;
    let closedAt: string | null = null;
    let durationMs: number | null = null;

    if (!isOpen) {
      const totalExitValue = exitFills.reduce((sum, f) => sum + f.fillPrice! * f.fillSize!, 0);
      const totalExitSize = exitFills.reduce((sum, f) => sum + f.fillSize!, 0);
      exitPrice = totalExitSize > 0 ? totalExitValue / totalExitSize : null;

      const entryValue = entryPrice * size;
      if (direction === "LONG") {
        realizedPnl = totalExitValue - entryValue - totalFees;
      } else {
        realizedPnl = entryValue - totalExitValue - totalFees;
      }
      pnlPercent = entryValue > 0 ? (realizedPnl / entryValue) * 100 : null;

      // closedAt = latest exit fill timestamp
      const exitTimestamps = exitFills.map((f) => f.fillTs ?? f.filledAt).filter(Boolean) as string[];
      if (exitTimestamps.length > 0) {
        closedAt = exitTimestamps.sort((a, b) => toUtcMs(b) - toUtcMs(a))[0];
        durationMs = toUtcMs(closedAt) - toUtcMs(openedAt);
      }
    }

    const events = buildEvents(group.signalCreatedAt, orders);

    positions.push({
      signalId,
      coin: group.asset,
      direction,
      strategy: group.strategyName,
      mode,
      size,
      entryPrice,
      exitPrice,
      realizedPnl,
      pnlPercent,
      totalFees,
      durationMs,
      openedAt,
      closedAt,
      status: isOpen ? "OPEN" : "CLOSED",
      events,
    });
  }

  // Sort: OPEN first, then by signalId DESC (most recent first)
  positions.sort((a, b) => {
    if (a.status !== b.status) return a.status === "OPEN" ? -1 : 1;
    return b.signalId - a.signalId;
  });

  return positions;
}
