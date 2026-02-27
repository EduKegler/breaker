import type { LivePosition, OpenOrder } from "../lib/api.js";
import { orderTypeLabel } from "./open-orders-table.js";

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return sign + fmt(n);
}

function fmtTrigger(o: OpenOrder): string {
  return o.triggerPx > 0
    ? `$${o.triggerPx.toLocaleString()}`
    : `$${o.limitPx.toLocaleString()}`;
}

export function PositionCard({
  position,
  openOrders,
}: {
  position: LivePosition;
  openOrders: OpenOrder[];
}) {
  const isLong = position.direction === "long";
  const borderColor = isLong ? "border-l-profit" : "border-l-loss";
  const pnlColor = position.unrealizedPnl >= 0 ? "text-profit" : "text-loss";
  const dirColor = isLong
    ? "bg-profit/15 text-profit"
    : "bg-loss/15 text-loss";

  const coinOrders = openOrders.filter(
    (o) => o.coin === position.coin || o.coin === `${position.coin}-PERP`,
  );
  const slOrders = coinOrders.filter((o) => orderTypeLabel(o).label === "SL");
  const tpOrders = coinOrders.filter((o) => orderTypeLabel(o).label === "TP");

  return (
    <div
      className={`bg-terminal-bg border border-terminal-border border-l-4 ${borderColor} rounded-sm p-3`}
    >
      {/* Header: coin + direction + PnL */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold text-txt-primary">
            {position.coin}
          </span>
          <span
            className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-sm ${dirColor}`}
          >
            {position.direction}
          </span>
        </div>
        <span className={`font-mono text-sm font-medium ${pnlColor}`}>
          {fmtPnl(position.unrealizedPnl)}
        </span>
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-txt-secondary">
          Entry{" "}
          <span className="text-txt-primary font-mono">
            {fmt(position.entryPrice)}
          </span>
        </div>
        <div className="text-txt-secondary">
          Current{" "}
          <span className="text-txt-primary font-mono">
            {fmt(position.currentPrice)}
          </span>
        </div>
        <div className="text-txt-secondary">
          Size{" "}
          <span className="text-txt-primary font-mono">{position.size}</span>
        </div>
        <div className="text-txt-secondary">
          SL{" "}
          <span className="text-txt-primary font-mono">
            {fmt(position.stopLoss)}
          </span>
        </div>
      </div>

      {/* TP / SL orders from exchange */}
      {coinOrders.length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-terminal-border/60">
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {/* Stop Loss orders */}
            {slOrders.map((o) => (
              <div
                key={o.oid}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <span className="px-1 py-px font-semibold rounded-sm bg-loss/10 text-loss border border-loss/20 text-[9px] leading-tight">
                  SL
                </span>
                <span className="font-mono text-txt-primary">
                  {fmtTrigger(o)}
                </span>
                <span className="text-txt-secondary font-mono">
                  {o.sz === 0 ? "Full" : o.sz}
                </span>
              </div>
            ))}

            {/* Take Profit orders */}
            {tpOrders.map((o) => (
              <div
                key={o.oid}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <span className="px-1 py-px font-semibold rounded-sm bg-profit/10 text-profit border border-profit/20 text-[9px] leading-tight">
                  TP
                </span>
                <span className="font-mono text-txt-primary">
                  {fmtTrigger(o)}
                </span>
                <span className="text-txt-secondary font-mono">
                  {o.sz === 0 ? "Full" : o.sz}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
