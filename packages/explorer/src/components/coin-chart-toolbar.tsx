import { strategyDisplayName } from "../lib/strategy-abbreviations.js";

interface CoinChartToolbarProps {
  coins: string[];
  selectedCoin: string;
  onSelectCoin: (coin: string) => void;
  strategies: string[];
  enabledStrategies: string[];
  onToggleStrategy: (strategy: string) => void;
}

export function CoinChartToolbar({
  coins,
  selectedCoin,
  onSelectCoin,
  strategies,
  enabledStrategies,
  onToggleStrategy,
}: CoinChartToolbarProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Coin pills */}
      <div className="flex gap-1.5">
        {coins.map((coin) => (
          <button
            key={coin}
            type="button"
            className="relative px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] rounded transition-all cursor-pointer"
            style={{
              background: selectedCoin === coin ? "rgba(255, 170, 0, 0.12)" : "rgba(255,255,255,0.03)",
              color: selectedCoin === coin ? "#ffaa00" : "#6b6b80",
              border: selectedCoin === coin ? "1px solid rgba(255,170,0,0.3)" : "1px solid rgba(255,255,255,0.05)",
            }}
            onClick={() => onSelectCoin(coin)}
          >
            {coin}
          </button>
        ))}
      </div>

      {/* Strategy chips — always visible, toggleable when 2+ */}
      {strategies.length >= 1 && (
        <>
          <div className="w-px h-4 bg-terminal-border" />
          <div className="flex gap-1">
            {strategies.map((s) => {
              const isEnabled = enabledStrategies.includes(s);
              const canToggle = strategies.length >= 2;
              return (
                <button
                  key={s}
                  type="button"
                  className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all ${canToggle ? "cursor-pointer" : "cursor-default"}`}
                  style={{
                    background: isEnabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.01)",
                    color: isEnabled ? "#e0e0e8" : "#4a4a5a",
                    border: isEnabled ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(255,255,255,0.04)",
                    textDecoration: isEnabled ? "none" : "line-through",
                  }}
                  onClick={canToggle ? () => onToggleStrategy(s) : undefined}
                >
                  {strategyDisplayName(s)}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
