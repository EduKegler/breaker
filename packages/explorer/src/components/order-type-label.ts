import type { OpenOrder } from "../types/api.js";

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

  // 3. Reduce-only limit without trigger -> TP
  if (o.reduceOnly && o.triggerPx === 0) {
    return { label: "TP", color: "text-profit" };
  }

  return { label: o.orderType || "Limit", color: "text-txt-secondary" };
}
