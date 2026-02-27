import { useState } from "react";
import type { OpenOrder } from "../lib/api.js";

export function orderTypeLabel(o: OpenOrder): { label: string; color: string } {
  const ot = o.orderType.toLowerCase();

  // 1. Explicit HL orderType (e.g. "Stop Market", "Take Profit Limit")
  if (ot.includes("take profit")) return { label: "TP", color: "text-profit" };
  if (ot.includes("stop")) return { label: "SL", color: "text-loss" };

  // 2. Trigger orders: use side + triggerCondition to infer SL vs TP
  //    Long closed by SELL: "lt" = SL (price drops), "gt" = TP (price rises)
  //    Short closed by BUY: "gt" = SL (price rises), "lt" = TP (price drops)
  if (o.reduceOnly && o.triggerPx > 0 && o.triggerCondition) {
    const isSell = o.side === "A" || o.side.toLowerCase() === "sell";
    const isStopLoss = isSell
      ? o.triggerCondition === "lt"
      : o.triggerCondition === "gt";
    return isStopLoss
      ? { label: "SL", color: "text-loss" }
      : { label: "TP", color: "text-profit" };
  }

  // 3. Reduce-only limit without trigger → TP
  if (o.reduceOnly && o.triggerPx === 0) {
    return { label: "TP", color: "text-profit" };
  }

  return { label: o.orderType || "Limit", color: "text-txt-secondary" };
}

export function OpenOrdersTable({
  orders,
  onCancel,
}: {
  orders: OpenOrder[];
  onCancel?: (coin: string, oid: number) => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState<Set<number>>(new Set());

  if (orders.length === 0) {
    return (
      <p className="text-txt-secondary text-sm font-mono">No open orders</p>
    );
  }

  const handleCancel = async (coin: string, oid: number) => {
    if (!onCancel) return;
    setCancelling((prev) => new Set(prev).add(oid));
    await onCancel(coin, oid);
    setCancelling((prev) => {
      const next = new Set(prev);
      next.delete(oid);
      return next;
    });
  };

  return (
    <div className="overflow-y-auto max-h-[300px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-terminal-surface">
          <tr className="text-left text-txt-secondary uppercase tracking-wider border-b border-terminal-border">
            <th className="pb-2 pr-3 font-medium">Coin</th>
            <th className="pb-2 pr-3 font-medium">Side</th>
            <th className="pb-2 pr-3 font-medium">Type</th>
            <th className="pb-2 pr-3 font-medium text-right">Size</th>
            <th className="pb-2 pr-3 font-medium text-right">Price</th>
            <th className="pb-2 pr-3 font-medium text-right">Trigger</th>
            <th className="pb-2 pr-3 font-medium text-right">Flags</th>
            {onCancel && <th className="pb-2 pl-2 font-medium w-8" />}
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => {
            const type = orderTypeLabel(o);
            const isLoading = cancelling.has(o.oid);
            return (
              <tr
                key={o.oid}
                className={`border-b border-terminal-border/50 hover:bg-white/[0.02] ${
                  i % 2 === 0 ? "" : "bg-white/[0.01]"
                }`}
              >
                <td className="py-1.5 pr-3 font-display font-semibold text-txt-primary">
                  {o.coin}
                </td>
                <td
                  className={`py-1.5 pr-3 font-semibold uppercase ${
                    o.side === "B" ? "text-profit" : "text-loss"
                  }`}
                >
                  {o.side === "B" ? "LONG" : "SHORT"}
                </td>
                <td className={`py-1.5 pr-3 font-semibold ${type.color}`}>
                  {type.label}
                </td>
                <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                  {o.sz === 0 ? "Full" : o.sz}
                </td>
                <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                  ${o.limitPx.toLocaleString()}
                </td>
                <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                  {o.triggerPx > 0 ? `$${o.triggerPx.toLocaleString()}` : "—"}
                </td>
                <td className="py-1.5 flex gap-1 justify-end">
                  {o.reduceOnly && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-sm bg-amber/10 text-amber">
                      reduce
                    </span>
                  )}
                  {o.isPositionTpsl && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-sm bg-blue-500/10 text-blue-400">
                      pos tp/sl
                    </span>
                  )}
                </td>
                {onCancel && (
                  <td className="py-1.5 pl-2 text-center">
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={() => handleCancel(o.coin, o.oid)}
                      className="text-txt-secondary hover:text-loss transition-colors disabled:opacity-40 disabled:cursor-wait"
                      title={`Cancel order ${o.oid}`}
                    >
                      {isLoading ? "..." : "\u2715"}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
