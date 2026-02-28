import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { CandleData, SignalRow, LivePosition, ReplaySignal } from "../types/api.js";

/** SQLite datetime('now') returns UTC without 'Z' — append it so JS parses as UTC */
function parseUtc(dt: string): Date {
  return new Date(dt.endsWith("Z") ? dt : dt + "Z");
}

interface CandlestickChartProps {
  candles: CandleData[];
  signals: SignalRow[];
  replaySignals: ReplaySignal[];
  positions: LivePosition[];
  loading?: boolean;
  onLoadMore?: (before: number) => void;
}

function toChartTime(ms: number): Time {
  return (ms / 1000) as Time;
}

export function CandlestickChart({ candles, signals, replaySignals, positions, loading, onLoadMore }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const loadingRef = useRef(false);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "#6b6b80",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1e1e2e" },
        horzLines: { color: "#1e1e2e" },
      },
      crosshair: {
        vertLine: { color: "#3a3a4a", labelBackgroundColor: "#1e1e2e" },
        horzLine: { color: "#3a3a4a", labelBackgroundColor: "#1e1e2e" },
      },
      timeScale: {
        borderColor: "#1e1e2e",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "#1e1e2e",
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#00ff88",
      downColor: "#ff3366",
      borderVisible: false,
      wickUpColor: "#00ff88",
      wickDownColor: "#ff3366",
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    // Lazy load: detect scroll near left edge
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || loadingRef.current) return;
      if (range.from < 50) {
        const currentCandles = candlesRef.current;
        if (currentCandles.length === 0) return;
        const oldestTs = currentCandles[0].t;
        loadingRef.current = true;
        onLoadMoreRef.current?.(oldestTs);
        setTimeout(() => { loadingRef.current = false; }, 1000);
      }
    });

    // Responsive resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.resize(width, height);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Update data when candles change
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    const data = candles.map((c) => ({
      time: toChartTime(c.t),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));

    seriesRef.current.setData(data);
  }, [candles]);

  // Update markers when signals or replay signals change
  useEffect(() => {
    if (!markersRef.current || candles.length === 0) return;

    const candleTimes = new Set(candles.map((c) => c.t));
    const markers: SeriesMarker<Time>[] = [];

    // Executed signal timestamps — to avoid duplicate markers at same candle
    const executedTimes = new Set<number>();
    for (const s of signals) {
      if (s.risk_check_passed !== 1 || !s.entry_price) continue;
      const signalTs = parseUtc(s.created_at).getTime();
      let closestT = candles[0].t;
      let minDiff = Math.abs(signalTs - closestT);
      for (const c of candles) {
        const diff = Math.abs(signalTs - c.t);
        if (diff < minDiff) { minDiff = diff; closestT = c.t; }
      }
      executedTimes.add(closestT);
    }

    // Replay signals (strategy theoretical signals) — skip if executed at same candle
    // Two stacked markers per signal: colored arrow (close to bar) + blue text (further)
    for (const rs of replaySignals) {
      if (!candleTimes.has(rs.t) || executedTimes.has(rs.t)) continue;
      const isLong = rs.direction === "long";

      markers.push({
        time: toChartTime(rs.t),
        position: isLong ? "belowBar" : "aboveBar",
        color: "#3b82f6",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: isLong ? "L" : "S",
        size: 1,
      });
    }

    // Executed signals (actual trades from SQLite) — prominent markers
    for (const s of signals) {
      if (s.risk_check_passed !== 1 || !s.entry_price) continue;

      const signalTs = parseUtc(s.created_at).getTime();
      let closestT = candles[0].t;
      let minDiff = Math.abs(signalTs - closestT);
      for (const c of candles) {
        const diff = Math.abs(signalTs - c.t);
        if (diff < minDiff) {
          minDiff = diff;
          closestT = c.t;
        }
      }

      if (!candleTimes.has(closestT)) continue;

      const isLong = s.side === "LONG";
      const isAuto = s.source === "strategy-runner";
      markers.push({
        time: toChartTime(closestT),
        position: isLong ? "belowBar" : "aboveBar",
        color: isAuto ? "#3b82f6" : "#eab308",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: isLong ? "L" : "S",
        size: 1,
      });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current.setMarkers(markers);
  }, [signals, replaySignals, candles]);

  // Update price lines for active position
  useEffect(() => {
    if (!seriesRef.current) return;

    for (const line of seriesRef.current.priceLines()) {
      seriesRef.current.removePriceLine(line);
    }

    if (positions.length === 0) return;

    const pos = positions[0];

    seriesRef.current.createPriceLine({
      price: pos.entryPrice,
      color: "#ffaa00",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "Entry",
    });

    if (pos.stopLoss > 0) {
      seriesRef.current.createPriceLine({
        price: pos.stopLoss,
        color: "#ff3366",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "SL",
      });
    }
  }, [positions]);

  return (
    <div className="relative h-96 w-full">
      <div ref={containerRef} className="h-full w-full" />
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          {loading ? (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-2 border-txt-secondary/30 border-t-txt-secondary animate-spin" />
              <span className="text-sm text-txt-secondary font-mono">Loading candles…</span>
            </div>
          ) : (
            <p className="text-txt-secondary text-sm font-mono">No candle data yet</p>
          )}
        </div>
      )}
    </div>
  );
}
