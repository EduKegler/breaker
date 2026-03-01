import { useEffect, useRef, type RefObject } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type CandlestickData,
  type Time,
} from "lightweight-charts";
import type { CandleData } from "../types/api.js";
import { CrosshairHighlightPrimitive } from "./primitives/crosshair-highlight.js";

function formatOhlcv(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(2);
}

export interface ChartRefs {
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  volumeSeriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  markersRef: RefObject<ISeriesMarkersPluginApi<Time> | null>;
}

export interface UseChartInstanceOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  legendRef: RefObject<HTMLDivElement | null>;
  candlesRef: RefObject<CandleData[]>;
  loadingRef: RefObject<boolean>;
  onLoadMoreRef: RefObject<((before: number) => void) | undefined>;
  watermark?: { asset?: string; strategy?: string };
}

export function useChartInstance(opts: UseChartInstanceOptions): ChartRefs {
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Create chart once
  useEffect(() => {
    if (!opts.containerRef.current) return;

    const chart = createChart(opts.containerRef.current, {
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

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      borderVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volumeSeries;
    markersRef.current = createSeriesMarkers(series, []);

    // Crosshair highlight primitive
    const crosshairHighlight = new CrosshairHighlightPrimitive();
    series.attachPrimitive(crosshairHighlight);

    // OHLCV legend with delta, pct, and volume
    chart.subscribeCrosshairMove((param) => {
      crosshairHighlight.setHighlightTime(param.time as Time | null ?? null);
      if (!opts.legendRef.current) return;
      const data = param.seriesData?.get(series) as CandlestickData<Time> | undefined;
      if (!data || !param.time) {
        opts.legendRef.current.textContent = "";
        return;
      }
      const bullish = data.close >= data.open;
      opts.legendRef.current.style.color = bullish ? "#00ff88" : "#ff3366";

      const delta = data.close - data.open;
      const pct = (delta / data.open) * 100;
      const sign = delta >= 0 ? "+" : "";

      // Get volume from the volume series data
      const volData = param.seriesData?.get(volumeSeries) as { value?: number } | undefined;
      const volStr = volData?.value != null ? `  V ${formatVolume(volData.value)}` : "";

      opts.legendRef.current.textContent =
        `O ${formatOhlcv(data.open)}  H ${formatOhlcv(data.high)}  L ${formatOhlcv(data.low)}  C ${formatOhlcv(data.close)}  ${sign}${formatOhlcv(delta)} (${sign}${pct.toFixed(2)}%)${volStr}`;
    });

    // Lazy load: detect scroll near left edge
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || opts.loadingRef.current) return;
      if (range.from < 50) {
        const currentCandles = opts.candlesRef.current;
        if (currentCandles.length === 0) return;
        const oldestTs = currentCandles[0].t;
        opts.loadingRef.current = true;
        opts.onLoadMoreRef.current?.(oldestTs);
        setTimeout(() => { opts.loadingRef.current = false; }, 1000);
      }
    });

    // Responsive resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.resize(width, height);
      }
    });
    ro.observe(opts.containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Watermark
  useEffect(() => {
    if (!chartRef.current || !opts.watermark) return;
    const lines: { text: string; color: string; fontSize: number; fontFamily: string }[] = [];
    if (opts.watermark.asset) {
      lines.push({
        text: opts.watermark.asset,
        color: "rgba(255, 255, 255, 0.04)",
        fontSize: 72,
        fontFamily: "Outfit, sans-serif",
      });
    }
    if (opts.watermark.strategy) {
      lines.push({
        text: opts.watermark.strategy,
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
  }, [opts.watermark?.asset, opts.watermark?.strategy]);

  return { chartRef, seriesRef, volumeSeriesRef, markersRef };
}
