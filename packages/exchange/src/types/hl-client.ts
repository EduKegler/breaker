export interface HlPosition {
  coin: string;
  direction: "long" | "short";
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPx: number | null;
}

export interface HlOpenOrder {
  coin: string;
  oid: number;
  side: string;
  sz: number;
  limitPx: number;
  orderType: string;
  isTrigger: boolean;
  triggerPx: number;
  triggerCondition: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
}

export interface HlHistoricalOrder {
  oid: number;
  status: "filled" | "open" | "canceled" | "triggered" | "rejected" | "marginCanceled";
}

export interface HlOrderResult {
  orderId: string;
  status: "placed" | "simulated";
}

export interface HlEntryResult {
  orderId: string;
  filledSize: number;
  avgPrice: number;
  status: "placed" | "simulated";
}

export interface HlSpotBalance {
  coin: string;
  total: number;
  hold: number;
}

export interface HlAccountState {
  accountValue: number;
  totalMarginUsed: number;
  totalNtlPos: number;
  totalRawUsd: number;
  withdrawable: number;
  spotBalances: HlSpotBalance[];
}

export interface HlClient {
  connect(): Promise<void>;
  getSzDecimals(coin: string): number;
  setLeverage(coin: string, leverage: number, isCross: boolean): Promise<void>;
  placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult>;
  placeEntryOrder(coin: string, isBuy: boolean, size: number, currentPrice: number, slippageBps: number): Promise<HlEntryResult>;
  placeStopOrder(coin: string, isBuy: boolean, size: number, triggerPrice: number, reduceOnly: boolean): Promise<HlOrderResult>;
  placeLimitOrder(coin: string, isBuy: boolean, size: number, price: number, reduceOnly: boolean): Promise<HlOrderResult>;
  cancelOrder(coin: string, orderId: number): Promise<void>;
  getPositions(walletAddress: string): Promise<HlPosition[]>;
  getOpenOrders(walletAddress: string): Promise<HlOpenOrder[]>;
  getHistoricalOrders(walletAddress: string): Promise<HlHistoricalOrder[]>;
  getAccountEquity(walletAddress: string): Promise<number>;
  getAccountState(walletAddress: string): Promise<HlAccountState>;
  getMidPrice(coin: string): Promise<number | null>;
}
