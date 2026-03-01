import { useState, useEffect } from "react";
import { INTERVAL_MS } from "../lib/interval-ms.js";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface CandleCountdownProps {
  interval: string;
}

export function CandleCountdown({ interval }: CandleCountdownProps) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const ms = INTERVAL_MS[interval];
    if (!ms) return;

    function tick() {
      const now = Date.now();
      const nextClose = Math.ceil(now / ms) * ms;
      setRemaining(nextClose - now);
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [interval]);

  if (remaining == null) return null;

  const ms = INTERVAL_MS[interval];
  const pct = ms ? (remaining / ms) * 100 : 0;
  const isLow = pct < 15;

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary/60">
        {interval}
      </span>
      <span
        className={`font-mono text-sm tabular-nums ${isLow ? "text-amber" : "text-txt-secondary"}`}
      >
        {formatCountdown(remaining)}
      </span>
    </span>
  );
}
