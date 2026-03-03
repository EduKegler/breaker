import type { StateCreator } from "zustand";
import type { StoreState, ServerSlice } from "./types.js";

export const createServerSlice: StateCreator<StoreState, [], [], ServerSlice> = () => ({
  health: null,
  config: null,
  positions: [],
  orders: [],
  openOrders: [],
  equity: [],
  signals: [],
  positionHistory: [],
  account: null,
  httpError: false,
});
