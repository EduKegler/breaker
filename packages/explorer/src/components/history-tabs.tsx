import { useState } from "react";
import type { PositionSummary, SignalRow } from "../types/api.js";
import { PositionHistoryTable } from "./position-history-table.js";
import { SignalHistoryTable } from "./signal-history-table.js";

type Tab = "positions" | "signals";

export function HistoryTabs({
  positions,
  signals,
}: {
  positions: PositionSummary[];
  signals: SignalRow[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>("positions");

  return (
    <div>
      <div className="flex items-center gap-1 mb-3">
        <TabButton
          active={activeTab === "positions"}
          count={positions.length}
          onClick={() => setActiveTab("positions")}
        >
          Positions
        </TabButton>
        <TabButton
          active={activeTab === "signals"}
          count={signals.length}
          onClick={() => setActiveTab("signals")}
        >
          Signals
        </TabButton>
      </div>

      {activeTab === "positions" ? (
        <PositionHistoryTable positions={positions} />
      ) : (
        <SignalHistoryTable signals={signals} />
      )}
    </div>
  );
}

function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-sm transition-all cursor-pointer ${
        active
          ? "bg-terminal-border/60 text-txt-primary"
          : "text-txt-secondary/60 hover:text-txt-secondary hover:bg-terminal-border/30"
      }`}
    >
      {children}
      {count > 0 && (
        <span
          className={`px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-sm ${
            active
              ? "bg-terminal-bg text-txt-secondary"
              : "bg-terminal-border/50 text-txt-secondary/60"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
