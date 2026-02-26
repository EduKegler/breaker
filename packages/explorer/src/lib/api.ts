const BASE = "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

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

export interface ConfigResponse {
  mode: string;
  asset: string;
  strategy: string;
  interval: string;
  leverage: number;
  guardrails: Record<string, number>;
  sizing: Record<string, unknown>;
}

export const api = {
  health: () => fetchJson<HealthResponse>("/health"),
  positions: () => fetchJson<{ positions: LivePosition[] }>("/positions"),
  orders: () => fetchJson<{ orders: OrderRow[] }>("/orders"),
  equity: () => fetchJson<{ snapshots: EquitySnapshot[] }>("/equity"),
  config: () => fetchJson<ConfigResponse>("/config"),
};
