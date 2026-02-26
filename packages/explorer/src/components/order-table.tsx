import type { OrderRow } from "../lib/api.js";

const statusColors: Record<string, string> = {
  filled: "text-green-400",
  pending: "text-yellow-400",
  cancelled: "text-gray-500",
  rejected: "text-red-400",
};

export function OrderTable({ orders }: { orders: OrderRow[] }) {
  if (orders.length === 0) {
    return <p className="text-gray-500 text-sm">No orders yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-400 border-b border-gray-700">
            <th className="pb-2 pr-4">Time</th>
            <th className="pb-2 pr-4">Coin</th>
            <th className="pb-2 pr-4">Side</th>
            <th className="pb-2 pr-4">Type</th>
            <th className="pb-2 pr-4">Tag</th>
            <th className="pb-2 pr-4">Size</th>
            <th className="pb-2 pr-4">Price</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2">Mode</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-gray-800 hover:bg-gray-800/50">
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                {o.created_at ? new Date(o.created_at).toLocaleString() : "-"}
              </td>
              <td className="py-2 pr-4 font-semibold">{o.coin}</td>
              <td className={`py-2 pr-4 ${o.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                {o.side.toUpperCase()}
              </td>
              <td className="py-2 pr-4">{o.order_type}</td>
              <td className="py-2 pr-4 text-gray-400">{o.tag}</td>
              <td className="py-2 pr-4 font-mono">{o.size}</td>
              <td className="py-2 pr-4 font-mono">{o.price ? `$${o.price.toLocaleString()}` : "market"}</td>
              <td className={`py-2 pr-4 ${statusColors[o.status] ?? "text-gray-300"}`}>
                {o.status}
              </td>
              <td className="py-2 text-gray-500">{o.mode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
