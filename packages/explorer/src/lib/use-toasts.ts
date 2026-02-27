import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { createElement } from "react";

export type ToastVariant = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  removeToast: (id: number) => void;
}

const defaultDurations: Record<ToastVariant, number> = {
  success: 3000,
  error: 5000,
  info: 4000,
};

const MAX_TOASTS = 5;

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, variant: ToastVariant = "info", duration?: number) => {
      const d = duration ?? defaultDurations[variant];
      const id = nextId++;
      setToasts((prev) => {
        const next = [...prev, { id, message, variant, duration: d }];
        // FIFO: keep only the latest MAX_TOASTS
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      setTimeout(() => removeToast(id), d);
    },
    [removeToast],
  );

  return createElement(
    ToastContext.Provider,
    { value: { toasts, addToast, removeToast } },
    children,
  );
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within a ToastProvider");
  return ctx;
}
