import type { Signal } from "@breaker/backtest";
import type { Sizing } from "../types/config.js";

export interface OrderIntent {
  coin: string;
  side: "buy" | "sell";
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  direction: "long" | "short";
  notionalUsd: number;
  comment: string;
}

export function signalToIntent(
  signal: Signal,
  currentPrice: number,
  coin: string,
  sizing: Sizing,
): OrderIntent {
  const entryPrice = signal.entryPrice ?? currentPrice;
  const stopDist = Math.abs(entryPrice - signal.stopLoss);

  let size: number;
  if (sizing.mode === "cash") {
    size = entryPrice > 0 ? sizing.cashPerTrade / entryPrice : 0;
  } else {
    size = stopDist > 0 ? sizing.riskPerTradeUsd / stopDist : 0;
  }

  const side = signal.direction === "long" ? "buy" : "sell";
  const notionalUsd = size * entryPrice;

  return {
    coin,
    side,
    size,
    entryPrice,
    stopLoss: signal.stopLoss,
    takeProfits: signal.takeProfits,
    direction: signal.direction,
    notionalUsd,
    comment: signal.comment,
  };
}
