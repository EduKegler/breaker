import { useRef, useEffect } from "react";
import type { Time } from "lightweight-charts";
import type { CandleData, SignalRow, LivePosition, ReplaySignal } from "../types/api.js";
import { useChartInstance } from "../lib/use-chart-instance.js";
import { useChartCandles } from "../lib/use-chart-candles.js";
import { useChartMarkers } from "../lib/use-chart-markers.js";
import { useChartPriceLines } from "../lib/use-chart-price-lines.js";
import { useKeyboardShortcuts } from "../lib/use-keyboard-shortcuts.js";
import { toChartTime, toOhlcvData } from "../lib/to-chart-time.js";
import { SessionHighlightPrimitive } from "../lib/primitives/session-highlight.js";
import { VolumeProfilePrimitive } from "../lib/primitives/volume-profile.js";

interface CandlestickChartProps {
  coin: string;
  candles: CandleData[];
  signals: SignalRow[];
  replaySignals: ReplaySignal[];
  positions: LivePosition[];
  loading?: boolean;
  isLive?: boolean;
  showSessions?: boolean;
  showVpvr?: boolean;
  onLoadMore?: (before: number) => void;
  watermark?: { asset?: string; strategy?: string };
  coinList?: string[];
  onSelectCoin?: (coin: string) => void;
  onVisibleRangeChange?: (from: Time, to: Time) => void;
  onSetVisibleRange?: (ref: ((from: Time, to: Time) => void) | null) => void;
}

export function CandlestickChart({
  coin,
  candles,
  signals,
  replaySignals,
  positions,
  loading,
  isLive = true,
  showSessions = false,
  showVpvr = false,
  onLoadMore,
  watermark,
  coinList,
  onSelectCoin,
  onVisibleRangeChange,
  onSetVisibleRange,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  const { chartRef, seriesRef, volumeSeriesRef, markersRef } = useChartInstance({
    containerRef,
    legendRef,
    candlesRef,
    loadingRef,
    onLoadMoreRef,
    watermark,
  });

  useChartCandles({
    coin,
    candles,
    chartRef,
    seriesRef,
    volumeSeriesRef,
    legendRef,
    isLive,
  });

  useChartMarkers({
    candles,
    signals,
    replaySignals,
    markersRef,
    seriesRef,
  });

  useChartPriceLines({
    positions,
    seriesRef,
  });

  useKeyboardShortcuts({
    chartRef,
    coinList,
    coin,
    onSelectCoin,
  });

  // ── Bidirectional range sync ──────────────────
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  onVisibleRangeChangeRef.current = onVisibleRangeChange;

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      const timeRange = chart.timeScale().getVisibleRange();
      if (timeRange) {
        onVisibleRangeChangeRef.current?.(timeRange.from, timeRange.to);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, [chartRef]);

  // Expose setVisibleRange function to parent
  useEffect(() => {
    if (!onSetVisibleRange) return;
    const setter = (from: Time, to: Time) => {
      chartRef.current?.timeScale().setVisibleRange({ from, to });
    };
    onSetVisibleRange(setter);
    return () => onSetVisibleRange(null);
  }, [onSetVisibleRange, chartRef]);

  // ── Session highlighting ─────────────────────
  const sessionPrimRef = useRef<SessionHighlightPrimitive | null>(null);
  const sessionCandlesLenRef = useRef(0);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (showSessions) {
      const prim = new SessionHighlightPrimitive();
      seriesRef.current.attachPrimitive(prim);
      sessionPrimRef.current = prim;
      const times = candles.map((c) => toChartTime(c.t) as number);
      sessionCandlesLenRef.current = candles.length;
      prim.setCandleTimes(times);
      return () => {
        seriesRef.current?.detachPrimitive(prim);
        sessionPrimRef.current = null;
      };
    } else {
      sessionPrimRef.current = null;
    }
  }, [showSessions, seriesRef]);

  // Update session candle times when candles change (new candle or coin switch)
  useEffect(() => {
    if (!sessionPrimRef.current || candles.length === 0) return;
    if (candles.length === sessionCandlesLenRef.current) return;
    sessionCandlesLenRef.current = candles.length;
    const raf = requestAnimationFrame(() => {
      sessionPrimRef.current?.setCandleTimes(candles.map((c) => toChartTime(c.t) as number));
    });
    return () => cancelAnimationFrame(raf);
  }, [candles, showSessions, coin]);

  // ── Volume Profile (VPVR) ───────────────────
  const vpvrPrimRef = useRef<VolumeProfilePrimitive | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vpvrCandlesLenRef = useRef(0);
  const DEFAULT_CHART_WIDTH = 800;

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (showVpvr) {
      const prim = new VolumeProfilePrimitive();
      seriesRef.current.attachPrimitive(prim);
      vpvrPrimRef.current = prim;

      prim.setCandles(candles.map(toOhlcvData));
      vpvrCandlesLenRef.current = candles.length;

      // Subscribe to visible range changes with debounce
      const chart = chartRef.current;
      const handler = (range: { from: number; to: number } | null) => {
        if (!range) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          const width = containerRef.current?.clientWidth ?? DEFAULT_CHART_WIDTH;
          prim.recalculate(range.from, range.to, width);
        }, 150);
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(handler);

      // Initial calc
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range) {
        const width = containerRef.current?.clientWidth ?? DEFAULT_CHART_WIDTH;
        prim.recalculate(range.from, range.to, width);
      }

      return () => {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        seriesRef.current?.detachPrimitive(prim);
        vpvrPrimRef.current = null;
      };
    } else {
      vpvrPrimRef.current = null;
    }
  }, [showVpvr, seriesRef, chartRef]);

  // Update VPVR candles when candles change (new candle or coin switch)
  useEffect(() => {
    if (!vpvrPrimRef.current || candles.length === 0) return;
    if (candles.length === vpvrCandlesLenRef.current) return;
    vpvrCandlesLenRef.current = candles.length;
    const raf = requestAnimationFrame(() => {
      if (!vpvrPrimRef.current) return;
      vpvrPrimRef.current.setCandles(candles.map(toOhlcvData));
      const chart = chartRef.current;
      if (chart) {
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) {
          const width = containerRef.current?.clientWidth ?? DEFAULT_CHART_WIDTH;
          vpvrPrimRef.current.recalculate(range.from, range.to, width);
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [candles, showVpvr, coin]);

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
