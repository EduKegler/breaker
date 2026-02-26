export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "stop" | "limit";

export interface Order {
  id: string;
  side: OrderSide;
  type: OrderType;
  price: number | null; // null for market orders
  size: number;
  reduceOnly: boolean;
  tag: string; // "entry" | "sl" | "tp1" | "tp2" | "trail" | etc.
}

export interface Fill {
  orderId: string;
  price: number;
  size: number;
  side: OrderSide;
  fee: number;
  slippage: number;
  timestamp: number;
  tag: string;
}

export interface Position {
  direction: "long" | "short";
  entryPrice: number;
  size: number;
  entryTimestamp: number;
  entryBarIndex: number;
  unrealizedPnl: number;
  fills: Fill[];
}

export interface CompletedTrade {
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  entryTimestamp: number;
  exitTimestamp: number;
  entryBarIndex: number;
  exitBarIndex: number;
  barsHeld: number;
  exitType: string; // "sl" | "tp1" | "tp2" | "trail" | "signal" | etc.
  commission: number;
  slippageCost: number;
  entryComment: string;
  exitComment: string;
}
