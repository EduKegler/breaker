import { INTERVAL_MS } from "../lib/interval-ms.js";

const TIMEFRAME_OPTIONS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;

interface TimeframeSwitcherProps {
  streamingInterval: string;
  selectedInterval: string | null;
  onSelect: (interval: string | null) => void;
}

export function TimeframeSwitcher({ streamingInterval, selectedInterval, onSelect }: TimeframeSwitcherProps) {
  const streamingMs = INTERVAL_MS[streamingInterval] ?? 0;
  const activeInterval = selectedInterval ?? streamingInterval;

  return (
    <div className="flex gap-1">
      {TIMEFRAME_OPTIONS.filter((tf) => (INTERVAL_MS[tf] ?? 0) >= streamingMs).map((tf) => {
        const isActive = tf === activeInterval;
        const isStreaming = tf === streamingInterval;
        return (
          <button
            key={tf}
            type="button"
            className={`relative px-2 py-0.5 text-[10px] font-mono font-medium uppercase rounded transition-all cursor-pointer ${
              isActive
                ? "bg-amber/12 text-amber border border-amber/30"
                : "bg-transparent text-txt-secondary/50 border border-transparent hover:text-txt-secondary/80"
            }`}
            onClick={() => onSelect(tf === streamingInterval ? null : tf)}
          >
            {tf}
            {isStreaming && isActive && (
              <span className="ml-1 text-[8px] text-profit font-bold">LIVE</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
