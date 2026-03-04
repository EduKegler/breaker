import { useMutation } from "@tanstack/react-query";
import { api } from "./api.js";

interface QuickSignalParams {
  coin: string;
  direction: "long" | "short";
  strategy?: string;
}

export function useSendQuickSignal() {
  return useMutation({
    mutationFn: (params: QuickSignalParams) => api.sendQuickSignal(params),
  });
}
