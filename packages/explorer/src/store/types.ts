import type {
  LivePosition,
  OrderRow,
  EquitySnapshot,
  OpenOrder,
  CandleData,
  SignalRow,
  ReplaySignal,
  ConfigResponse,
  PricesEvent,
  PendingEntry,
} from "../types/api.js";

export type WsStatus = "connecting" | "connected" | "disconnected";

// ── Slice state types ─────────────────────────

export interface ServerSlice {
  positions: LivePosition[];
  orders: OrderRow[];
  openOrders: OpenOrder[];
  equity: EquitySnapshot[];
  signals: SignalRow[];
  pendingEntries: PendingEntry[];
}

export interface MarketDataSlice {
  coinCandles: Record<string, CandleData[]>;
  coinReplaySignals: Record<string, ReplaySignal[]>;
  coinPrices: Record<string, PricesEvent>;
  candlesLoading: boolean;
  /** Strategy keys currently loading replay signals, e.g. "BTC:donchian-adx" */
  loadingStrategies: Set<string>;
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

  // Coin data
  initCoinData: (config: ConfigResponse) => Promise<void>;
  loadMoreCandles: (before: number) => void;

  // UI actions
  selectCoin: (coin: string) => void;
  setSelectedInterval: (interval: string | null) => void;
  toggleStrategy: (strategy: string) => void;
  setShowSignalPopover: (show: boolean) => void;
  setShowSessions: (show: boolean) => void;
  setShowVpvr: (show: boolean) => void;
  clearPriceFlash: () => void;
}

// ── Combined store ────────────────────────────

export type StoreState = ServerSlice & MarketDataSlice & UiSlice & Actions;
