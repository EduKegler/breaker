import { useState, useEffect } from "react";
import { useToasts, type Toast } from "../lib/use-toasts.js";

const variantBorder: Record<Toast["variant"], string> = {
  success: "border-l-profit",
  error: "border-l-loss",
  info: "border-l-amber",
};

const variantBadge: Record<Toast["variant"], { text: string; cls: string }> = {
  success: { text: "SUCCESS", cls: "bg-profit/15 text-profit" },
  error: { text: "ERROR", cls: "bg-loss/15 text-loss" },
  info: { text: "INFO", cls: "bg-amber/15 text-amber" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    // Start exit animation before removal
    const exitTimer = setTimeout(() => setExiting(true), toast.duration - 200);
    return () => clearTimeout(exitTimer);
  }, [toast.duration]);

  const badge = variantBadge[toast.variant];

  return (
    <div
      onClick={onDismiss}
      className={`pointer-events-auto cursor-pointer flex items-center gap-2 px-3 py-2 border-l-3 ${variantBorder[toast.variant]} bg-terminal-surface border border-terminal-border rounded-sm shadow-lg ${exiting ? "animate-toast-out" : "animate-toast-in"}`}
    >
      <span className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm ${badge.cls}`}>
        {badge.text}
      </span>
      <span className="font-mono text-xs text-txt-primary">{toast.message}</span>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToasts();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}
