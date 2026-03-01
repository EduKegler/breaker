import type {
  HealthResponse,
  LivePosition,
  OrderRow,
  EquitySnapshot,
  OpenOrder,
  CandleData,
  SignalRow,
  ReplaySignal,
  ConfigResponse,
  AccountResponse,
} from "../types/api.js";

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

interface QuickSignalPayload {
  coin: string;
  direction: "long" | "short";
  strategy?: string;
}

interface QuickSignalResponse {
  status: "executed" | "rejected" | "error";
  signalId?: number;
  stopLoss?: number;
  reason?: string;
  error?: string;
}

export const api = {
  health: () => fetchJson<HealthResponse>("/health"),
  account: () => fetchJson<AccountResponse>("/account"),
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
  setAutoTrading: (coin: string, enabled: boolean) =>
    postJson<{ autoTradingEnabled: boolean }>("/auto-trading", { coin, enabled }),
};
