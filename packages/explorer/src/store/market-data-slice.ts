import type { StateCreator } from "zustand";
import type { StoreState, MarketDataSlice } from "./types.js";

export const createMarketDataSlice: StateCreator<StoreState, [], [], MarketDataSlice> = () => ({
  coinCandles: {},
  coinReplaySignals: {},
  coinPrices: {},
  candlesLoading: true,
  loadingStrategies: new Set(),
});
