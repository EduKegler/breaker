import type { Candle } from "../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../types/strategy.js";
import { keltner, type KeltnerResult } from "../indicators/keltner.js";
import { rsi } from "../indicators/rsi.js";
import { sma } from "../indicators/sma.js";
import { atr } from "../indicators/atr.js";

const MS_1H = 3_600_000;

export interface KeltnerRsi2Params {
  kcMultiplier: StrategyParam;
  rsi2Long: StrategyParam;
  rsi2Short: StrategyParam;
  maxTradesDay: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: KeltnerRsi2Params = {
  kcMultiplier: { value: 2.0, min: 1.5, max: 3.0, step: 0.5, optimizable: true, description: "Keltner Channel multiplier" },
  rsi2Long: { value: 20, min: 10, max: 30, step: 5, optimizable: true, description: "RSI2 oversold threshold for longs" },
  rsi2Short: { value: 80, min: 70, max: 90, step: 5, optimizable: true, description: "RSI2 overbought threshold for shorts" },
  maxTradesDay: { value: 3, min: 2, max: 5, step: 1, optimizable: false, description: "Max trades per day" },
  timeoutBars: { value: 8, min: 4, max: 16, step: 2, optimizable: true, description: "Bars before timeout exit" },
};

/**
 * Keltner RSI2 mean-reversion strategy — TypeScript port of Pine Script.
 *
 * Entry: Close outside Keltner Channel + extreme RSI(2) + volume filter (shorts).
 * Exit: TP at KC mid (EMA20), SL at ATR×1.5, timeout at N bars.
 */
export function createKeltnerRsi2(
  paramOverrides?: Partial<Record<keyof KeltnerRsi2Params, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof KeltnerRsi2Params];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator caches (populated by init())
  let kcCache: KeltnerResult | null = null;
  let rsiCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;

  return {
    name: "BTC 15m Mean Reversion — Keltner RSI2",
    params,
    requiredTimeframes: ["1h"],

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const kcMult = params.kcMultiplier.value;
      kcCache = keltner(candles, 20, 20, kcMult);

      const closes = candles.map(c => c.c);
      rsiCache = rsi(closes, 2);

      const volumes = candles.map(c => c.v);
      volSmaCache = sma(volumes, 20);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 21) return null;

      const rsi2LongThresh = params.rsi2Long.value;
      const rsi2ShortThresh = params.rsi2Short.value;

      // Use pre-computed caches if available, otherwise compute on the fly
      const kcResult = kcCache ?? keltner(candles.slice(0, index + 1), 20, 20, params.kcMultiplier.value);
      const kcUpper = kcResult.upper[index];
      const kcLower = kcResult.lower[index];
      const kcMid = kcResult.mid[index];

      if (isNaN(kcUpper) || isNaN(kcLower) || isNaN(kcMid)) return null;

      // RSI(2)
      const rsiResult = rsiCache ?? rsi(candles.slice(0, index + 1).map(c => c.c), 2);
      const rsi2 = rsiResult[index];
      if (isNaN(rsi2)) return null;

      // Volume SMA(20)
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];

      // 1H ATR — only use COMPLETED bars (Pine: [1] with lookahead_on)
      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;

      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);

      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t) {
          if (!isNaN(htfAtr[j])) { atr1h = htfAtr[j]; break; }
        }
      }
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * 1.5;
      const close = currentCandle.c;

      // LONG: close below KC lower + RSI2 oversold (no EMA200 direction gate — matches Pine)
      if (close < kcLower && rsi2 < rsi2LongThresh) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [{ price: kcMid, pctOfPosition: 1.0 }],
          comment: "KC mean reversion long",
        };
      }

      // SHORT: close above KC upper + RSI2 overbought + volume spike (no EMA200 direction gate — matches Pine)
      if (
        close > kcUpper &&
        rsi2 > rsi2ShortThresh &&
        !isNaN(volAvg20) &&
        currentCandle.v > 1.5 * volAvg20
      ) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [{ price: kcMid, pctOfPosition: 0.6 }],
          comment: "KC mean reversion short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const timeoutBarsVal = params.timeoutBars.value;
      const barsInTrade = index - positionEntryBarIndex;

      if (barsInTrade >= timeoutBarsVal) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
    },
  };
}
