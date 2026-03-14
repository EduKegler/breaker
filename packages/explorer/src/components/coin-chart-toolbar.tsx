import { moduleTypeLabel } from "../lib/strategy-abbreviations.js";
import { getStrategyMeta } from "../lib/strategy-metadata.js";
import { humanizeStrategyName } from "../lib/strategy-abbreviations.js";
import type { CoinStrategyConfig } from "../types/api.js";

interface CoinChartToolbarProps {
  coins: string[];
  selectedCoin: string;
  onSelectCoin: (coin: string) => void;
  strategies: string[];
  strategyConfigs: CoinStrategyConfig[];
  enabledStrategies: string[];
  onToggleStrategy: (strategy: string) => void;
  pendingCoins?: Set<string>;
  loadingStrategies?: Set<string>;
}

export function CoinChartToolbar({
  coins,
  selectedCoin,
  onSelectCoin,
  strategies,
  strategyConfigs,
  enabledStrategies,
  onToggleStrategy,
  pendingCoins,
  loadingStrategies,
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
              background:
                selectedCoin === coin
                  ? "rgba(255, 170, 0, 0.12)"
                  : "rgba(255,255,255,0.03)",
              color: selectedCoin === coin ? "#ffaa00" : "#6b6b80",
              border:
                selectedCoin === coin
                  ? "1px solid rgba(255,170,0,0.3)"
                  : "1px solid rgba(255,255,255,0.05)",
            }}
            onClick={() => onSelectCoin(coin)}
          >
            {coin}
            {pendingCoins?.has(coin) && (
              <span className="ml-1 px-1 py-px text-[8px] rounded bg-amber/20 text-amber border border-amber/30 leading-tight">
                GTC
              </span>
            )}
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
              const cfg = strategyConfigs.find((c) => c.name === s);
              const label = moduleTypeLabel(cfg?.moduleType);
              const meta = getStrategyMeta(s);
              const isLoading = loadingStrategies?.has(`${selectedCoin}:${s}`);
              return (
                <div key={s} className="relative group">
                  <button
                    type="button"
                    className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all ${canToggle ? "cursor-pointer" : "cursor-default"}`}
                    style={{
                      background: isEnabled
                        ? "rgba(255,255,255,0.06)"
                        : "rgba(255,255,255,0.01)",
                      color: isEnabled ? "#e0e0e8" : "#4a4a5a",
                      border: isEnabled
                        ? "1px solid rgba(255,255,255,0.12)"
                        : "1px solid rgba(255,255,255,0.04)",
                      textDecoration: isEnabled ? "none" : "line-through",
                    }}
                    onClick={canToggle ? () => onToggleStrategy(s) : undefined}
                  >
                    {isLoading && (
                      <span className="inline-block w-2.5 h-2.5 mr-1 rounded-full border border-txt-secondary/40 border-t-amber animate-spin align-[-2px]" />
                    )}
                    {label}
                  </button>
                  {/* ── Strategy Tooltip ────────────────── */}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
                    {/* Arrow (top) */}
                    <div className="flex justify-center">
                      <div
                        className="w-2 h-2 rotate-45 -mb-[5px] border-l border-t"
                        style={{
                          background: "#111120",
                          borderColor: "rgba(255,170,0,0.15)",
                        }}
                      />
                    </div>
                    <div
                      className="rounded border shadow-2xl"
                      style={{
                        background: "linear-gradient(180deg, #111120 0%, #0c0c18 100%)",
                        borderColor: "rgba(255,170,0,0.15)",
                        width: 360,
                        boxShadow: "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.03)",
                      }}
                    >
                      {/* Header — strategy file name + module type badge */}
                      <div
                        className="px-3 py-2 border-b flex items-center gap-2"
                        style={{ borderColor: "rgba(255,255,255,0.06)" }}
                      >
                        <span className="text-[11px] font-mono font-medium text-txt-primary">
                          {s}
                        </span>
                        <span
                          className="text-[9px] font-bold tracking-[0.1em] uppercase px-1.5 py-px rounded"
                          style={{ color: "#ffaa00", background: "rgba(255,170,0,0.1)", border: "1px solid rgba(255,170,0,0.2)" }}
                        >
                          {label}
                        </span>
                      </div>

                      {/* Components */}
                      <div className="px-3 py-2">
                        {meta ? meta.components.map((comp, i) => (
                          <div key={i} className={i > 0 ? "mt-2 pt-2 border-t border-white/[0.04]" : ""}>
                            <div className="flex items-baseline gap-2">
                              <span
                                className="text-[10px] font-mono uppercase tracking-wider shrink-0"
                                style={{ color: "#6b6b80", width: 68 }}
                              >
                                {comp.label}
                              </span>
                              <span className="text-[11px] font-mono font-medium text-txt-primary leading-tight">
                                {comp.value}
                              </span>
                            </div>
                            {comp.detail && (
                              <div
                                className="text-[10px] font-mono leading-snug mt-0.5"
                                style={{ color: "#555568", paddingLeft: 76 }}
                              >
                                {comp.detail}
                              </div>
                            )}
                          </div>
                        )) : (
                          <div className="text-[11px] font-mono text-txt-secondary">
                            {humanizeStrategyName(s)}
                          </div>
                        )}
                      </div>
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
