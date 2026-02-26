import { useCallback } from "react";
import { api } from "../lib/api.js";
import { usePoll } from "../lib/use-poll.js";
import { EquityChart } from "../components/equity-chart.js";

export function Equity() {
  const { data, loading } = usePoll(useCallback(() => api.equity(), []), 10000);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Equity Curve</h2>
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : (
          <EquityChart snapshots={data?.snapshots ?? []} />
        )}
      </div>
    </div>
  );
}
