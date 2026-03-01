import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/api.js";
import type { CoinConfig } from "../types/api.js";
import { strategyDisplayName } from "../lib/strategy-abbreviations.js";

interface SignalPopoverProps {
  coins: CoinConfig[];
  onClose: () => void;
  onSuccess: () => void;
}

function strategiesForCoin(coins: CoinConfig[], coinName: string): string[] {
  const cfg = coins.find((c) => c.coin === coinName);
  return cfg ? cfg.strategies.map((s) => s.name) : [];
}

export function SignalPopover({ coins, onClose, onSuccess }: SignalPopoverProps) {
  const [coin, setCoin] = useState(coins[0]?.coin ?? "");
  const coinStrategies = strategiesForCoin(coins, coin);
  const [strategy, setStrategy] = useState(coinStrategies[0] ?? "");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync strategy when coin changes
  useEffect(() => {
    if (coinStrategies.length > 0 && !coinStrategies.includes(strategy)) {
      setStrategy(coinStrategies[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to coin/coins changes, not strategy
  }, [coin, coins]);

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
      className="absolute top-full right-0 mt-2 z-50 w-72 animate-popover-in"
      style={{
        background: "linear-gradient(180deg, #14141e 0%, #0e0e16 100%)",
        border: "1px solid rgba(255, 170, 0, 0.12)",
        borderRadius: "6px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 0 1px rgba(255,170,0,0.15)",
      }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-txt-secondary">
          Quick Signal
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-txt-secondary hover:text-txt-primary transition-colors text-xs leading-none cursor-pointer"
        >
          &times;
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* Coin selector — pill toggle */}
        <div className="flex gap-1.5">
          {coins.map((c) => (
            <button
              key={c.coin}
              type="button"
              className="relative px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] rounded transition-all cursor-pointer"
              style={{
                background: coin === c.coin ? "rgba(255, 170, 0, 0.12)" : "rgba(255,255,255,0.03)",
                color: coin === c.coin ? "#ffaa00" : "#6b6b80",
                border: coin === c.coin ? "1px solid rgba(255,170,0,0.3)" : "1px solid rgba(255,255,255,0.05)",
              }}
              onClick={() => setCoin(c.coin)}
            >
              {c.coin}
            </button>
          ))}
        </div>

        {/* Strategy selector — custom button group instead of native select */}
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-txt-secondary/60 pl-0.5">
            Strategy
          </span>
          <div className="flex gap-1 flex-wrap">
            {coinStrategies.map((s) => (
              <button
                key={s}
                type="button"
                className="px-2.5 py-1 text-[10px] font-mono rounded transition-all cursor-pointer"
                style={{
                  background: strategy === s ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)",
                  color: strategy === s ? "#e0e0e8" : "#6b6b80",
                  border: strategy === s ? "1px solid rgba(255,255,255,0.15)" : "1px solid rgba(255,255,255,0.04)",
                }}
                onClick={() => setStrategy(s)}
              >
                {strategyDisplayName(s)}
              </button>
            ))}
          </div>
        </div>

        {/* Direction toggle */}
        <div className="flex gap-1.5">
          <button
            type="button"
            className="flex-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] rounded transition-all cursor-pointer"
            style={{
              background: isLong ? "rgba(0, 255, 136, 0.1)" : "rgba(255,255,255,0.02)",
              color: isLong ? "#00ff88" : "#6b6b80",
              border: isLong ? "1px solid rgba(0,255,136,0.25)" : "1px solid rgba(255,255,255,0.04)",
              boxShadow: isLong ? "0 0 12px rgba(0,255,136,0.06)" : "none",
            }}
            onClick={() => setDirection("long")}
          >
            Long
          </button>
          <button
            type="button"
            className="flex-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] rounded transition-all cursor-pointer"
            style={{
              background: !isLong ? "rgba(255, 51, 102, 0.1)" : "rgba(255,255,255,0.02)",
              color: !isLong ? "#ff3366" : "#6b6b80",
              border: !isLong ? "1px solid rgba(255,51,102,0.25)" : "1px solid rgba(255,255,255,0.04)",
              boxShadow: !isLong ? "0 0 12px rgba(255,51,102,0.06)" : "none",
            }}
            onClick={() => setDirection("short")}
          >
            Short
          </button>
        </div>

        {/* Info line */}
        <div
          className="text-[9px] font-mono tracking-[0.1em] uppercase px-2 py-1.5 rounded"
          style={{
            background: "rgba(255,255,255,0.02)",
            color: "#6b6b80",
            border: "1px solid rgba(255,255,255,0.03)",
          }}
        >
          Entry market &middot; SL via ATR &middot; <span className="text-txt-primary/70">{strategyDisplayName(strategy)}</span>
        </div>

        {/* Send button */}
        <button
          type="button"
          disabled={sending}
          onClick={handleSend}
          className={`w-full py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${isLong ? "bg-profit/15 text-profit hover:bg-profit/25" : "bg-loss/15 text-loss hover:bg-loss/25"}`}
          style={{
            border: `1px solid ${isLong ? "rgba(0,255,136,0.3)" : "rgba(255,51,102,0.3)"}`,
            boxShadow: `0 0 20px ${isLong ? "rgba(0,255,136,0.08)" : "rgba(255,51,102,0.08)"}`,
          }}
        >
          {sending ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              Sending...
            </span>
          ) : (
            `${direction} ${coin}`
          )}
        </button>

        {/* Feedback */}
        {feedback && (
          <div
            className="text-[10px] font-mono px-2.5 py-2 rounded animate-popover-in"
            style={{
              background: feedback.ok ? "rgba(0,255,136,0.06)" : "rgba(255,51,102,0.06)",
              color: feedback.ok ? "#00ff88" : "#ff3366",
              border: `1px solid ${feedback.ok ? "rgba(0,255,136,0.15)" : "rgba(255,51,102,0.15)"}`,
            }}
          >
            {feedback.msg}
          </div>
        )}
      </div>
    </div>
  );
}
