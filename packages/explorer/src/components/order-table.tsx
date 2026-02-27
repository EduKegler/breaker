import type { OrderRow } from "../lib/api.js";

const statusDot: Record<string, string> = {
  filled: "bg-profit",
  pending: "bg-amber",
  cancelled: "bg-txt-secondary",
  rejected: "bg-loss",
};

const statusText: Record<string, string> = {
  filled: "text-profit",
  pending: "text-amber",
  cancelled: "text-txt-secondary",
  rejected: "text-loss",
};

export function OrderTable({ orders }: { orders: OrderRow[] }) {
  if (orders.length === 0) {
    return (
      <p className="text-txt-secondary text-sm font-mono">No orders yet</p>
    );
  }

  return (
    <div className="overflow-y-auto max-h-[400px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-terminal-surface">
          <tr className="text-left text-txt-secondary uppercase tracking-wider border-b border-terminal-border">
            <th className="pb-2 pr-3 font-medium">Time</th>
            <th className="pb-2 pr-3 font-medium">Coin</th>
            <th className="pb-2 pr-3 font-medium">Side</th>
            <th className="pb-2 pr-3 font-medium">Type</th>
            <th className="pb-2 pr-3 font-medium">Tag</th>
            <th className="pb-2 pr-3 font-medium text-right">Size</th>
            <th className="pb-2 pr-3 font-medium text-right">Price</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2 font-medium">Mode</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr
              key={o.id}
              className={`border-b border-terminal-border/50 hover:bg-white/[0.02] ${
                i % 2 === 0 ? "" : "bg-white/[0.01]"
              }`}
            >
              <td className="py-1.5 pr-3 font-mono text-txt-secondary">
                {o.created_at
                  ? new Date(o.created_at).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </td>
              <td className="py-1.5 pr-3 font-display font-semibold text-txt-primary">
                {o.coin}
              </td>
              <td
                className={`py-1.5 pr-3 font-semibold uppercase ${
                  o.side === "buy" ? "text-profit" : "text-loss"
                }`}
              >
                {o.side}
              </td>
              <td className="py-1.5 pr-3 text-txt-secondary">{o.order_type}</td>
              <td className="py-1.5 pr-3 text-txt-secondary">{o.tag}</td>
              <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                {o.size}
              </td>
              <td className="py-1.5 pr-3 font-mono text-txt-primary text-right">
                {o.price ? `$${o.price.toLocaleString()}` : "mkt"}
              </td>
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${statusDot[o.status] ?? "bg-txt-secondary"}`}
                  />
                  <span
                    className={statusText[o.status] ?? "text-txt-secondary"}
                  >
                    {o.status}
                  </span>
                </span>
              </td>
              <td className="py-1.5 text-txt-secondary">{o.mode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
