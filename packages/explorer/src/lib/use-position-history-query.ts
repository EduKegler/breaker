import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { queryKeys } from "./query-keys.js";

export function usePositionHistoryQuery() {
  return useQuery({
    queryKey: queryKeys.positionHistory(),
    queryFn: () => api.positionHistory().then((r) => r.positions),
    staleTime: 60_000,
  });
}
