import type { LivePosition } from "../lib/api.js";

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function PositionCard({ position }: { position: LivePosition }) {
  const pnlColor = position.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400";
  const dirColor = position.direction === "long" ? "bg-green-600" : "bg-red-600";

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold">{position.coin}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${dirColor}`}>
            {position.direction}
          </span>
        </div>
        <span className={`text-lg font-mono ${pnlColor}`}>
          {formatUsd(position.unrealizedPnl)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm text-gray-400">
        <div>Entry: <span className="text-gray-200 font-mono">{formatUsd(position.entryPrice)}</span></div>
        <div>Current: <span className="text-gray-200 font-mono">{formatUsd(position.currentPrice)}</span></div>
        <div>Size: <span className="text-gray-200 font-mono">{position.size}</span></div>
        <div>SL: <span className="text-gray-200 font-mono">{formatUsd(position.stopLoss)}</span></div>
      </div>
    </div>
  );
}
