import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { queryKeys } from "./query-keys.js";

export function useHealthQuery() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: api.health,
    staleTime: Infinity,
  });
}
