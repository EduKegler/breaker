import type { Time } from "lightweight-charts";
import type { CandleData } from "../types/api.js";

export function toChartTime(ms: number): Time {
  return (ms / 1000) as Time;
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
