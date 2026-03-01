import { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  AreaSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { useStore } from "../store/use-store.js";
import { selectCandles } from "../store/selectors.js";
import { toChartTime } from "../lib/to-chart-time.js";

interface RangeSelectorProps {
  onRangeChange: (from: Time, to: Time) => void;
  onSetUpdate?: (ref: ((from: Time, to: Time) => void) | null) => void;
}

export function RangeSelector({ onRangeChange, onSetUpdate }: RangeSelectorProps) {
  const candles = useStore(selectCandles);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [dragging, setDragging] = useState<"left" | "right" | "center" | null>(null);
  const draggingRef = useRef<"left" | "right" | "center" | null>(null);
  const dragStartRef = useRef({ x: 0, leftPct: 0, rightPct: 0 });

  // Range as percentage of container width
  const [leftPct, setLeftPct] = useState(0);
  const [rightPct, setRightPct] = useState(100);
  const leftPctRef = useRef(0);
  const rightPctRef = useRef(100);

  // Keep refs in sync with state
  leftPctRef.current = leftPct;
  rightPctRef.current = rightPct;

  // Stable refs for callbacks
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  // Create mini chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "transparent",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 0,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false },
      },
      timeScale: {
        visible: false,
      },
      rightPriceScale: {
        visible: false,
      },
      leftPriceScale: {
        visible: false,
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#ffaa00",
      topColor: "rgba(255,170,0,0.25)",
      bottomColor: "rgba(255,170,0,0.02)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

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
    };
  }, []);

  // Update data — use length + firstT check to detect coin switch vs WS tick
  const prevCandlesLenRef = useRef(0);
  const prevFirstTRef = useRef(0);
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    const firstT = candles[0].t;
    if (candles.length === prevCandlesLenRef.current && firstT === prevFirstTRef.current) {
      // In-progress tick: update last point only
      const last = candles[candles.length - 1];
      seriesRef.current.update({ time: toChartTime(last.t), value: last.c });
    } else {
      // New candle, coin switch, or full dataset change — defer to not block main thread
      prevCandlesLenRef.current = candles.length;
      prevFirstTRef.current = firstT;
      const series = seriesRef.current;
      const chart = chartRef.current;
      requestAnimationFrame(() => {
        series?.setData(
          candles.map((c) => ({ time: toChartTime(c.t), value: c.c })),
        );
        chart?.timeScale().fitContent();
      });
    }
  }, [candles]);

  // Expose imperative update for visible range (avoids App re-render)
  useEffect(() => {
    if (!onSetUpdate) return;
    const update = (from: Time, to: Time) => {
      if (draggingRef.current) return; // Suppress sync during drag
      const c = candlesRef.current;
      if (c.length === 0) return;
      const firstTime = toChartTime(c[0].t) as number;
      const lastTime = toChartTime(c[c.length - 1].t) as number;
      const totalRange = lastTime - firstTime;
      if (totalRange <= 0) return;
      const newLeft = Math.max(0, Math.min(100, ((from as number) - firstTime) / totalRange * 100));
      const newRight = Math.max(0, Math.min(100, ((to as number) - firstTime) / totalRange * 100));
      setLeftPct(newLeft);
      setRightPct(newRight);
    };
    onSetUpdate(update);
    return () => onSetUpdate(null);
  }, [onSetUpdate]);

  // Convert pct to Time and call onRangeChange — uses refs to avoid dependency churn
  const emitRange = useCallback((lPct: number, rPct: number) => {
    const c = candlesRef.current;
    if (c.length === 0) return;
    const firstTime = toChartTime(c[0].t) as number;
    const lastTime = toChartTime(c[c.length - 1].t) as number;
    const totalRange = lastTime - firstTime;
    const from = (firstTime + (lPct / 100) * totalRange) as Time;
    const to = (firstTime + (rPct / 100) * totalRange) as Time;
    onRangeChangeRef.current(from, to);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent, type: "left" | "right" | "center") => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(type);
    draggingRef.current = type;
    dragStartRef.current = { x: e.clientX, leftPct: leftPctRef.current, rightPct: rightPctRef.current };
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = overlayRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const deltaPct = ((e.clientX - dragStartRef.current.x) / rect.width) * 100;

      if (dragging === "left") {
        const newLeft = Math.max(0, Math.min(rightPctRef.current - 5, dragStartRef.current.leftPct + deltaPct));
        setLeftPct(newLeft);
      } else if (dragging === "right") {
        const newRight = Math.max(leftPctRef.current + 5, Math.min(100, dragStartRef.current.rightPct + deltaPct));
        setRightPct(newRight);
      } else if (dragging === "center") {
        const width = dragStartRef.current.rightPct - dragStartRef.current.leftPct;
        let newLeft = dragStartRef.current.leftPct + deltaPct;
        let newRight = dragStartRef.current.rightPct + deltaPct;
        if (newLeft < 0) { newLeft = 0; newRight = width; }
        if (newRight > 100) { newRight = 100; newLeft = 100 - width; }
        setLeftPct(newLeft);
        setRightPct(newRight);
      }
    };

    const handleMouseUp = () => {
      setDragging(null);
      draggingRef.current = null;
      emitRange(leftPctRef.current, rightPctRef.current);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, emitRange]);

  // Emit range during drag for live feedback
  useEffect(() => {
    if (dragging) {
      emitRange(leftPct, rightPct);
    }
  }, [leftPct, rightPct, dragging, emitRange]);

  return (
    <div className="relative h-[50px] w-full mt-1 select-none">
      {/* Mini chart */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Overlay with handles */}
      <div ref={overlayRef} className="absolute inset-0">
        {/* Dimmed left region */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-black/50"
          style={{ width: `${leftPct}%` }}
        />
        {/* Dimmed right region */}
        <div
          className="absolute top-0 bottom-0 right-0 bg-black/50"
          style={{ width: `${100 - rightPct}%` }}
        />

        {/* Selected region (draggable center) */}
        <div
          className="absolute top-0 bottom-0 border-y border-amber/30 cursor-grab active:cursor-grabbing"
          style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
          onMouseDown={(e) => handleMouseDown(e, "center")}
        />

        {/* Left handle */}
        <div
          className="absolute top-0 bottom-0 w-1.5 bg-amber/60 cursor-ew-resize hover:bg-amber/80 rounded-l-sm"
          style={{ left: `${leftPct}%` }}
          onMouseDown={(e) => handleMouseDown(e, "left")}
        />

        {/* Right handle */}
        <div
          className="absolute top-0 bottom-0 w-1.5 bg-amber/60 cursor-ew-resize hover:bg-amber/80 rounded-r-sm"
          style={{ left: `calc(${rightPct}% - 6px)` }}
          onMouseDown={(e) => handleMouseDown(e, "right")}
        />
      </div>
    </div>
  );
}
