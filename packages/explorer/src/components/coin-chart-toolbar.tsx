import { strategyDisplayName, strategyTooltip } from "../lib/strategy-abbreviations.js";

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
              const tip = strategyTooltip(s);
              return (
                <div key={s} className="relative group">
                  <button
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
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
                    <div className="bg-[#141420] border border-terminal-border rounded px-3 py-2 shadow-lg w-max max-w-[280px]">
                      <div className="text-[10px] font-bold text-amber tracking-wider uppercase mb-1">
                        {tip.title}
                      </div>
                      {tip.lines.map((line, i) => (
                        <div
                          key={i}
                          className={`text-[10px] font-mono leading-relaxed ${line.startsWith("  ") ? "text-txt-secondary/60 pl-2" : "text-txt-secondary"}`}
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                    {/* Arrow */}
                    <div className="flex justify-center">
                      <div className="w-2 h-2 bg-[#141420] border-r border-b border-terminal-border rotate-45 -mt-[5px]" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
