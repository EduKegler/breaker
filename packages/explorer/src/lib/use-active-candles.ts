import { useStore } from "../store/use-store.js";
import { selectStreamingCandles, EMPTY_CANDLES } from "../store/selectors.js";
import { useAltCandlesQuery } from "./use-alt-candles-query.js";

export function useActiveCandles() {
  const coin = useStore((s) => s.selectedCoin);
  const interval = useStore((s) => s.selectedInterval);
  const streaming = useStore(selectStreamingCandles);
  const { data: alt } = useAltCandlesQuery(coin, interval);
  return interval === null ? streaming : (alt ?? EMPTY_CANDLES);
}
