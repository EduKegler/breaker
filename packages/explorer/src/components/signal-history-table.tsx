import type { SignalRow } from "../types/api.js";
import { strategyDisplayName } from "../lib/strategy-abbreviations.js";
import { formatDate, formatPrice } from "../lib/format-table.js";

type Outcome = "executed" | "rejected" | "no_fill" | "error" | "blocked" | "resting";

const outcomeConfig: Record<Outcome, { label: string; bg: string; text: string }> = {
  executed: { label: "Executed", bg: "bg-profit/15", text: "text-profit" },
  rejected: { label: "Rejected", bg: "bg-loss/15", text: "text-loss" },
  error: { label: "Error", bg: "bg-loss/15", text: "text-loss" },
  no_fill: { label: "No Fill", bg: "bg-amber/15", text: "text-amber" },
  blocked: { label: "Blocked", bg: "bg-terminal-border", text: "text-txt-secondary" },
  resting: { label: "Resting", bg: "bg-blue-500/15", text: "text-blue-400" },
};

function resolveOutcome(signal: SignalRow): Outcome {
  if (signal.outcome) return signal.outcome as Outcome;
  // Fallback for signals without outcome column (pre-migration)
  if (signal.risk_check_passed === 0) return "rejected";
  return "executed";
}

function resolveReason(signal: SignalRow): string | null {
  if (signal.outcome_reason) return signal.outcome_reason;
  if (signal.risk_check_reason) return signal.risk_check_reason;
  return null;
}

const sourceLabel: Record<string, string> = {
  "strategy-runner": "Auto",
  api: "Manual",
  router: "Webhook",
};

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const cfg = outcomeConfig[outcome] ?? outcomeConfig.rejected;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${cfg.bg} ${cfg.text}`}
    >
      <span
        className={`w-1 h-1 rounded-full ${
          outcome === "executed"
            ? "bg-profit"
            : outcome === "resting"
              ? "bg-blue-400 animate-pulse"
              : outcome === "no_fill"
                ? "bg-amber"
                : outcome === "blocked"
                  ? "bg-txt-secondary"
                  : "bg-loss"
        }`}
      />
      {cfg.label}
    </span>
  );
}

export function SignalHistoryTable({ signals }: { signals: SignalRow[] }) {
  if (signals.length === 0) {
    return (
      <p className="text-txt-secondary text-sm font-mono">No signal history</p>
    );
  }

  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[500px]">
      <table className="w-full text-xs min-w-[780px]">
        <thead className="sticky top-0 bg-terminal-surface z-10">
          <tr className="text-left text-txt-secondary uppercase tracking-wider border-b border-terminal-border">
            <th className="pb-2 pr-3 font-medium">Time</th>
            <th className="pb-2 pr-3 font-medium">Coin</th>
            <th className="pb-2 pr-3 font-medium">Dir</th>
            <th className="pb-2 pr-3 font-medium">Strategy</th>
            <th className="pb-2 pr-3 font-medium">Source</th>
            <th className="pb-2 pr-3 font-medium text-right">Entry</th>
            <th className="pb-2 pr-3 font-medium text-right">SL</th>
            <th className="pb-2 pr-3 font-medium">Outcome</th>
            <th className="pb-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((sig) => {
            const outcome = resolveOutcome(sig);
            const reason = resolveReason(sig);
            const isExecuted = outcome === "executed";

            return (
              <tr
                key={sig.id}
                className={`border-b border-terminal-border/50 hover:bg-white/[0.02] ${
                  isExecuted ? "border-l-2 border-l-profit/40" : ""
                }`}
              >
                <td className="py-1.5 pr-3 font-mono text-txt-secondary">
                  {formatDate(sig.created_at)}
                </td>
                <td className="py-1.5 pr-3 font-display font-semibold text-txt-primary">
                  {sig.asset}
                </td>
                <td
                  className={`py-1.5 pr-3 font-semibold uppercase ${
                    sig.side === "LONG" ? "text-profit" : "text-loss"
                  }`}
                >
                  {sig.side}
                </td>
                <td className="py-1.5 pr-3 text-txt-secondary truncate max-w-[160px]">
                  {sig.strategy_name
                    ? strategyDisplayName(sig.strategy_name)
                    : "\u2014"}
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-sm ${
                      sig.source === "strategy-runner"
                        ? "bg-blue-500/10 text-blue-400"
                        : sig.source === "api"
                          ? "bg-amber/10 text-amber"
                          : "bg-terminal-border text-txt-secondary"
                    }`}
                  >
                    {sourceLabel[sig.source] ?? sig.source}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                  {formatPrice(sig.entry_price)}
                </td>
                <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                  {formatPrice(sig.stop_loss)}
                </td>
                <td className="py-1.5 pr-3">
                  <OutcomeBadge outcome={outcome} />
                </td>
                <td className="py-1.5 text-txt-secondary/70 text-[11px] truncate max-w-[260px]" title={reason ?? undefined}>
                  {reason ?? (isExecuted ? "Position opened" : "\u2014")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
