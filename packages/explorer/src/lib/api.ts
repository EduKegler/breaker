const BASE = "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`Server returned ${res.status} (not JSON). Is the daemon running?`);
  }
  const data = (await res.json()) as T;
  if (!res.ok) throw Object.assign(new Error(`API error: ${res.status}`), { data });
  return data;
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`Server returned ${res.status} (not JSON). Is the daemon running?`);
  }
  const data = (await res.json()) as T;
  if (!res.ok) throw Object.assign(new Error(`API error: ${res.status}`), { data });
  return data;
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

export interface ConfigResponse {
  mode: string;
  asset: string;
  strategy: string;
  interval: string;
  leverage: number;
  guardrails: Record<string, number>;
  sizing: Record<string, unknown>;
  dataSource?: string;
}

export interface QuickSignalPayload {
  direction: "long" | "short";
}

export interface QuickSignalResponse {
  status: "executed" | "rejected" | "error";
  signalId?: number;
  stopLoss?: number;
  reason?: string;
  error?: string;
}

export const api = {
  health: () => fetchJson<HealthResponse>("/health"),
  positions: () => fetchJson<{ positions: LivePosition[] }>("/positions"),
  orders: () => fetchJson<{ orders: OrderRow[] }>("/orders"),
  equity: () => fetchJson<{ snapshots: EquitySnapshot[] }>("/equity"),
  openOrders: () => fetchJson<{ orders: OpenOrder[] }>("/open-orders"),
  config: () => fetchJson<ConfigResponse>("/config"),
  candles: (before?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (before) params.set("before", String(before));
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return fetchJson<{ candles: CandleData[] }>(`/candles${qs ? `?${qs}` : ""}`);
  },
  signals: () => fetchJson<{ signals: SignalRow[] }>("/signals"),
  strategySignals: (before?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (before) params.set("before", String(before));
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return fetchJson<{ signals: ReplaySignal[] }>(`/strategy-signals${qs ? `?${qs}` : ""}`);
  },
  sendQuickSignal: (payload: QuickSignalPayload) =>
    postJson<QuickSignalResponse>("/quick-signal", payload),
  closePosition: (coin: string) =>
    postJson<{ status: string }>("/close-position", { coin }),
  cancelOrder: (oid: number) =>
    deleteJson<{ status: string }>(`/open-order/${oid}`),
};
