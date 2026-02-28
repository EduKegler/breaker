import { useContext } from "react";
import { ToastContext } from "./toast-provider.js";
import type { ToastContextValue } from "./toast-provider.js";

export type { Toast, ToastVariant, ToastContextValue } from "./toast-provider.js";

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within a ToastProvider");
  return ctx;
}
