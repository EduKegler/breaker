import type { Candle } from "../types/candle.js";

export interface DonchianResult {
  upper: number[];
  lower: number[];
  mid: number[];
}

/**
 * Monotonic deque for O(n) sliding-window max/min.
 * Maintains two deques: one for max (decreasing front-to-back),
 * one for min (increasing front-to-back).
 * Handles NaN by skipping invalid values entirely.
 */
class SlidingWindowMinMax {
  // Each deque stores [index, value] pairs
  private maxDeque: [number, number][] = [];
  private minDeque: [number, number][] = [];
  private maxHead = 0;
  private minHead = 0;

  push(index: number, hiValue: number, loValue: number): void {
    // Max deque (for highs): maintain decreasing order
    if (!isNaN(hiValue)) {
      while (this.maxHead < this.maxDeque.length &&
             this.maxDeque[this.maxDeque.length - 1][1] <= hiValue) {
        this.maxDeque.pop();
      }
      this.maxDeque.push([index, hiValue]);
    }

    // Min deque (for lows): maintain increasing order
    if (!isNaN(loValue)) {
      while (this.minHead < this.minDeque.length &&
             this.minDeque[this.minDeque.length - 1][1] >= loValue) {
        this.minDeque.pop();
      }
      this.minDeque.push([index, loValue]);
    }
  }

  evict(expiredBefore: number): void {
    while (this.maxHead < this.maxDeque.length &&
           this.maxDeque[this.maxHead][0] < expiredBefore) {
      this.maxHead++;
    }
    while (this.minHead < this.minDeque.length &&
           this.minDeque[this.minHead][0] < expiredBefore) {
      this.minHead++;
    }
  }

  getMax(): number {
    return this.maxHead < this.maxDeque.length
      ? this.maxDeque[this.maxHead][1]
      : NaN;
  }

  getMin(): number {
    return this.minHead < this.minDeque.length
      ? this.minDeque[this.minHead][1]
      : NaN;
  }
}

/**
 * Donchian Channel — highest high and lowest low over `period` bars.
 * Returns arrays of the same length as candles.
 * First `period - 1` values are NaN.
 *
 * Uses a monotonic deque for O(n) time complexity instead of O(n*period).
 */
export function donchian(candles: Candle[], period: number): DonchianResult {
  const len = candles.length;
  if (len === 0) return { upper: [], lower: [], mid: [] };
  if (period < 1) throw new Error("Donchian period must be >= 1");

  const upper = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  const mid = new Array<number>(len).fill(NaN);

  const window = new SlidingWindowMinMax();

  for (let i = 0; i < len; i++) {
    window.push(i, candles[i].h, candles[i].l);

    if (i >= period - 1) {
      // Evict elements outside the window [i - period + 1, i]
      window.evict(i - period + 1);

      const hi = window.getMax();
      const lo = window.getMin();
      upper[i] = hi;
      lower[i] = lo;
      mid[i] = !isNaN(hi) && !isNaN(lo) ? (hi + lo) / 2 : NaN;
    }
  }

  return { upper, lower, mid };
}
