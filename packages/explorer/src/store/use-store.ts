import { create } from "zustand";
import type { StoreState } from "./types.js";
import { createServerSlice } from "./server-slice.js";
import { createMarketDataSlice } from "./market-data-slice.js";
import { createUiSlice } from "./ui-slice.js";
import { createActions } from "./actions.js";

export const useStore = create<StoreState>()((...a) => ({
  ...createServerSlice(...a),
  ...createMarketDataSlice(...a),
  ...createUiSlice(...a),
  ...createActions(...a),
}));
