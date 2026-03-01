import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/api.js";
import type { CoinConfig } from "../types/api.js";

interface SignalPopoverProps {
  coins: CoinConfig[];
  availableStrategies: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function SignalPopover({ coins, availableStrategies, onClose, onSuccess }: SignalPopoverProps) {
  const [coin, setCoin] = useState(coins[0]?.coin ?? "");
  const [strategy, setStrategy] = useState(availableStrategies[0] ?? "");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // No need to sync strategy on coin change — all strategies are always available

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const handleSend = useCallback(async () => {
    setSending(true);
    setFeedback(null);

    try {
      const res = await api.sendQuickSignal({ coin, direction, strategy });
      if (res.status === "executed") {
        const sl = res.stopLoss ? ` · SL ${res.stopLoss}` : "";
        setFeedback({ ok: true, msg: `Executed #${res.signalId}${sl}` });
        setTimeout(onSuccess, 800);
      } else {
        setFeedback({ ok: false, msg: res.reason ?? res.error ?? "Rejected" });
      }
    } catch (err) {
      const msg = (err as { data?: { reason?: string; error?: string } }).data?.reason
        ?? (err as { data?: { error?: string } }).data?.error
        ?? (err as Error).message;
      setFeedback({ ok: false, msg });
    } finally {
      setSending(false);
    }
  }, [coin, direction, strategy, onSuccess]);

  const isLong = direction === "long";

  return (
    <div
      ref={popoverRef}
      className="absolute top-full right-0 mt-2 z-50 bg-terminal-surface border border-terminal-border rounded-sm shadow-lg w-64"
    >
      <div className="p-3 space-y-3">
        {/* Coin selector */}
        <div className="flex gap-1 flex-wrap">
          {coins.map((c) => (
            <button
              key={c.coin}
              type="button"
              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors ${
                coin === c.coin
                  ? "bg-amber/20 text-amber border border-amber/40"
                  : "bg-terminal-bg text-txt-secondary border border-terminal-border hover:text-txt-primary"
              }`}
              onClick={() => setCoin(c.coin)}
            >
              {c.coin}
            </button>
          ))}
        </div>

        {/* Strategy selector */}
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className="w-full bg-terminal-bg text-txt-primary text-xs border border-terminal-border rounded-sm px-2 py-1.5 font-mono focus:outline-none focus:border-amber/50"
        >
          {availableStrategies.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {/* Direction toggle */}
        <div className="flex gap-1">
          <button
            type="button"
            className={`flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-sm transition-colors ${
              isLong
                ? "bg-profit/20 text-profit border border-profit/40"
                : "bg-terminal-bg text-txt-secondary border border-terminal-border hover:text-txt-primary"
            }`}
            onClick={() => setDirection("long")}
          >
            Long
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-sm transition-colors ${
              !isLong
                ? "bg-loss/20 text-loss border border-loss/40"
                : "bg-terminal-bg text-txt-secondary border border-terminal-border hover:text-txt-primary"
            }`}
            onClick={() => setDirection("short")}
          >
            Short
          </button>
        </div>

        {/* Info: entry + SL computed by strategy */}
        <div className="text-[10px] text-txt-secondary tracking-wider uppercase">
          Entry market · SL via ATR ({strategy})
        </div>

        {/* Send button */}
        <button
          type="button"
          disabled={sending}
          onClick={handleSend}
          className={`w-full py-2 text-xs font-bold uppercase tracking-wider rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            isLong
              ? "bg-profit/20 text-profit border border-profit/40 hover:bg-profit/30"
              : "bg-loss/20 text-loss border border-loss/40 hover:bg-loss/30"
          }`}
        >
          {sending ? "Sending..." : `Send ${direction} ${coin}`}
        </button>

        {/* Feedback */}
        {feedback && (
          <div
            className={`text-xs font-mono px-2 py-1.5 rounded-sm ${
              feedback.ok
                ? "bg-profit/10 text-profit border border-profit/20"
                : "bg-loss/10 text-loss border border-loss/20"
            }`}
          >
            {feedback.msg}
          </div>
        )}
      </div>
    </div>
  );
}
