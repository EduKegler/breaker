import type { StateCreator } from "zustand";
import type { StoreState, UiSlice } from "./types.js";

export const createUiSlice: StateCreator<StoreState, [], [], UiSlice> = () => ({
  selectedCoin: "",
  selectedInterval: null,
  enabledStrategies: {},
  showSignalPopover: false,
  showSessions: false,
  showVpvr: false,
  priceFlash: null,
  wsStatus: "connecting",
  autoTrading: false,
});
