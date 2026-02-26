import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import type { EquitySnapshot } from "../lib/api.js";

export function EquityChart({ snapshots }: { snapshots: EquitySnapshot[] }) {
  if (snapshots.length === 0) {
    return <p className="text-gray-500 text-sm">No equity data yet.</p>;
  }

  // Snapshots come in DESC order from API, reverse for chart
  const data = [...snapshots].reverse().map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString(),
    equity: s.equity,
    unrealized: s.unrealized_pnl,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis dataKey="time" tick={{ fill: "#9ca3af", fontSize: 11 }} />
        <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
        <Tooltip
          contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8 }}
          labelStyle={{ color: "#9ca3af" }}
        />
        <Line type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="unrealized" stroke="#f59e0b" strokeWidth={1} dot={false} strokeDasharray="4 4" />
      </LineChart>
    </ResponsiveContainer>
  );
}
