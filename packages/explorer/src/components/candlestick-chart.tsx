import { memo, useRef, useEffect } from "react";
import { useStore } from "../store/use-store.js";
import {
  selectCandles,
  selectIsLiveInterval,
  selectFilteredSignals,
  selectFilteredReplaySignals,
  selectCoinPositions,
  selectCoinList,
  selectWatermark,
} from "../store/selectors.js";
import { useChartInstance } from "../lib/use-chart-instance.js";
import { useChartCandles } from "../lib/use-chart-candles.js";
import { useChartMarkers } from "../lib/use-chart-markers.js";
import { useChartPriceLines } from "../lib/use-chart-price-lines.js";
import { useKeyboardShortcuts } from "../lib/use-keyboard-shortcuts.js";
import { toChartTime, toOhlcvData } from "../lib/to-chart-time.js";
import { SessionHighlightPrimitive } from "../lib/primitives/session-highlight.js";
import { VolumeProfilePrimitive } from "../lib/primitives/volume-profile.js";

export const CandlestickChart = memo(function CandlestickChart() {
  // ── Store subscriptions (granular selectors) ─
  const coin = useStore((s) => s.selectedCoin);
  const candles = useStore(selectCandles);
  const signals = useStore(selectFilteredSignals);
  const replaySignals = useStore(selectFilteredReplaySignals);
  const positions = useStore(selectCoinPositions);
  const loading = useStore((s) => s.candlesLoading);
  const isLive = useStore(selectIsLiveInterval);
  const watermark = useStore(selectWatermark);
  const coinList = useStore(selectCoinList);
  const showSessions = useStore((s) => s.showSessions);
  const showVpvr = useStore((s) => s.showVpvr);
  const onLoadMore = useStore((s) => s.loadMoreCandles);
  const onSelectCoin = useStore((s) => s.selectCoin);

  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  const { chartRef, seriesRef, volumeSeriesRef, markersRef } = useChartInstance(
    {
      containerRef,
      legendRef,
      candlesRef,
      loadingRef,
      onLoadMoreRef,
      watermark,
    },
  );

  useChartCandles({
    coin,
    candles,
    chartRef,
    seriesRef,
    volumeSeriesRef,
    legendRef,
    loadingRef,
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

  // ── Session highlighting ─────────────────────
  useEffect(() => {
    if (!seriesRef.current || !showSessions) return;
    const prim = new SessionHighlightPrimitive();
    seriesRef.current.attachPrimitive(prim);
    prim.setCandleTimes(candles.map((c) => toChartTime(c.t) as number));
    return () => { seriesRef.current?.detachPrimitive(prim); };
  }, [showSessions, seriesRef, candles, coin]);

  // ── Volume Profile (VPVR) ───────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DEFAULT_CHART_WIDTH = 800;

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || !showVpvr) return;
    const chart = chartRef.current;
    const prim = new VolumeProfilePrimitive();
    seriesRef.current.attachPrimitive(prim);
    prim.setCandles(candles.map(toOhlcvData));

    // Subscribe to visible range changes with debounce
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const width =
          containerRef.current?.clientWidth ?? DEFAULT_CHART_WIDTH;
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
    };
  }, [showVpvr, seriesRef, chartRef, candles, coin]);

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
              <span className="text-sm text-txt-secondary font-mono">
                Loading candles…
              </span>
            </div>
          ) : (
            <p className="text-txt-secondary text-sm font-mono">
              No candle data yet
            </p>
          )}
        </div>
      )}
    </div>
  );
});
