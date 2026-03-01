import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import type { RefObject } from "react";
import type { CandleData } from "../types/api.js";
import { toChartTime, toOhlcData } from "./to-chart-time.js";

export interface UseChartCandlesOptions {
  coin: string;
  candles: CandleData[];
  chartRef: RefObject<IChartApi | null>;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  volumeSeriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  legendRef: RefObject<HTMLDivElement | null>;
  loadingRef: RefObject<boolean>;
  isLive: boolean;
}

export function useChartCandles(opts: UseChartCandlesOptions): void {
  const prevCandlesLenRef = useRef(0);
  const prevFirstTRef = useRef(0);
  const prevCoinRef = useRef(opts.coin);

  useEffect(() => {
    if (!opts.seriesRef.current || opts.candles.length === 0) return;

    const coinChanged = prevCoinRef.current !== opts.coin;

    const isIncremental =
      !coinChanged &&
      prevCandlesLenRef.current > 0 &&
      opts.candles.length >= prevCandlesLenRef.current &&
      opts.candles.length <= prevCandlesLenRef.current + 1 &&
      opts.candles[0]?.t === prevFirstTRef.current;

    prevCoinRef.current = opts.coin;
    prevCandlesLenRef.current = opts.candles.length;
    prevFirstTRef.current = opts.candles[0]?.t ?? 0;

    if (isIncremental) {
      // WS tick: update/append only the last candle (O(1))
      const last = opts.candles[opts.candles.length - 1];
      opts.seriesRef.current.update({
        time: toChartTime(last.t),
        open: last.o,
        high: last.h,
        low: last.l,
        close: last.c,
      });
      // Update volume bar
      if (opts.volumeSeriesRef.current) {
        opts.volumeSeriesRef.current.update({
          time: toChartTime(last.t),
          value: last.v,
          color: last.c >= last.o ? "rgba(0,255,136,0.3)" : "rgba(255,51,102,0.3)",
        } as Parameters<typeof opts.volumeSeriesRef.current.update>[0]);
      }
    } else {
      // Full dataset: init, coin switch, load more.
      // Block lazy-load during setData → scrollToRealTime to prevent the
      // range-change event from firing loadMoreCandles before scroll.
      opts.loadingRef.current = true;
      opts.seriesRef.current.setData(opts.candles.map(toOhlcData));
      // Set full volume data
      if (opts.volumeSeriesRef.current) {
        opts.volumeSeriesRef.current.setData(
          opts.candles.map((c) => ({
            time: toChartTime(c.t),
            value: c.v,
            color: c.c >= c.o ? "rgba(0,255,136,0.3)" : "rgba(255,51,102,0.3)",
          })),
        );
      }
      if (opts.isLive) {
        opts.chartRef.current?.timeScale().scrollToRealTime();
      }
      if (opts.legendRef.current) opts.legendRef.current.textContent = "";
      setTimeout(() => { opts.loadingRef.current = false; }, 500);
    }
  }, [opts.coin, opts.candles, opts.isLive]);
}
