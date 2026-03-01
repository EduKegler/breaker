import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from "react";
import { api } from "./lib/api.js";
import type { HealthResponse, LivePosition, OrderRow, EquitySnapshot, ConfigResponse, OpenOrder, CandleData, SignalRow, ReplaySignal, AccountResponse, PricesEvent } from "./types/api.js";
import { useWebSocket, type WsMessage, type WsStatus } from "./lib/use-websocket.js";
import { useToasts } from "./lib/use-toasts.js";
import { EquityChart } from "./components/equity-chart.js";
import { CandlestickChart } from "./components/candlestick-chart.js";
import { PositionCard } from "./components/position-card.js";
import { OrderTable } from "./components/order-table.js";
import { OpenOrdersTable } from "./components/open-orders-table.js";
import { SignalPopover } from "./components/signal-popover.js";
import { ToastContainer } from "./components/toast-container.js";
import { AccountPanel } from "./components/account-panel.js";
import { CoinChartToolbar } from "./components/coin-chart-toolbar.js";
import { CandleCountdown } from "./components/candle-countdown.js";
import { TimeframeSwitcher } from "./components/timeframe-switcher.js";
import { RangeSelector } from "./components/range-selector.js";
import type { Time } from "lightweight-charts";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const wsStatusLabel: Record<WsStatus, string> = {
  connecting: "WS…",
  connected: "WS",
  disconnected: "WS ✕",
};

const wsStatusColor: Record<WsStatus, string> = {
  connecting: "text-amber",
  connected: "text-profit",
  disconnected: "text-loss",
};

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

function errorMsg(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error ?? e?.message ?? "unknown error";
}

// Stable empty arrays — prevent `?? []` from creating new references on each render
const EMPTY_CANDLES: CandleData[] = [];
const EMPTY_REPLAY: ReplaySignal[] = [];
const EMPTY_STRINGS: string[] = [];

/** Merge incoming replay signals into existing per-coin record, deduping by t:strategyName. */
function mergeReplaySignals(
  prev: Record<string, ReplaySignal[]>,
  coin: string,
  incoming: ReplaySignal[],
): Record<string, ReplaySignal[]> {
  const existing = prev[coin] ?? [];
  const keys = new Set(existing.map((s) => `${s.t}:${s.strategyName}`));
  const fresh = incoming.filter((s) => !keys.has(`${s.t}:${s.strategyName}`));
  if (fresh.length === 0) return prev;
  return { ...prev, [coin]: [...existing, ...fresh].sort((a, b) => a.t - b.t) };
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [equity, setEquity] = useState<EquitySnapshot[]>([]);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [httpError, setHttpError] = useState(false);
  const [showSignalPopover, setShowSignalPopover] = useState(false);
  const [autoTrading, setAutoTrading] = useState(false);
  const { addToast } = useToasts();
  const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showVpvr, setShowVpvr] = useState(false);
  const [selectedInterval, setSelectedInterval] = useState<string | null>(null);
  const [altCandles, setAltCandles] = useState<CandleData[]>(EMPTY_CANDLES);
  const setVisibleRangeRef = useRef<((from: Time, to: Time) => void) | null>(null);
  const rangeSelectorUpdateRef = useRef<((from: Time, to: Time) => void) | null>(null);

  // ── Per-coin state ──────────────────────────
  const [selectedCoin, setSelectedCoin] = useState<string>("");
  const [enabledStrategies, setEnabledStrategies] = useState<Record<string, string[]>>({});
  const [coinCandles, setCoinCandles] = useState<Record<string, CandleData[]>>({});
  const [coinReplaySignals, setCoinReplaySignals] = useState<Record<string, ReplaySignal[]>>({});
  const [coinPrices, setCoinPrices] = useState<Record<string, PricesEvent>>({});

  // Ref for WS handlers to read selectedCoin without stale closure
  const selectedCoinRef = useRef(selectedCoin);
  useEffect(() => { selectedCoinRef.current = selectedCoin; }, [selectedCoin]);

  // Coin list from config
  const coinList = useMemo(() => config?.coins?.map((c) => c.coin) ?? [], [config?.coins]);

  // Strategies for selected coin
  const selectedCoinStrategies = useMemo(() => {
    if (!config?.coins || !selectedCoin) return [];
    const cc = config.coins.find((c) => c.coin === selectedCoin);
    return cc ? cc.strategies.map((s) => s.name) : [];
  }, [config?.coins, selectedCoin]);

  // ── Per-coin data access (stable refs when unrelated coins update) ──
  const selectedCoinCandles = coinCandles[selectedCoin];
  const selectedCoinReplaySignals = coinReplaySignals[selectedCoin];
  const selectedCoinEnabled = enabledStrategies[selectedCoin];

  // ── Derived data for chart ──────────────────
  const selectedCoinInterval = useMemo(() => {
    if (!config?.coins || !selectedCoin) return null;
    const cc = config.coins.find((c) => c.coin === selectedCoin);
    return cc?.strategies[0]?.interval ?? null;
  }, [config?.coins, selectedCoin]);

  const streamingCandles = selectedCoinCandles ?? EMPTY_CANDLES;
  const isLiveInterval = selectedInterval === null;
  const candles = isLiveInterval ? streamingCandles : altCandles;
  const selectedPrices = coinPrices[selectedCoin] ?? null;
  const currentEnabledStrategies = selectedCoinEnabled ?? EMPTY_STRINGS;

  const filteredReplaySignals = useMemo(() => {
    const rs = selectedCoinReplaySignals ?? EMPTY_REPLAY;
    if (currentEnabledStrategies.length === 0) return rs;
    return rs.filter((s) => currentEnabledStrategies.includes(s.strategyName));
  }, [selectedCoinReplaySignals, currentEnabledStrategies]);

  const filteredSignals = useMemo(() => {
    if (!selectedCoin) return signals;
    return signals.filter((s) => {
      if (s.asset !== selectedCoin) return false;
      // Manual signals (no strategy_name) are always visible
      if (!s.strategy_name) return true;
      return currentEnabledStrategies.includes(s.strategy_name);
    });
  }, [signals, selectedCoin, currentEnabledStrategies]);

  const coinPositions = useMemo(
    () => selectedCoin ? positions.filter((p) => p.coin === selectedCoin) : positions,
    [positions, selectedCoin],
  );

  const watermark = useMemo(
    () => selectedCoin ? { asset: selectedCoin } : undefined,
    [selectedCoin],
  );

  const handleClosePosition = useCallback(async (coin: string) => {
    try {
      await api.closePosition(coin);
      addToast(`${coin} position closed`, "success");
    } catch (err) {
      addToast(`Close ${coin}: ${errorMsg(err)}`, "error");
    }
  }, [addToast]);

  const handleCancelOrder = useCallback(async (_coin: string, oid: number) => {
    try {
      await api.cancelOrder(oid);
      addToast(`Order ${oid} cancelled`, "success");
    } catch (err) {
      addToast(`Cancel #${oid}: ${errorMsg(err)}`, "error");
    }
  }, [addToast]);

  const handleLoadMoreCandles = useCallback((before: number) => {
    const coin = selectedCoinRef.current;
    if (!coin) return;
    api.candles({ coin, before, limit: 500 }).then((r) => {
      if (r.candles.length === 0) return;
      setCoinCandles((prev) => {
        const existing = prev[coin] ?? [];
        const existingTimes = new Set(existing.map((c) => c.t));
        const newCandles = r.candles.filter((c) => !existingTimes.has(c.t));
        if (newCandles.length === 0) return prev;
        return { ...prev, [coin]: [...newCandles, ...existing].sort((a, b) => a.t - b.t) };
      });
    }).catch(() => {});
    // Also fetch replay signals for the new range
    api.strategySignals({ coin, before }).then((r) => {
      if (r.signals.length === 0) return;
      setCoinReplaySignals((prev) => mergeReplaySignals(prev, coin, r.signals));
    }).catch(() => {});
  }, []);

  // ── Initial HTTP fetch (non-coin-dependent) ─
  useEffect(() => {
    Promise.all([
      api.health().then(setHealth).catch(() => setHttpError(true)),
      api.config().then(setConfig).catch(() => {}),
      api.positions().then((r) => setPositions(r.positions)).catch(() => {}),
      api.orders().then((r) => setOrders(r.orders)).catch(() => {}),
      api.openOrders().then((r) => setOpenOrders(r.orders)).catch(() => {}),
      api.equity().then((r) => setEquity(r.snapshots)).catch(() => {}),
      api.signals().then((r) => setSignals(r.signals)).catch(() => {}),
      api.account().then(setAccount).catch(() => {}),
    ]);
  }, []);

  // ── Init selectedCoin + enabledStrategies + fetch per-coin data ─
  useEffect(() => {
    if (!config?.coins?.length) return;
    const coins = config.coins;
    const firstCoin = coins[0].coin;

    // Set selectedCoin if not yet set
    setSelectedCoin((prev) => prev || firstCoin);

    // Initialize enabledStrategies for each coin (all enabled)
    setEnabledStrategies((prev) => {
      const next = { ...prev };
      for (const cc of coins) {
        if (!next[cc.coin]) {
          next[cc.coin] = cc.strategies.map((s) => s.name);
        }
      }
      return next;
    });

    // Fetch candles + replay signals per coin in parallel
    const fetchPromises: Promise<void>[] = [];
    const oldestByCoins: Record<string, number> = {};
    for (const cc of coins) {
      const coin = cc.coin;
      // Candles
      fetchPromises.push(
        api.candles({ coin }).then((r) => {
          setCoinCandles((prev) => ({ ...prev, [coin]: r.candles }));
          if (r.candles.length > 0) oldestByCoins[coin] = r.candles[0].t;
        }).catch(() => {}),
      );
      // Replay signals per strategy (merge by t:strategyName)
      for (const strat of cc.strategies) {
        fetchPromises.push(
          api.strategySignals({ coin, strategy: strat.name }).then((r) => {
            if (r.signals.length === 0) return;
            setCoinReplaySignals((prev) => mergeReplaySignals(prev, coin, r.signals));
          }).catch(() => {}),
        );
      }
    }
    // Phase 1: show chart with warmup data ASAP
    // Phase 2: pre-fetch historical candles + signals for all coins in background
    const PREFETCH_BARS = 1500;
    Promise.all(fetchPromises).finally(() => {
      setCandlesLoading(false);
      for (const [coin, oldest] of Object.entries(oldestByCoins)) {
        api.candles({ coin, before: oldest, limit: PREFETCH_BARS }).then((hist) => {
          if (hist.candles.length === 0) return;
          setCoinCandles((prev) => {
            const existing = prev[coin] ?? [];
            const existingTimes = new Set(existing.map((c) => c.t));
            const fresh = hist.candles.filter((c) => !existingTimes.has(c.t));
            if (fresh.length === 0) return prev;
            return { ...prev, [coin]: [...fresh, ...existing].sort((a, b) => a.t - b.t) };
          });
        }).catch(() => {});
        api.strategySignals({ coin, before: oldest }).then((r) => {
          if (r.signals.length === 0) return;
          setCoinReplaySignals((prev) => mergeReplaySignals(prev, coin, r.signals));
        }).catch(() => {});
      }
    });
  }, [config?.coins]);

  // Fetch alt candles when interval changes
  useEffect(() => {
    if (!selectedCoin || selectedInterval === null) {
      setAltCandles(EMPTY_CANDLES);
      return;
    }
    api.candles({ coin: selectedCoin, interval: selectedInterval, limit: 500 })
      .then((r) => setAltCandles(r.candles))
      .catch(() => setAltCandles(EMPTY_CANDLES));
  }, [selectedCoin, selectedInterval]);

  // Sync autoTrading with config (true if any strategy has it enabled)
  useEffect(() => {
    if (!config?.coins) return;
    const anyEnabled = config.coins.some((c) => c.strategies.some((s) => s.autoTradingEnabled));
    setAutoTrading(anyEnabled);
  }, [config?.coins]);

  const handleToggleAutoTrading = useCallback(async () => {
    const coins = config?.coins;
    if (!coins?.length) return;
    const newValue = !autoTrading;
    setAutoTrading(newValue);
    try {
      await Promise.all(coins.map((c) => api.setAutoTrading(c.coin, newValue)));
      addToast(`Auto trading ${newValue ? "enabled" : "disabled"}`, "success");
    } catch (err) {
      setAutoTrading(!newValue);
      addToast(`Auto trading toggle: ${errorMsg(err)}`, "error");
    }
  }, [autoTrading, config?.coins, addToast]);

  // Clear price flash after animation
  useEffect(() => {
    if (!priceFlash) return;
    const id = setTimeout(() => setPriceFlash(null), 700);
    return () => clearTimeout(id);
  }, [priceFlash]);

  // Periodic account refresh (no WS event for account state)
  useEffect(() => {
    const id = setInterval(() => {
      api.account().then(setAccount).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Range selector handlers ─────────────────
  // Direct ref-based communication: chart → rangeSelectorUpdateRef → RangeSelector
  // No React state re-renders on every scroll frame.
  const handleVisibleRangeChange = useCallback((from: Time, to: Time) => {
    rangeSelectorUpdateRef.current?.(from, to);
  }, []);

  const handleSetVisibleRangeRef = useCallback((ref: ((from: Time, to: Time) => void) | null) => {
    setVisibleRangeRef.current = ref;
  }, []);

  const handleSetRangeSelectorUpdate = useCallback((ref: ((from: Time, to: Time) => void) | null) => {
    rangeSelectorUpdateRef.current = ref;
  }, []);

  const handleRangeSelectorChange = useCallback((from: Time, to: Time) => {
    setVisibleRangeRef.current?.(from, to);
  }, []);

  // ── Coin selection handlers ─────────────────
  const handleSelectCoin = useCallback((coin: string) => {
    startTransition(() => {
      setSelectedCoin(coin);
      setSelectedInterval(null);
      setPriceFlash(null);
    });
  }, []);

  const handleToggleStrategy = useCallback((strategy: string) => {
    setEnabledStrategies((prev) => {
      const coin = selectedCoinRef.current;
      if (!coin) return prev;
      const current = prev[coin] ?? [];
      // Prevent disabling the last strategy
      if (current.includes(strategy) && current.length <= 1) return prev;
      const next = current.includes(strategy)
        ? current.filter((s) => s !== strategy)
        : [...current, strategy];
      return { ...prev, [coin]: next };
    });
  }, []);

  // ── WebSocket handler ───────────────────────
  const handleWsMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case "snapshot": {
        const d = msg.data as {
          positions: LivePosition[];
          orders: OrderRow[];
          openOrders: OpenOrder[];
          equity: { snapshots: EquitySnapshot[] } | EquitySnapshot[];
          health: HealthResponse;
          signals?: SignalRow[];
        };
        setPositions(d.positions);
        setOrders(d.orders);
        setOpenOrders(d.openOrders);
        setEquity(Array.isArray(d.equity) ? d.equity : d.equity.snapshots);
        setHealth(d.health);
        // Ignore d.candles — per-coin fetch replaces snapshot candles
        if (d.signals) setSignals(d.signals);
        break;
      }
      case "positions":
        setPositions(msg.data as LivePosition[]);
        break;
      case "orders":
        setOrders(msg.data as OrderRow[]);
        break;
      case "open-orders":
        setOpenOrders(msg.data as OpenOrder[]);
        break;
      case "equity":
        setEquity(msg.data as EquitySnapshot[]);
        break;
      case "health":
        setHealth(msg.data as HealthResponse);
        break;
      case "candle": {
        const newCandle = msg.data as CandleData & { coin?: string };
        const coin = newCandle.coin;
        if (!coin) break;
        setCoinCandles((prev) => {
          const arr = prev[coin] ?? [];
          const last = arr.length - 1;
          // Fast path: in-progress candle update (almost always the last element)
          if (last >= 0 && arr[last].t === newCandle.t) {
            const updated = [...arr];
            updated[last] = newCandle;
            return { ...prev, [coin]: updated };
          }
          // Slow path: search for matching timestamp
          const idx = arr.findIndex((c) => c.t === newCandle.t);
          if (idx >= 0) {
            const updated = [...arr];
            updated[idx] = newCandle;
            return { ...prev, [coin]: updated };
          }
          return { ...prev, [coin]: [...arr, newCandle] };
        });
        break;
      }
      case "signals":
        setSignals(msg.data as SignalRow[]);
        break;
      case "prices": {
        const p = msg.data as PricesEvent;
        const coin = p.coin;
        if (!coin) break;
        setCoinPrices((prev) => {
          const old = prev[coin];
          // Price flash only for selected coin
          if (coin === selectedCoinRef.current) {
            const refPrice = p.hlMidPrice ?? p.dataSourcePrice;
            const prevRefPrice = old?.hlMidPrice ?? old?.dataSourcePrice;
            if (refPrice != null && prevRefPrice != null && refPrice !== prevRefPrice) {
              setPriceFlash(refPrice > prevRefPrice ? "up" : "down");
            }
          }
          return { ...prev, [coin]: p };
        });
        break;
      }
    }
  }, []);

  const { status: wsStatus } = useWebSocket({
    url: wsUrl(),
    onMessage: handleWsMessage,
  });

  const h = health;
  const c = config;
  const isOnline = !!h;
  const mode = c?.mode ?? h?.mode ?? "—";
  const isTestnet = mode === "testnet";

  // Header context: show coin list + strategies summary
  const headerCoinsLabel = coinList.length > 0 ? coinList.join(" · ") : h?.asset ?? "";

  return (
    <div className="min-h-screen bg-terminal-bg font-display">
      {/* ── Header bar ────────────────────── */}
      <header className="glow-header bg-terminal-surface border-b border-terminal-border px-5 py-3">
        <div className="flex items-center gap-5">
          {/* Logo */}
          <span className="text-profit font-bold text-lg tracking-wider">
            BREAKER
          </span>

          <div className="w-px h-5 bg-terminal-border" />

          {/* Status dot */}
          {isOnline ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-profit animate-pulse-green" />
              <span className="text-txt-secondary">ONLINE</span>
            </span>
          ) : httpError ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-loss" />
              <span className="text-loss">OFFLINE</span>
            </span>
          ) : (
            <span className="text-txt-secondary text-sm">Connecting...</span>
          )}

          <div className="w-px h-5 bg-terminal-border" />

          {/* Context info */}
          {isOnline && (
            <>
              <span className="font-mono text-sm font-medium text-txt-primary">
                {headerCoinsLabel}
              </span>
              {c?.coins?.[0] && (
                <span className="font-mono text-xs text-txt-secondary">
                  {c.coins[0].leverage}x
                </span>
              )}
            </>
          )}

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            {/* ── Actionable buttons ── */}
            <button
              type="button"
              disabled={!isOnline}
              onClick={handleToggleAutoTrading}
              className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded border transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer ${
                autoTrading
                  ? "bg-profit/15 text-profit border-profit/40 hover:bg-profit/30 hover:border-profit/60"
                  : "bg-terminal-border/50 text-txt-secondary/60 border-terminal-border hover:bg-terminal-border/70 hover:text-txt-secondary"
              }`}
            >
              Auto
            </button>
            <div className="relative">
              <button
                type="button"
                disabled={!isOnline}
                onClick={() => setShowSignalPopover((v) => !v)}
                className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded bg-amber/15 text-amber border border-amber/40 hover:bg-amber/30 hover:border-amber/60 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                Signal
              </button>
              {showSignalPopover && config?.coins && (
                <SignalPopover
                  coins={config.coins}
                  onClose={() => setShowSignalPopover(false)}
                  onSuccess={() => setShowSignalPopover(false)}
                />
              )}
            </div>

            <div className="w-px h-4 bg-terminal-border" />

            {/* ── Status badges (no border, flat pills) ── */}
            <div className="flex items-center gap-2">
              <span className={`flex items-center gap-1.5 text-[10px] font-mono font-medium ${wsStatusColor[wsStatus]}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  wsStatus === "connected" ? "bg-profit" : wsStatus === "connecting" ? "bg-amber animate-pulse" : "bg-loss"
                }`} />
                {wsStatusLabel[wsStatus]}
              </span>

              <span
                className={`px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase rounded-sm ${
                  isTestnet
                    ? "bg-blue-500/10 text-blue-400"
                    : "bg-loss/10 text-loss"
                }`}
              >
                {mode}
              </span>

              {h && (
                <span className="text-[10px] font-mono text-txt-secondary/70">
                  {formatUptime(h.uptime)}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Main grid ─────────────────────── */}
      <main className="p-4 space-y-4">
        {/* Account info bar */}
        <AccountPanel account={account} positions={positions} />

        {/* Candlestick chart (full width) */}
        <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary">
                Price Chart
                {c?.dataSource && (
                  <span className="ml-2 font-mono font-medium text-[10px] text-txt-secondary/60 lowercase">
                    via {c.dataSource}
                  </span>
                )}
              </h2>
              {selectedCoinInterval && (
                <TimeframeSwitcher
                  streamingInterval={selectedCoinInterval}
                  selectedInterval={selectedInterval}
                  onSelect={setSelectedInterval}
                />
              )}
              {coinList.length >= 2 && (
                <CoinChartToolbar
                  coins={coinList}
                  selectedCoin={selectedCoin}
                  onSelectCoin={handleSelectCoin}
                  strategies={selectedCoinStrategies}
                  enabledStrategies={currentEnabledStrategies}
                  onToggleStrategy={handleToggleStrategy}
                />
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowSessions((v) => !v)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all cursor-pointer ${
                  showSessions
                    ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                    : "bg-terminal-border/30 text-txt-secondary/50 border border-transparent hover:text-txt-secondary/80"
                }`}
                title="Toggle session highlights (Asia/Europe/America)"
              >
                Sessions
              </button>
              <button
                type="button"
                onClick={() => setShowVpvr((v) => !v)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all cursor-pointer ${
                  showVpvr
                    ? "bg-amber/15 text-amber border border-amber/30"
                    : "bg-terminal-border/30 text-txt-secondary/50 border border-transparent hover:text-txt-secondary/80"
                }`}
                title="Toggle Volume Profile (VPVR)"
              >
                VPVR
              </button>
              <div className="w-px h-4 bg-terminal-border" />
              {selectedCoinInterval && <CandleCountdown interval={selectedCoinInterval} />}
              {selectedPrices && (selectedPrices.hlMidPrice != null || selectedPrices.dataSourcePrice != null) && (
              <div className={`relative flex items-center gap-3 ${priceFlash === "up" ? "price-flash-up" : priceFlash === "down" ? "price-flash-down" : ""}`}>
                {selectedPrices.hlMidPrice != null && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary/60">HL</span>
                    <span className="font-mono text-sm font-medium text-txt-primary">{selectedPrices.hlMidPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </span>
                )}
                {selectedPrices.hlMidPrice != null && selectedPrices.dataSourcePrice != null && (
                  <span className="text-txt-secondary/30 text-xs">·</span>
                )}
                {selectedPrices.dataSourcePrice != null && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary/60">BIN</span>
                    <span className="font-mono text-sm font-medium text-txt-primary">{selectedPrices.dataSourcePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </span>
                )}
              </div>
            )}
            </div>
          </div>
          <CandlestickChart coin={selectedCoin} candles={candles} signals={filteredSignals} replaySignals={filteredReplaySignals} positions={coinPositions} loading={candlesLoading} isLive={isLiveInterval} onLoadMore={handleLoadMoreCandles} watermark={watermark} coinList={coinList} onSelectCoin={handleSelectCoin} showSessions={showSessions} showVpvr={showVpvr} onVisibleRangeChange={handleVisibleRangeChange} onSetVisibleRange={handleSetVisibleRangeRef} />
          <RangeSelector candles={candles} onRangeChange={handleRangeSelectorChange} onSetUpdate={handleSetRangeSelectorUpdate} />
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
          {/* Equity chart */}
          <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
              Equity Curve
            </h2>
            <EquityChart snapshots={equity} />
          </section>

          {/* Positions */}
          <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
              Positions
            </h2>
            {positions.length ? (
              <div className="space-y-3">
                {positions.map((p) => (
                  <PositionCard key={p.coin} position={p} openOrders={openOrders} onClose={handleClosePosition} />
                ))}
              </div>
            ) : (
              <p className="text-txt-secondary text-sm font-mono">
                No open positions
              </p>
            )}
          </section>
        </div>

        {/* Open Orders */}
        <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary">
              Open Orders
            </h2>
            {openOrders.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-sm bg-amber/10 text-amber">
                {openOrders.length}
              </span>
            )}
          </div>
          <OpenOrdersTable orders={openOrders} onCancel={handleCancelOrder} />
        </section>

        {/* Order log */}
        <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
            Order Log
          </h2>
          <OrderTable orders={orders} />
        </section>
      </main>
      <ToastContainer />
    </div>
  );
}
