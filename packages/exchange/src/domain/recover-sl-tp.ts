import type { HlOpenOrder } from "../types/hl-client.js";

interface RecoveredSlTp {
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  trailingStopLoss: number | null;
}

export function recoverSlTp(
  coin: string,
  posSize: number,
  openOrders: HlOpenOrder[],
  direction?: "long" | "short",
): RecoveredSlTp {
  const coinReduceOnly = openOrders.filter(
    (o) => o.coin === coin && o.reduceOnly,
  );

  const slOrders = coinReduceOnly.filter((o) => o.isTrigger);
  let stopLoss = 0;
  let trailingStopLoss: number | null = null;

  if (slOrders.length === 1) {
    stopLoss = slOrders[0].triggerPx;
  } else if (slOrders.length >= 2 && direction) {
    const sorted = [...slOrders].sort((a, b) => a.triggerPx - b.triggerPx);
    if (direction === "long") {
      // Long: lower triggerPx = fixed SL (further from price), higher = trailing
      stopLoss = sorted[0].triggerPx;
      trailingStopLoss = sorted[sorted.length - 1].triggerPx;
    } else {
      // Short: higher triggerPx = fixed SL (further from price), lower = trailing
      stopLoss = sorted[sorted.length - 1].triggerPx;
      trailingStopLoss = sorted[0].triggerPx;
    }
  } else if (slOrders.length >= 2) {
    // No direction provided — pick first as SL, can't discriminate trailing
    stopLoss = slOrders[0].triggerPx;
  }

  const tpOrders = coinReduceOnly.filter((o) => !o.isTrigger);
  const takeProfits = tpOrders.map((o) => ({
    price: o.limitPx,
    pctOfPosition: posSize > 0 ? o.sz / posSize : 0,
  }));

  return { stopLoss, takeProfits, trailingStopLoss };
}
