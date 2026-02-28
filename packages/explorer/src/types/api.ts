export interface HealthResponse {
  status: string;
  mode: string;
  asset: string;
  strategy: string;
  uptime: number;
}

export interface LivePosition {
  coin: string;
  direction: "long" | "short";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  liquidationPx: number | null;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: string;
}

export interface OrderRow {
  id: number;
  signal_id: number;
  hl_order_id: string | null;
  coin: string;
  side: string;
  size: number;
  price: number | null;
  order_type: string;
  tag: string;
  status: string;
  mode: string;
  created_at: string;
  filled_at: string | null;
}

export interface EquitySnapshot {
  id: number;
  timestamp: string;
  equity: number;
  unrealized_pnl: number;
  realized_pnl: number;
  open_positions: number;
}

export interface OpenOrder {
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

export interface CandleData {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SignalRow {
  id: number;
  alert_id: string;
  source: string;
  asset: string;
  side: string;
  entry_price: number;
  stop_loss: number;
  take_profits: string;
  risk_check_passed: number;
  created_at: string;
}

export interface ReplaySignal {
  t: number;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  comment: string;
}

export interface AccountResponse {
  walletAddress: string;
  accountValue: number;
  totalMarginUsed: number;
  totalNtlPos: number;
  withdrawable: number;
  spotBalances: { coin: string; total: number }[];
}

export interface PricesEvent {
  dataSourcePrice: number | null;
  hlMidPrice: number | null;
  trailingExitLevel: number | null;
}

export interface ConfigResponse {
  mode: string;
  asset: string;
  strategy: string;
  interval: string;
  leverage: number;
  guardrails: Record<string, number>;
  sizing: Record<string, unknown>;
  dataSource?: string;
  autoTradingEnabled?: boolean;
}
