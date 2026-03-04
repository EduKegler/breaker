import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { queryKeys } from "./query-keys.js";

export function useConfigQuery() {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: api.config,
    staleTime: Infinity,
  });
}
