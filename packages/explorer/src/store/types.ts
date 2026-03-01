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
  PricesEvent,
} from "../types/api.js";

export type WsStatus = "connecting" | "connected" | "disconnected";

// ── Slice state types ─────────────────────────

export interface ServerSlice {
  health: HealthResponse | null;
  config: ConfigResponse | null;
  positions: LivePosition[];
  orders: OrderRow[];
  openOrders: OpenOrder[];
  equity: EquitySnapshot[];
  signals: SignalRow[];
  account: AccountResponse | null;
  httpError: boolean;
}

export interface MarketDataSlice {
  coinCandles: Record<string, CandleData[]>;
  coinReplaySignals: Record<string, ReplaySignal[]>;
  coinPrices: Record<string, PricesEvent>;
  altCandles: CandleData[];
  candlesLoading: boolean;
}

export interface UiSlice {
  selectedCoin: string;
  selectedInterval: string | null;
  enabledStrategies: Record<string, string[]>;
  showSignalPopover: boolean;
  showSessions: boolean;
  showVpvr: boolean;
  priceFlash: "up" | "down" | null;
  wsStatus: WsStatus;
  autoTrading: boolean;
}

// ── Actions ───────────────────────────────────

export interface Actions {
  // Server data
  fetchInitialData: () => Promise<void>;
  refreshAccount: () => Promise<void>;

  // Coin data
  initCoinData: (config: ConfigResponse) => Promise<void>;
  fetchAltCandles: (coin: string, interval: string | null) => Promise<void>;
  loadMoreCandles: (before: number) => void;

  // Trading actions
  closePosition: (coin: string) => Promise<void>;
  cancelOrder: (coin: string, oid: number) => Promise<void>;
  toggleAutoTrading: () => Promise<void>;

  // UI actions
  selectCoin: (coin: string) => void;
  setSelectedInterval: (interval: string | null) => void;
  toggleStrategy: (strategy: string) => void;
  setShowSignalPopover: (show: boolean) => void;
  setShowSessions: (show: boolean) => void;
  setShowVpvr: (show: boolean) => void;
  clearPriceFlash: () => void;

  // Toast bridge
  setToastFn: (fn: ToastFn | null) => void;
}

export type ToastFn = (message: string, variant?: "success" | "error" | "info") => void;

// ── Combined store ────────────────────────────

export type StoreState = ServerSlice & MarketDataSlice & UiSlice & Actions & {
  _toastFn: ToastFn | null;
};
