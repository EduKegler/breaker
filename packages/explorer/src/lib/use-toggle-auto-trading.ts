import { useMutation } from "@tanstack/react-query";
import { api } from "./api.js";
import { useToasts } from "./use-toasts.js";
import { useConfigQuery } from "./use-config-query.js";
import { useStore } from "../store/use-store.js";

function errorMsg(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error ?? e?.message ?? "unknown error";
}

export function useToggleAutoTrading() {
  const { addToast } = useToasts();
  const { data: config } = useConfigQuery();
  return useMutation({
    mutationFn: async () => {
      const autoTrading = useStore.getState().autoTrading;
      const coins = config?.coins;
      if (!coins?.length) return;
      const newValue = !autoTrading;
      useStore.setState({ autoTrading: newValue });
      try {
        await Promise.all(coins.map((c) => api.setAutoTrading(c.coin, newValue)));
        return newValue;
      } catch (err) {
        useStore.setState({ autoTrading: !newValue });
        throw err;
      }
    },
    onSuccess: (newValue) => {
      if (newValue !== undefined) {
        addToast(`Auto trading ${newValue ? "enabled" : "disabled"}`, "success");
      }
    },
    onError: (err) => addToast(`Auto trading toggle: ${errorMsg(err)}`, "error"),
  });
}
