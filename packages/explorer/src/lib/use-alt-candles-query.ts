import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { queryKeys } from "./query-keys.js";
import type { CandleData } from "../types/api.js";

const EMPTY: CandleData[] = [];

export function useAltCandlesQuery(coin: string, interval: string | null) {
  return useQuery({
    queryKey: queryKeys.altCandles(coin, interval ?? ""),
    queryFn: () =>
      api.candles({ coin, interval: interval!, limit: 500 }).then((r) => r.candles),
    enabled: !!coin && interval !== null,
    placeholderData: EMPTY,
  });
}
