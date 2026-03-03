import { useState } from "react";
import type { PositionSummary, PositionEvent } from "../types/api.js";
import { strategyDisplayName } from "../lib/strategy-abbreviations.js";
import { parseUtc } from "../lib/parse-utc.js";
import { formatDuration } from "../lib/format-duration.js";

const eventColors: Record<string, string> = {
  signal_received: "bg-blue-400",
  entry_placed: "bg-amber",
  entry_filled: "bg-profit",
  sl_placed: "bg-loss",
  tp_placed: "bg-profit",
  trailing_sl_placed: "bg-amber",
  trailing_sl_moved: "bg-blue-400",
  sl_filled: "bg-loss",
  tp_filled: "bg-profit",
  trailing_sl_filled: "bg-amber",
};

function formatDate(dt: string): string {
  return parseUtc(dt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPrice(price: number | null): string {
  if (price == null) return "—";
  return price >= 100 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toFixed(4)}`;
}

function EventTimeline({ events }: { events: PositionEvent[] }) {
  return (
    <div className="py-2 px-4">
      <div className="relative ml-3">
        {events.map((ev, i) => (
          <div key={i} className="flex items-start gap-3 pb-2 last:pb-0">
            {/* Vertical line connector */}
            <div className="relative flex flex-col items-center">
              <div
                className={`w-2 h-2 rounded-full shrink-0 mt-1 ${eventColors[ev.type] ?? "bg-txt-secondary"}`}
              />
              {i < events.length - 1 && (
                <div className="w-px flex-1 bg-terminal-border absolute top-3 bottom-0" style={{ minHeight: 16 }} />
              )}
            </div>
            <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
              <span className="font-mono text-txt-secondary/70 shrink-0">
                {formatDate(ev.timestamp)}
              </span>
              <span className="text-txt-secondary">
                {ev.details}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PositionHistoryTable({ positions }: { positions: PositionSummary[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

  if (positions.length === 0) {
    return (
      <p className="text-txt-secondary text-sm font-mono">No position history</p>
    );
  }

  function toggleExpand(signalId: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(signalId)) {
        next.delete(signalId);
      } else {
        next.add(signalId);
      }
      return next;
    });
  }

  return (
    <div className="overflow-y-auto max-h-[500px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-terminal-surface z-10">
          <tr className="text-left text-txt-secondary uppercase tracking-wider border-b border-terminal-border">
            <th className="pb-2 pr-2 font-medium w-6" />
            <th className="pb-2 pr-3 font-medium">Coin</th>
            <th className="pb-2 pr-3 font-medium">Dir</th>
            <th className="pb-2 pr-3 font-medium">Strategy</th>
            <th className="pb-2 pr-3 font-medium text-right">Size</th>
            <th className="pb-2 pr-3 font-medium text-right">Entry</th>
            <th className="pb-2 pr-3 font-medium text-right">Exit</th>
            <th className="pb-2 pr-3 font-medium text-right">PnL</th>
            <th className="pb-2 pr-3 font-medium text-right">PnL%</th>
            <th className="pb-2 pr-3 font-medium">Duration</th>
            <th className="pb-2 pr-3 font-medium">Opened</th>
            <th className="pb-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => {
            const isExpanded = expandedIds.has(pos.signalId);
            const isOpen = pos.status === "OPEN";
            const isProfit = pos.realizedPnl != null && pos.realizedPnl > 0;
            const isLoss = pos.realizedPnl != null && pos.realizedPnl < 0;

            return (
              <tr key={pos.signalId} className="contents">
                {/* Main row */}
                <td colSpan={12} className="p-0">
                  <div
                    className={`border-b border-terminal-border/50 hover:bg-white/[0.02] cursor-pointer ${
                      isOpen ? "border-l-2 border-l-profit bg-profit/[0.03]" : ""
                    }`}
                    onClick={() => toggleExpand(pos.signalId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpand(pos.signalId); }}
                  >
                    <div className="grid grid-cols-[24px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] items-center py-1.5">
                      {/* Chevron */}
                      <div className="text-txt-secondary/60 text-center">
                        <span className={`inline-block transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                          &#9656;
                        </span>
                      </div>

                      {/* Coin */}
                      <div className="pr-3 font-display font-semibold text-txt-primary">
                        {pos.coin}
                      </div>

                      {/* Direction */}
                      <div className={`pr-3 font-semibold uppercase ${pos.direction === "LONG" ? "text-profit" : "text-loss"}`}>
                        {pos.direction}
                      </div>

                      {/* Strategy */}
                      <div className="pr-3 text-txt-secondary truncate">
                        {pos.strategy ? strategyDisplayName(pos.strategy) : "—"}
                      </div>

                      {/* Size */}
                      <div className="pr-3 font-mono text-txt-primary text-right">
                        {pos.size}
                      </div>

                      {/* Entry */}
                      <div className="pr-3 font-mono text-txt-primary text-right">
                        {formatPrice(pos.entryPrice)}
                      </div>

                      {/* Exit */}
                      <div className="pr-3 font-mono text-txt-primary text-right">
                        {formatPrice(pos.exitPrice)}
                      </div>

                      {/* PnL */}
                      <div className={`pr-3 font-mono text-right font-semibold ${
                        isProfit ? "text-profit" : isLoss ? "text-loss" : "text-txt-secondary"
                      }`}>
                        {pos.realizedPnl != null
                          ? `${pos.realizedPnl >= 0 ? "+" : ""}$${pos.realizedPnl.toFixed(2)}`
                          : "—"
                        }
                      </div>

                      {/* PnL% */}
                      <div className={`pr-3 font-mono text-right ${
                        isProfit ? "text-profit" : isLoss ? "text-loss" : "text-txt-secondary"
                      }`}>
                        {pos.pnlPercent != null
                          ? `${pos.pnlPercent >= 0 ? "+" : ""}${pos.pnlPercent.toFixed(2)}%`
                          : "—"
                        }
                      </div>

                      {/* Duration */}
                      <div className="pr-3 font-mono text-txt-secondary">
                        {formatDuration(pos.durationMs)}
                      </div>

                      {/* Opened */}
                      <div className="pr-3 font-mono text-txt-secondary">
                        {formatDate(pos.openedAt)}
                      </div>

                      {/* Status */}
                      <div>
                        <span className={`inline-flex items-center gap-1.5 ${isOpen ? "text-profit" : "text-txt-secondary"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${isOpen ? "bg-profit animate-pulse-green" : "bg-txt-secondary"}`} />
                          {pos.status}
                        </span>
                      </div>
                    </div>

                    {/* Expanded timeline */}
                    {isExpanded && pos.events.length > 0 && (
                      <div className="border-t border-terminal-border/30 bg-terminal-bg/50">
                        <EventTimeline events={pos.events} />
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
