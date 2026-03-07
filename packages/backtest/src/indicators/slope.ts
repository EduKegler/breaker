/**
 * Slope of a series over a lookback window.
 * slope[i] = series[i] - series[i - lookback].
 * Returns NaN where the lookback or the source value is unavailable.
 */
export function slope(series: number[], lookback: number): number[] {
  if (series.length === 0) return [];
  if (lookback < 1) throw new Error("slope lookback must be >= 1");

  const len = series.length;
  const result = new Array<number>(len).fill(NaN);

  for (let i = lookback; i < len; i++) {
    const cur = series[i];
    const prev = series[i - lookback];
    if (!isNaN(cur) && !isNaN(prev)) {
      result[i] = cur - prev;
    }
  }

  return result;
}
