import { useEffect, useRef } from "react";
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
import type { CandleData, SignalRow, LivePosition } from "../lib/api.js";

interface CandlestickChartProps {
  candles: CandleData[];
  signals: SignalRow[];
  positions: LivePosition[];
}

function toChartTime(ms: number): Time {
  return (ms / 1000) as Time;
}

export function CandlestickChart({ candles, signals, positions }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles]);

  // Update markers when signals change
  useEffect(() => {
    if (!markersRef.current || candles.length === 0) return;

    const candleTimes = new Set(candles.map((c) => c.t));

    const markers: SeriesMarker<Time>[] = [];

    for (const s of signals) {
      if (s.risk_check_passed !== 1 || !s.entry_price) continue;

      const signalTs = new Date(s.created_at).getTime();
      // Find the closest candle time
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
      markers.push({
        time: toChartTime(closestT),
        position: isLong ? "belowBar" : "aboveBar",
        color: isLong ? "#00ff88" : "#ff3366",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: `${isLong ? "L" : "S"} ${s.entry_price}`,
      });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current.setMarkers(markers);
  }, [signals, candles]);

  // Update price lines for active position
  useEffect(() => {
    if (!seriesRef.current) return;

    // Remove existing price lines
    for (const line of seriesRef.current.priceLines()) {
      seriesRef.current.removePriceLine(line);
    }

    if (positions.length === 0) return;

    const pos = positions[0];

    // Entry price line
    seriesRef.current.createPriceLine({
      price: pos.entryPrice,
      color: "#ffaa00",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "Entry",
    });

    // Stop loss price line
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
          <p className="text-txt-secondary text-sm font-mono">No candle data yet</p>
        </div>
      )}
    </div>
  );
}
