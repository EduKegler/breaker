import { ema } from "./ema.js";

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/**
 * MACD (Moving Average Convergence Divergence).
 * - macdLine = EMA(close, fastPeriod) - EMA(close, slowPeriod)
 * - signalLine = EMA(macdLine, signalPeriod)
 * - histogram = macdLine - signalLine
 *
 * Returns arrays of the same length as input.
 * First `slowPeriod - 1` values of macd are NaN.
 * First `slowPeriod - 1 + signalPeriod - 1` values of signal/histogram are NaN.
 */
export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const len = values.length;
  if (len === 0) return { macd: [], signal: [], histogram: [] };

  const fastEma = ema(values, fastPeriod);
  const slowEma = ema(values, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    macdLine[i] =
      !isNaN(fastEma[i]) && !isNaN(slowEma[i])
        ? fastEma[i] - slowEma[i]
        : NaN;
  }

  // Signal line = EMA of MACD line (only over the defined portion)
  // We need to feed the EMA only the non-NaN macd values,
  // then map back to the original indices.
  const definedStart = macdLine.findIndex((v) => !isNaN(v));
  const signalLine = new Array<number>(len).fill(NaN);
  const histogramLine = new Array<number>(len).fill(NaN);

  if (definedStart === -1) {
    return { macd: macdLine, signal: signalLine, histogram: histogramLine };
  }

  const macdDefined = macdLine.slice(definedStart);
  const signalEma = ema(macdDefined, signalPeriod);

  for (let i = 0; i < macdDefined.length; i++) {
    const idx = definedStart + i;
    signalLine[idx] = signalEma[i];
    histogramLine[idx] =
      !isNaN(macdLine[idx]) && !isNaN(signalEma[i])
        ? macdLine[idx] - signalEma[i]
        : NaN;
  }

  return { macd: macdLine, signal: signalLine, histogram: histogramLine };
}
