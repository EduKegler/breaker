import { useState, useEffect, useCallback } from "react";
import { api } from "./lib/api.js";
import type { HealthResponse, LivePosition, OrderRow, EquitySnapshot, ConfigResponse, OpenOrder, CandleData, SignalRow, ReplaySignal, AccountResponse } from "./types/api.js";
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

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [equity, setEquity] = useState<EquitySnapshot[]>([]);
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [replaySignals, setReplaySignals] = useState<ReplaySignal[]>([]);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [httpError, setHttpError] = useState(false);
  const [showSignalPopover, setShowSignalPopover] = useState(false);
  const { addToast } = useToasts();

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
    api.candles(before, 500).then((r) => {
      if (r.candles.length === 0) return;
      setCandles((prev) => {
        const existingTimes = new Set(prev.map((c) => c.t));
        const newCandles = r.candles.filter((c) => !existingTimes.has(c.t));
        if (newCandles.length === 0) return prev;
        return [...newCandles, ...prev].sort((a, b) => a.t - b.t);
      });
    }).catch(() => {});
    // Also fetch replay signals for the new range
    api.strategySignals(before).then((r) => {
      if (r.signals.length === 0) return;
      setReplaySignals((prev) => {
        const existingTimes = new Set(prev.map((s) => s.t));
        const newSignals = r.signals.filter((s) => !existingTimes.has(s.t));
        if (newSignals.length === 0) return prev;
        return [...newSignals, ...prev].sort((a, b) => a.t - b.t);
      });
    }).catch(() => {});
  }, []);

  // Initial HTTP fetch (one-shot)
  useEffect(() => {
    Promise.all([
      api.health().then(setHealth).catch(() => setHttpError(true)),
      api.config().then(setConfig).catch(() => {}),
      api.positions().then((r) => setPositions(r.positions)).catch(() => {}),
      api.orders().then((r) => setOrders(r.orders)).catch(() => {}),
      api.openOrders().then((r) => setOpenOrders(r.orders)).catch(() => {}),
      api.equity().then((r) => setEquity(r.snapshots)).catch(() => {}),
      api.candles().then((r) => setCandles(r.candles)).catch(() => {}),
      api.signals().then((r) => setSignals(r.signals)).catch(() => {}),
      api.strategySignals().then((r) => setReplaySignals(r.signals)).catch(() => {}),
      api.account().then(setAccount).catch(() => {}),
    ]);
  }, []);

  // Periodic account refresh (no WS event for account state)
  useEffect(() => {
    const id = setInterval(() => {
      api.account().then(setAccount).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // WebSocket handler
  const handleWsMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case "snapshot": {
        const d = msg.data as {
          positions: LivePosition[];
          orders: OrderRow[];
          openOrders: OpenOrder[];
          equity: { snapshots: EquitySnapshot[] } | EquitySnapshot[];
          health: HealthResponse;
          candles?: CandleData[];
          signals?: SignalRow[];
        };
        setPositions(d.positions);
        setOrders(d.orders);
        setOpenOrders(d.openOrders);
        setEquity(Array.isArray(d.equity) ? d.equity : d.equity.snapshots);
        setHealth(d.health);
        if (d.candles) setCandles(d.candles);
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
        const newCandle = msg.data as CandleData;
        setCandles((prev) => {
          const idx = prev.findIndex((c) => c.t === newCandle.t);
          if (idx >= 0) {
            // Update in-progress candle with new OHLCV
            const updated = [...prev];
            updated[idx] = newCandle;
            return updated;
          }
          return [...prev, newCandle];
        });
        break;
      }
      case "signals":
        setSignals(msg.data as SignalRow[]);
        break;
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
          {h && (
            <>
              <span className="font-mono text-sm font-medium text-txt-primary">
                {h.asset}
              </span>
              <span className="text-txt-secondary text-sm">{h.strategy}</span>
              {c && (
                <>
                  <span className="font-mono text-xs text-txt-secondary">
                    {c.interval}
                  </span>
                  <span className="font-mono text-xs text-txt-secondary">
                    {c.leverage}x
                  </span>
                </>
              )}
            </>
          )}

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            {/* ── Actionable buttons ── */}
            <div className="relative">
              <button
                type="button"
                disabled={!isOnline}
                onClick={() => setShowSignalPopover((v) => !v)}
                className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded bg-amber/15 text-amber border border-amber/40 hover:bg-amber/30 hover:border-amber/60 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                Signal
              </button>
              {showSignalPopover && (
                <SignalPopover
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
          <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
            Price Chart
            {c?.dataSource && (
              <span className="ml-2 font-mono font-medium text-[10px] text-txt-secondary/60 lowercase">
                via {c.dataSource}
              </span>
            )}
          </h2>
          <CandlestickChart candles={candles} signals={signals} replaySignals={replaySignals} positions={positions} onLoadMore={handleLoadMoreCandles} />
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
