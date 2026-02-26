import { useCallback } from "react";
import { api } from "../lib/api.js";
import { usePoll } from "../lib/use-poll.js";
import { PositionCard } from "../components/position-card.js";
import { EquityChart } from "../components/equity-chart.js";

export function Dashboard() {
  const health = usePoll(useCallback(() => api.health(), []), 10000);
  const positions = usePoll(useCallback(() => api.positions(), []), 5000);
  const equity = usePoll(useCallback(() => api.equity(), []), 10000);

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex items-center gap-4 bg-gray-800 rounded-lg p-4 border border-gray-700">
        {health.data ? (
          <>
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            <span className="font-semibold">{health.data.asset}</span>
            <span className="text-gray-400">{health.data.strategy}</span>
            <span className={`px-2 py-0.5 rounded text-xs ${health.data.mode === "live" ? "bg-red-600" : "bg-blue-600"}`}>
              {health.data.mode}
            </span>
            <span className="text-gray-500 ml-auto text-sm">
              Uptime: {Math.floor(health.data.uptime / 60)}m
            </span>
          </>
        ) : health.error ? (
          <>
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            <span className="text-red-400">Exchange offline: {health.error}</span>
          </>
        ) : (
          <span className="text-gray-500">Connecting...</span>
        )}
      </div>

      {/* Positions */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Open Positions</h2>
        {positions.data?.positions.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {positions.data.positions.map((p) => (
              <PositionCard key={p.coin} position={p} />
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No open positions.</p>
        )}
      </section>

      {/* Equity */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Equity Curve</h2>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <EquityChart snapshots={equity.data?.snapshots ?? []} />
        </div>
      </section>
    </div>
  );
}
