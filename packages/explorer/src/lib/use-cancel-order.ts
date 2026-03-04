import { useMutation } from "@tanstack/react-query";
import { api } from "./api.js";
import { useToasts } from "./use-toasts.js";

function errorMsg(err: unknown): string {
  const e = err as { data?: { error?: string }; message?: string };
  return e?.data?.error ?? e?.message ?? "unknown error";
}

export function useCancelOrder() {
  const { addToast } = useToasts();
  return useMutation({
    mutationFn: (oid: number) => api.cancelOrder(oid),
    onSuccess: (_, oid) => addToast(`Order ${oid} cancelled`, "success"),
    onError: (err, oid) => addToast(`Cancel #${oid}: ${errorMsg(err)}`, "error"),
  });
}
