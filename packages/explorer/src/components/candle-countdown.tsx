import { useState, useEffect } from "react";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

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
