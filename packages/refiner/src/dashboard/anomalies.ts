import type { DashboardEvent } from "../types/events.js";

interface AnomalyEvent extends DashboardEvent {
  anomalies?: string[];
}

/**
 * Detects anomalies in a sequence of dashboard events.
 * Returns the same events enriched with an `anomalies` array where applicable.
 *
 * Rules:
 * 1. Trades INCREASED after adding a filter (stage contains "FILTER" or message mentions
 *    "block"/"remove") → "dataset shift provavel"
 * 2. PnL swing >20% between consecutive PARSE_DONE iterations → "swing grande"
 */
export function detectAnomalies(events: DashboardEvent[]): AnomalyEvent[] {
  const result: AnomalyEvent[] = events.map((e) => ({ ...e }));

  const parseDoneEvents: { index: number; event: AnomalyEvent }[] = [];
  for (let i = 0; i < result.length; i++) {
    if (result[i].stage === "PARSE_DONE") {
      parseDoneEvents.push({ index: i, event: result[i] });
    }
  }

  for (let i = 1; i < parseDoneEvents.length; i++) {
    const prev = parseDoneEvents[i - 1].event;
    const curr = parseDoneEvents[i].event;
    const anomalies: string[] = [];

    // Rule 1: Trades increased after a filter operation
    // Look for filter-related events between these two PARSE_DONE events
    const prevIdx = parseDoneEvents[i - 1].index;
    const currIdx = parseDoneEvents[i].index;
    const hasFilterBetween = result.slice(prevIdx + 1, currIdx).some(
      (e) => isFilterRelated(e),
    );

    if (hasFilterBetween && curr.trades > prev.trades) {
      anomalies.push("dataset shift provavel");
    }

    // Rule 2: PnL swing > 20% between consecutive iterations
    if (prev.pnl !== 0) {
      const pnlChange = Math.abs(curr.pnl - prev.pnl) / Math.abs(prev.pnl);
      if (pnlChange > 0.20) {
        const dir = curr.pnl > prev.pnl ? "+" : "-";
        anomalies.push(`swing grande (${dir}${(pnlChange * 100).toFixed(1)}%)`);
      }
    }

    if (anomalies.length > 0) {
      curr.anomalies = anomalies;
    }
  }

  return result;
}

function isFilterRelated(e: DashboardEvent): boolean {
  const stage = (e.stage || "").toUpperCase();
  const msg = (e.message || "").toLowerCase();
  return (
    stage.includes("FILTER") ||
    stage.includes("OPTIMIZE") ||
    msg.includes("block") ||
    msg.includes("remove") ||
    msg.includes("filtro") ||
    msg.includes("bloque")
  );
}
