import { useMutation } from "@tanstack/react-query";
import { api } from "./api.js";
import { useToasts } from "./use-toasts.js";

function errorMsg(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error ?? e?.message ?? "unknown error";
}

export function useClosePosition() {
  const { addToast } = useToasts();
  return useMutation({
    mutationFn: (coin: string) => api.closePosition(coin),
    onSuccess: (_, coin) => addToast(`${coin} position closed`, "success"),
    onError: (err, coin) => addToast(`Close ${coin}: ${errorMsg(err)}`, "error"),
  });
}
