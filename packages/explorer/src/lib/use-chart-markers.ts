import { useEffect, useRef } from "react";
import type { ISeriesMarkersPluginApi, ISeriesApi, SeriesMarker, SeriesType, Time } from "lightweight-charts";
import type { RefObject } from "react";
import type { CandleData, SignalRow, ReplaySignal } from "../types/api.js";
import { strategyLabel } from "./strategy-abbreviations.js";
import { parseUtc } from "./parse-utc.js";
import { toChartTime } from "./to-chart-time.js";
import { SignalVerticalLinesPrimitive, type SignalLine } from "./primitives/signal-vertical-lines.js";

/** Binary search for closest timestamp in a sorted array. */
function findClosestTime(sorted: number[], target: number): number {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - target) < Math.abs(sorted[lo] - target)) {
    return sorted[lo - 1];
  }
  return sorted[lo];
}

export interface UseChartMarkersOptions {
  candles: CandleData[];
  signals: SignalRow[];
  replaySignals: ReplaySignal[];
  markersRef: RefObject<ISeriesMarkersPluginApi<Time> | null>;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
}

export function useChartMarkers(opts: UseChartMarkersOptions): void {
  const primitiveRef = useRef<SignalVerticalLinesPrimitive | null>(null);

  // Attach/detach primitive
  useEffect(() => {
    if (!opts.seriesRef.current) return;
    const prim = new SignalVerticalLinesPrimitive();
    opts.seriesRef.current.attachPrimitive(prim);
    primitiveRef.current = prim;
    return () => {
      opts.seriesRef.current?.detachPrimitive(prim);
      primitiveRef.current = null;
    };
  }, [opts.seriesRef]);

  useEffect(() => {
    if (!opts.markersRef.current || opts.candles.length === 0) return;
    const candleTimesSet = new Set(opts.candles.map((c) => c.t));
    const candleTimesSorted = opts.candles.map((c) => c.t); // already sorted
    const markers: SeriesMarker<Time>[] = [];
    const signalLines: SignalLine[] = [];

    // Executed signal timestamps — to avoid duplicate markers at same candle
    const executedTimes = new Set<number>();
    for (const s of opts.signals) {
      if (s.risk_check_passed !== 1 || !s.entry_price) continue;
      const signalTs = parseUtc(s.created_at).getTime();
      executedTimes.add(findClosestTime(candleTimesSorted, signalTs));
    }

    // Replay signals — skip if executed at same candle
    for (const rs of opts.replaySignals) {
      if (!candleTimesSet.has(rs.t) || executedTimes.has(rs.t)) continue;
      const isLong = rs.direction === "long";

      markers.push({
        time: toChartTime(rs.t),
        position: isLong ? "belowBar" : "aboveBar",
        color: "#3b82f6",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: strategyLabel(rs.direction, rs.strategyName),
        size: 1,
      });
    }

    // Executed signals — prominent markers + vertical lines
    for (const s of opts.signals) {
      if (s.risk_check_passed !== 1 || !s.entry_price) continue;

      const signalTs = parseUtc(s.created_at).getTime();
      const closestT = findClosestTime(candleTimesSorted, signalTs);

      if (!candleTimesSet.has(closestT)) continue;

      const isLong = s.side === "LONG";
      const isAuto = s.source === "strategy-runner";
      const direction: "long" | "short" = isLong ? "long" : "short";
      const color = isAuto ? "#3b82f6" : "#eab308";

      markers.push({
        time: toChartTime(closestT),
        position: isLong ? "belowBar" : "aboveBar",
        color,
        shape: isLong ? "arrowUp" : "arrowDown",
        text: strategyLabel(direction, s.strategy_name),
        size: 1,
      });

      signalLines.push({ time: toChartTime(closestT), color });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    opts.markersRef.current.setMarkers(markers);

    // Update signal vertical lines
    primitiveRef.current?.setLines(signalLines);
  }, [opts.signals, opts.replaySignals, opts.candles]);
}
