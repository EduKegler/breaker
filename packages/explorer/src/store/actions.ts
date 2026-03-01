import type { StateCreator } from "zustand";
import type { StoreState, Actions, ToastFn } from "./types.js";
import type { CandleData, ReplaySignal, ConfigResponse } from "../types/api.js";
import { api } from "../lib/api.js";

function errorMsg(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error ?? e?.message ?? "unknown error";
}

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

function mergeCandles(
  prev: Record<string, CandleData[]>,
  coin: string,
  incoming: CandleData[],
): Record<string, CandleData[]> {
  const existing = prev[coin] ?? [];
  const existingTimes = new Set(existing.map((c) => c.t));
  const fresh = incoming.filter((c) => !existingTimes.has(c.t));
  if (fresh.length === 0) return prev;
  return { ...prev, [coin]: [...fresh, ...existing].sort((a, b) => a.t - b.t) };
}

const EMPTY_CANDLES: CandleData[] = [];

export const createActions: StateCreator<StoreState, [], [], Actions & { _toastFn: ToastFn | null }> = (set, get) => ({
  _toastFn: null,

  setToastFn: (fn) => set({ _toastFn: fn }),

  fetchInitialData: async () => {
    const results = await Promise.allSettled([
      api.health(),
      api.config(),
      api.positions(),
      api.orders(),
      api.openOrders(),
      api.equity(),
      api.signals(),
      api.account(),
    ]);
    const [health, config, positions, orders, openOrders, equity, signals, account] = results;

    set({
      health: health.status === "fulfilled" ? health.value : null,
      httpError: health.status === "rejected",
      config: config.status === "fulfilled" ? config.value : null,
      positions: positions.status === "fulfilled" ? positions.value.positions : [],
      orders: orders.status === "fulfilled" ? orders.value.orders : [],
      openOrders: openOrders.status === "fulfilled" ? openOrders.value.orders : [],
      equity: equity.status === "fulfilled" ? equity.value.snapshots : [],
      signals: signals.status === "fulfilled" ? signals.value.signals : [],
      account: account.status === "fulfilled" ? account.value : null,
    });
  },

  refreshAccount: async () => {
    try {
      const account = await api.account();
      set({ account });
    } catch {
      // Silently ignore account refresh failures
    }
  },

  initCoinData: async (config: ConfigResponse) => {
    const coins = config.coins;
    if (!coins?.length) return;
    const { selectedCoin, enabledStrategies } = get();

    // Set selectedCoin if not yet set
    if (!selectedCoin) {
      set({ selectedCoin: coins[0].coin });
    }

    // Initialize enabledStrategies for each coin (all enabled)
    const nextEnabled = { ...enabledStrategies };
    for (const cc of coins) {
      if (!nextEnabled[cc.coin]) {
        nextEnabled[cc.coin] = cc.strategies.map((s) => s.name);
      }
    }
    set({ enabledStrategies: nextEnabled });

    // Sync autoTrading
    const anyEnabled = coins.some((c) => c.strategies.some((s) => s.autoTradingEnabled));
    set({ autoTrading: anyEnabled });

    // Fetch candles + replay signals per coin in parallel
    const fetchPromises: Promise<void>[] = [];
    const oldestByCoins: Record<string, number> = {};

    for (const cc of coins) {
      const coin = cc.coin;
      fetchPromises.push(
        api.candles({ coin }).then((r) => {
          set((s) => ({ coinCandles: { ...s.coinCandles, [coin]: r.candles } }));
          if (r.candles.length > 0) oldestByCoins[coin] = r.candles[0].t;
        }).catch((err) => { console.error(`[initCoinData] candle fetch error for ${coin}:`, err); }),
      );
      for (const strat of cc.strategies) {
        fetchPromises.push(
          api.strategySignals({ coin, strategy: strat.name }).then((r) => {
            if (r.signals.length === 0) return;
            set((s) => ({
              coinReplaySignals: mergeReplaySignals(s.coinReplaySignals, coin, r.signals),
            }));
          }).catch(() => {}),
        );
      }
    }

    await Promise.all(fetchPromises);
    set({ candlesLoading: false });

    // Pre-fetch historical candles + signals in background
    const PREFETCH_BARS = 1500;
    for (const [coin, oldest] of Object.entries(oldestByCoins)) {
      api.candles({ coin, before: oldest, limit: PREFETCH_BARS }).then((hist) => {
        if (hist.candles.length === 0) return;
        set((s) => ({ coinCandles: mergeCandles(s.coinCandles, coin, hist.candles) }));
      }).catch(() => {});
      api.strategySignals({ coin, before: oldest }).then((r) => {
        if (r.signals.length === 0) return;
        set((s) => ({
          coinReplaySignals: mergeReplaySignals(s.coinReplaySignals, coin, r.signals),
        }));
      }).catch(() => {});
    }
  },

  fetchAltCandles: async (coin: string, interval: string | null) => {
    if (!coin || interval === null) {
      set({ altCandles: EMPTY_CANDLES });
      return;
    }
    try {
      const r = await api.candles({ coin, interval, limit: 500 });
      set({ altCandles: r.candles });
    } catch {
      set({ altCandles: EMPTY_CANDLES });
    }
  },

  loadMoreCandles: (before: number) => {
    const coin = get().selectedCoin;
    if (!coin) return;
    api.candles({ coin, before, limit: 500 }).then((r) => {
      if (r.candles.length === 0) return;
      set((s) => ({ coinCandles: mergeCandles(s.coinCandles, coin, r.candles) }));
    }).catch(() => {});
    api.strategySignals({ coin, before }).then((r) => {
      if (r.signals.length === 0) return;
      set((s) => ({
        coinReplaySignals: mergeReplaySignals(s.coinReplaySignals, coin, r.signals),
      }));
    }).catch(() => {});
  },

  closePosition: async (coin: string) => {
    const toast = get()._toastFn;
    try {
      await api.closePosition(coin);
      toast?.(`${coin} position closed`, "success");
    } catch (err) {
      toast?.(`Close ${coin}: ${errorMsg(err)}`, "error");
    }
  },

  cancelOrder: async (_coin: string, oid: number) => {
    const toast = get()._toastFn;
    try {
      await api.cancelOrder(oid);
      toast?.(`Order ${oid} cancelled`, "success");
    } catch (err) {
      toast?.(`Cancel #${oid}: ${errorMsg(err)}`, "error");
    }
  },

  toggleAutoTrading: async () => {
    const { autoTrading, config, _toastFn: toast } = get();
    const coins = config?.coins;
    if (!coins?.length) return;
    const newValue = !autoTrading;
    set({ autoTrading: newValue });
    try {
      await Promise.all(coins.map((c) => api.setAutoTrading(c.coin, newValue)));
      toast?.(`Auto trading ${newValue ? "enabled" : "disabled"}`, "success");
    } catch (err) {
      set({ autoTrading: !newValue });
      toast?.(`Auto trading toggle: ${errorMsg(err)}`, "error");
    }
  },

  selectCoin: (coin: string) => {
    set({ selectedCoin: coin, selectedInterval: null, priceFlash: null });
  },

  setSelectedInterval: (interval: string | null) => set({ selectedInterval: interval }),

  toggleStrategy: (strategy: string) => {
    const { selectedCoin, enabledStrategies } = get();
    if (!selectedCoin) return;
    const current = enabledStrategies[selectedCoin] ?? [];
    if (current.includes(strategy) && current.length <= 1) return;
    const next = current.includes(strategy)
      ? current.filter((s) => s !== strategy)
      : [...current, strategy];
    set({ enabledStrategies: { ...enabledStrategies, [selectedCoin]: next } });
  },

  setShowSignalPopover: (show: boolean) => set({ showSignalPopover: show }),
  setShowSessions: (show: boolean) => set({ showSessions: show }),
  setShowVpvr: (show: boolean) => set({ showVpvr: show }),
  clearPriceFlash: () => set({ priceFlash: null }),
});
