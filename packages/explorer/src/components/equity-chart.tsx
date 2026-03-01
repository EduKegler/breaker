import { memo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Line,
} from "recharts";
import type { EquitySnapshot } from "../types/api.js";

/** SQLite datetime('now') returns UTC without 'Z' — append it so JS parses as UTC */
function parseUtc(dt: string): Date {
  return new Date(dt.endsWith("Z") ? dt : dt + "Z");
}

export const EquityChart = memo(function EquityChart({ snapshots }: { snapshots: EquitySnapshot[] }) {
  if (snapshots.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center">
        <p className="text-txt-secondary text-sm font-mono">
          No equity data yet
        </p>
      </div>
    );
  }

  const data = [...snapshots].reverse().map((s) => ({
    time: parseUtc(s.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    equity: s.equity,
    unrealized: s.unrealized_pnl,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00ff88" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#00ff88" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="time"
          tick={{ fill: "#6b6b80", fontSize: 10, fontFamily: "JetBrains Mono" }}
          axisLine={{ stroke: "#1e1e2e" }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: "#6b6b80", fontSize: 10, fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
          width={60}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#12121a",
            border: "1px solid #00ff88",
            borderRadius: 2,
            fontFamily: "JetBrains Mono",
            fontSize: 12,
          }}
          labelStyle={{ color: "#6b6b80" }}
          itemStyle={{ color: "#e0e0e8" }}
          formatter={(value: number) => [`$${value.toFixed(2)}`, undefined]}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#00ff88"
          strokeWidth={2}
          fill="url(#equityGrad)"
          dot={false}
          name="Equity"
        />
        <Line
          type="monotone"
          dataKey="unrealized"
          stroke="#ffaa00"
          strokeWidth={1}
          dot={false}
          strokeDasharray="4 4"
          name="Unrealized"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});
