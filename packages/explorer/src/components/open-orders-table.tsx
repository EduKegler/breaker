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

export function OpenOrdersTable({ orders }: { orders: OpenOrder[] }) {
  if (orders.length === 0) {
    return (
      <p className="text-txt-secondary text-sm font-mono">No open orders</p>
    );
  }

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
            <th className="pb-2 font-medium text-right">Flags</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => {
            const type = orderTypeLabel(o);
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
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-sm bg-amber/20 text-amber border border-amber/30">
                      Reduce Only
                    </span>
                  )}
                  {o.isPositionTpsl && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-sm bg-blue-500/20 text-blue-400 border border-blue-500/30">
                      Position TP/SL
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
