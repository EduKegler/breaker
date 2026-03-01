import { useEffect } from "react";
import { useStore } from "./store/use-store.js";
import { connectWebSocket } from "./store/websocket.js";
import {
  selectCoinList,
  selectSelectedCoinStrategies,
  selectSelectedCoinInterval,
  selectCurrentEnabledStrategies,
} from "./store/selectors.js";
import type { WsStatus } from "./store/types.js";
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
import { PriceDisplay } from "./components/price-display.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const wsStatusLabel: Record<WsStatus, string> = {
  connecting: "WS\u2026",
  connected: "WS",
  disconnected: "WS \u2715",
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

export function App() {
  const { addToast } = useToasts();

  // ── Store selectors (low-frequency only — high-freq moved to leaf components) ─
  const health = useStore((s) => s.health);
  const config = useStore((s) => s.config);
  const positions = useStore((s) => s.positions);
  const openOrders = useStore((s) => s.openOrders);
  const equity = useStore((s) => s.equity);
  const orders = useStore((s) => s.orders);
  const account = useStore((s) => s.account);
  const httpError = useStore((s) => s.httpError);
  const selectedCoin = useStore((s) => s.selectedCoin);
  const selectedInterval = useStore((s) => s.selectedInterval);
  const showSignalPopover = useStore((s) => s.showSignalPopover);
  const showSessions = useStore((s) => s.showSessions);
  const showVpvr = useStore((s) => s.showVpvr);
  const wsStatus = useStore((s) => s.wsStatus);
  const autoTrading = useStore((s) => s.autoTrading);

  // Derived selectors (low-frequency)
  const coinList = useStore(selectCoinList);
  const selectedCoinStrategies = useStore(selectSelectedCoinStrategies);
  const selectedCoinInterval = useStore(selectSelectedCoinInterval);
  const currentEnabledStrategies = useStore(selectCurrentEnabledStrategies);

  // ── Actions (stable refs from store) ────────
  const fetchInitialData = useStore((s) => s.fetchInitialData);
  const initCoinData = useStore((s) => s.initCoinData);
  const fetchAltCandles = useStore((s) => s.fetchAltCandles);
  const closePosition = useStore((s) => s.closePosition);
  const cancelOrder = useStore((s) => s.cancelOrder);
  const toggleAutoTrading = useStore((s) => s.toggleAutoTrading);
  const selectCoin = useStore((s) => s.selectCoin);
  const setSelectedInterval = useStore((s) => s.setSelectedInterval);
  const toggleStrategy = useStore((s) => s.toggleStrategy);
  const setShowSignalPopover = useStore((s) => s.setShowSignalPopover);
  const setShowSessions = useStore((s) => s.setShowSessions);
  const setShowVpvr = useStore((s) => s.setShowVpvr);
  const setToastFn = useStore((s) => s.setToastFn);
  const refreshAccount = useStore((s) => s.refreshAccount);

  // ── Toast bridge ────────────────────────────
  useEffect(() => {
    setToastFn(addToast);
    return () => setToastFn(null);
  }, [addToast, setToastFn]);

  // ── WebSocket ───────────────────────────────
  useEffect(() => {
    return connectWebSocket(wsUrl(), useStore);
  }, []);

  // ── Initial HTTP fetch ──────────────────────
  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // ── Init coin data when config arrives ──────
  useEffect(() => {
    if (config?.coins?.length) {
      initCoinData(config);
    }
  }, [config, initCoinData]);

  // ── Fetch alt candles when interval changes ─
  useEffect(() => {
    fetchAltCandles(selectedCoin, selectedInterval);
  }, [selectedCoin, selectedInterval, fetchAltCandles]);

  // ── Periodic account refresh (30s) ──────────
  useEffect(() => {
    const id = setInterval(refreshAccount, 30_000);
    return () => clearInterval(id);
  }, [refreshAccount]);

  // ── Derived header values ───────────────────
  const h = health;
  const c = config;
  const isOnline = !!h;
  const mode = c?.mode ?? h?.mode ?? "\u2014";
  const isTestnet = mode === "testnet";
  const headerCoinsLabel =
    coinList.length > 0 ? coinList.join(" \u00b7 ") : (h?.asset ?? "");

  return (
    <div className="min-h-screen bg-terminal-bg font-display">
      {/* ── Header bar ────────────────────── */}
      <header className="glow-header bg-terminal-surface border-b border-terminal-border px-5 py-3">
        <div className="flex items-center gap-5">
          <span className="text-profit font-bold text-lg tracking-wider">
            BREAKER
          </span>

          <div className="w-px h-5 bg-terminal-border" />

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

          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              disabled={!isOnline}
              onClick={toggleAutoTrading}
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
                onClick={() => setShowSignalPopover(!showSignalPopover)}
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

            <div className="flex items-center gap-2">
              <span
                className={`flex items-center gap-1.5 text-[10px] font-mono font-medium ${wsStatusColor[wsStatus]}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    wsStatus === "connected"
                      ? "bg-profit"
                      : wsStatus === "connecting"
                        ? "bg-amber animate-pulse"
                        : "bg-loss"
                  }`}
                />
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
        <AccountPanel account={account} positions={positions} />

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
                  onSelectCoin={selectCoin}
                  strategies={selectedCoinStrategies}
                  enabledStrategies={currentEnabledStrategies}
                  onToggleStrategy={toggleStrategy}
                />
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowSessions(!showSessions)}
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
                onClick={() => setShowVpvr(!showVpvr)}
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
              {selectedCoinInterval && (
                <CandleCountdown interval={selectedCoinInterval} />
              )}
              <PriceDisplay />
            </div>
          </div>
          <CandlestickChart />
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
          <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
              Equity Curve
            </h2>
            <EquityChart snapshots={equity} />
          </section>

          <section className="bg-terminal-surface border border-terminal-border rounded-sm p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-secondary mb-3">
              Positions
            </h2>
            {positions.length ? (
              <div className="space-y-3">
                {positions.map((p) => (
                  <PositionCard
                    key={p.coin}
                    position={p}
                    openOrders={openOrders}
                    onClose={closePosition}
                  />
                ))}
              </div>
            ) : (
              <p className="text-txt-secondary text-sm font-mono">
                No open positions
              </p>
            )}
          </section>
        </div>

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
          <OpenOrdersTable orders={openOrders} onCancel={cancelOrder} />
        </section>

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
