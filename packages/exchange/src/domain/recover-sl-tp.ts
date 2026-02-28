import type { HlOpenOrder } from "../types/hl-client.js";

interface RecoveredSlTp {
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
}

export function recoverSlTp(
  coin: string,
  posSize: number,
  openOrders: HlOpenOrder[],
): RecoveredSlTp {
  const coinReduceOnly = openOrders.filter(
    (o) => o.coin === coin && o.reduceOnly,
  );

  const slOrder = coinReduceOnly.find((o) => o.isTrigger);
  const stopLoss = slOrder ? slOrder.triggerPx : 0;

  const tpOrders = coinReduceOnly.filter((o) => !o.isTrigger);
  const takeProfits = tpOrders.map((o) => ({
    price: o.limitPx,
    pctOfPosition: posSize > 0 ? o.sz / posSize : 0,
  }));

  return { stopLoss, takeProfits };
}
