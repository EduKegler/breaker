import type { StateCreator } from "zustand";
import type { StoreState, ServerSlice } from "./types.js";

export const createServerSlice: StateCreator<StoreState, [], [], ServerSlice> = () => ({
  positions: [],
  orders: [],
  openOrders: [],
  equity: [],
  signals: [],
  pendingEntries: [],
});
