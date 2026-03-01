import type { Time } from "lightweight-charts";
import type { CandleData } from "../types/api.js";

/**
 * Offset in seconds between UTC and the local timezone.
 * For UTC-3 (BRT): getTimezoneOffset() = 180 min → 10800 sec.
 * Subtracting shifts chart display to local time.
 */
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * 60;

export function toChartTime(ms: number): Time {
  return (ms / 1000 - TZ_OFFSET_SEC) as Time;
}

/** Reverse: convert chart time back to real UTC seconds */
export function chartTimeToUtcSec(chartSec: number): number {
  return chartSec + TZ_OFFSET_SEC;
}

export function toOhlcData(c: CandleData) {
  return {
    time: toChartTime(c.t),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  };
}

export function toOhlcvData(c: CandleData) {
  return {
    time: toChartTime(c.t),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volume: c.v,
  };
}
