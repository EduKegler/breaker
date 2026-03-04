import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { queryKeys } from "./query-keys.js";

export function useAccountQuery() {
  return useQuery({
    queryKey: queryKeys.account(),
    queryFn: api.account,
    refetchInterval: 30_000,
  });
}
