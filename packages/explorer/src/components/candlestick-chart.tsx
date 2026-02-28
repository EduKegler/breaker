import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type SeriesMarker,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import type { CandleData, SignalRow, LivePosition, ReplaySignal } from "../types/api.js";

/** SQLite datetime('now') returns UTC without 'Z' — append it so JS parses as UTC */
function parseUtc(dt: string): Date {
  return new Date(dt.endsWith("Z") ? dt : dt + "Z");
}

const STRATEGY_ABBREVIATIONS: Record<string, string> = {
  "donchian-adx": "B",
  "keltner-rsi2": "MR",
  "manual": "M",
};

function strategyLabel(direction: "long" | "short", strategyName: string | null | undefined): string {
  const dir = direction === "long" ? "L" : "S";
  if (!strategyName) return dir;
  const abbr = STRATEGY_ABBREVIATIONS[strategyName] ?? strategyName.slice(0, 2).toUpperCase();
  return `${dir}(${abbr})`;
}

interface CandlestickChartProps {
  candles: CandleData[];
  signals: SignalRow[];
  replaySignals: ReplaySignal[];
  positions: LivePosition[];
  loading?: boolean;
  onLoadMore?: (before: number) => void;
  watermark?: { asset?: string; strategy?: string };
}

function toChartTime(ms: number): Time {
  return (ms / 1000) as Time;
}

function formatOhlcv(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CandlestickChart({ candles, signals, replaySignals, positions, loading, onLoadMore, watermark }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);
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

    // OHLCV legend: update via DOM (textContent) to avoid React re-renders on every mouse move
    chart.subscribeCrosshairMove((param) => {
      if (!legendRef.current) return;
      const data = param.seriesData?.get(series) as CandlestickData<Time> | undefined;
      if (!data || !param.time) {
        legendRef.current.textContent = "";
        return;
      }
      const bullish = data.close >= data.open;
      legendRef.current.style.color = bullish ? "#00ff88" : "#ff3366";
      legendRef.current.textContent =
        `O ${formatOhlcv(data.open)}  H ${formatOhlcv(data.high)}  L ${formatOhlcv(data.low)}  C ${formatOhlcv(data.close)}`;
    });

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

  // Watermark: asset name + strategy rendered on the chart canvas
  useEffect(() => {
    if (!chartRef.current || !watermark) return;
    const lines: { text: string; color: string; fontSize: number; fontFamily: string }[] = [];
    if (watermark.asset) {
      lines.push({
        text: watermark.asset,
        color: "rgba(255, 255, 255, 0.04)",
        fontSize: 72,
        fontFamily: "Outfit, sans-serif",
      });
    }
    if (watermark.strategy) {
      lines.push({
        text: watermark.strategy,
        color: "rgba(255, 255, 255, 0.03)",
        fontSize: 24,
        fontFamily: "JetBrains Mono, monospace",
      });
    }
    if (lines.length === 0) return;
    const pane = chartRef.current.panes()[0];
    const wm = createTextWatermark(pane, {
      horzAlign: "center",
      vertAlign: "center",
      lines,
    });
    return () => wm.detach();
  }, [watermark?.asset, watermark?.strategy]);

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
        text: strategyLabel(rs.direction, rs.strategyName),
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
      const direction: "long" | "short" = isLong ? "long" : "short";
      markers.push({
        time: toChartTime(closestT),
        position: isLong ? "belowBar" : "aboveBar",
        color: isAuto ? "#3b82f6" : "#eab308",
        shape: isLong ? "arrowUp" : "arrowDown",
        text: strategyLabel(direction, s.strategy_name),
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

    if (pos.takeProfits) {
      for (let i = 0; i < pos.takeProfits.length; i++) {
        const tp = pos.takeProfits[i];
        if (tp.price > 0) {
          seriesRef.current.createPriceLine({
            price: tp.price,
            color: "#00ff88",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP${i + 1}`,
          });
        }
      }
    }

    if (pos.trailingStopLoss != null && pos.trailingStopLoss > 0) {
      seriesRef.current.createPriceLine({
        price: pos.trailingStopLoss,
        color: "#ff9900",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TSL",
      });
    }

    if (pos.liquidationPx != null && pos.liquidationPx > 0) {
      seriesRef.current.createPriceLine({
        price: pos.liquidationPx,
        color: "#ff3366",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Liq",
      });
    }
  }, [positions]);

  return (
    <div className="relative h-96 w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        ref={legendRef}
        className="absolute top-2 left-2 z-10 text-[11px] font-mono pointer-events-none select-none"
      />
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
