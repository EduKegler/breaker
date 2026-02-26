import { ADX as ADXIndicator } from "trading-signals";
import type { Candle } from "../types/candle.js";

export interface AdxResult {
  adx: number[];
  diPlus: number[];
  diMinus: number[];
}

/**
 * Average Directional Index (via trading-signals, Wilder's method).
 * Returns arrays of same length as candles.
 * DI+/DI- are available from index `period - 1`.
 * ADX is available from index `2 * period - 2`.
 */
export function adx(candles: Candle[], period: number): AdxResult {
  const len = candles.length;
  if (len === 0) return { adx: [], diPlus: [], diMinus: [] };
  if (period < 1) throw new Error("ADX period must be >= 1");

  const adxArr = new Array<number>(len).fill(NaN);
  const diPlusArr = new Array<number>(len).fill(NaN);
  const diMinusArr = new Array<number>(len).fill(NaN);

  const indicator = new ADXIndicator(period);

  for (let i = 0; i < len; i++) {
    indicator.add({ high: candles[i].h, low: candles[i].l, close: candles[i].c });

    if (indicator.pdi !== undefined) {
      diPlusArr[i] = Number(indicator.pdi) * 100;
    }
    if (indicator.mdi !== undefined) {
      diMinusArr[i] = Number(indicator.mdi) * 100;
    }
    if (indicator.isStable) {
      adxArr[i] = Number(indicator.getResult());
    }
  }

  return { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr };
}
