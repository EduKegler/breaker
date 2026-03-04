import { ema, rsi, atr } from "@breaker/backtest";
import type { StrategyContext, CandleInterval } from "@breaker/backtest";

export interface ConditionResult {
  passed: boolean;
  value: number;
  threshold: number;
}

export interface DiagnoseResult {
  conditions: Record<string, ConditionResult>;
  indicators: Record<string, number>;
}

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

function diagnoseEmaPullback(ctx: StrategyContext): DiagnoseResult {
  const { candles, index, currentCandle, higherTimeframes } = ctx;
  const indicators: Record<string, number> = {};
  const conditions: Record<string, ConditionResult> = {};

  const close = currentCandle.c;
  const prevClose = index > 0 ? candles[index - 1].c : NaN;
  indicators.close = close;
  indicators.prevClose = prevClose;
  indicators.index = index;

  // Compute source-TF indicators
  const closes = candles.map((c) => c.c);
  const emaFastArr = ema(closes, 9);
  const emaSlowArr = ema(closes, 21);
  const rsiArr = rsi(closes, 7);

  const currEmaFast = emaFastArr[index] ?? NaN;
  const prevEmaFast = emaFastArr[index - 1] ?? NaN;
  const currEmaSlow = emaSlowArr[index] ?? NaN;
  const currRsi = rsiArr[index] ?? NaN;

  indicators.emaFast = currEmaFast;
  indicators.prevEmaFast = prevEmaFast;
  indicators.emaSlow = currEmaSlow;
  indicators.rsi = currRsi;

  // 4H EMA 21 (completed bar only)
  const htf4h = higherTimeframes["4h"] ?? [];
  let ema21_4h = NaN;
  if (htf4h.length >= 22) {
    const htf4hEma = ema(htf4h.map((c) => c.c), 21);
    for (let j = htf4h.length - 1; j >= 0; j--) {
      if (htf4h[j].t + MS_4H <= currentCandle.t && !isNaN(htf4hEma[j])) {
        ema21_4h = htf4hEma[j];
        break;
      }
    }
  }
  indicators.ema21_4h = ema21_4h;

  // 1H ATR 14 (completed bar only)
  const htf1h = higherTimeframes["1h"] ?? [];
  let atr1h = NaN;
  if (htf1h.length >= 15) {
    const htfAtr = atr(htf1h, 14);
    for (let j = htf1h.length - 1; j >= 0; j--) {
      if (htf1h[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
        atr1h = htfAtr[j];
        break;
      }
    }
  }
  indicators.atr1h = atr1h;

  // Skip condition evaluation if core indicators are NaN
  if (isNaN(ema21_4h) || isNaN(atr1h) || isNaN(currEmaFast) || isNaN(currRsi)) {
    return { conditions, indicators };
  }

  // LONG conditions
  conditions["L:regime_4h_bull"] = { passed: close > ema21_4h, value: close, threshold: ema21_4h };
  conditions["L:prev_below_emaFast"] = { passed: prevClose < prevEmaFast, value: prevClose, threshold: prevEmaFast };
  conditions["L:close_above_emaFast"] = { passed: close > currEmaFast, value: close, threshold: currEmaFast };
  conditions["L:close_above_emaSlow"] = { passed: close > currEmaSlow, value: close, threshold: currEmaSlow };
  conditions["L:rsi_above_oversold"] = { passed: currRsi > 40, value: currRsi, threshold: 40 };

  // SHORT conditions
  conditions["S:regime_4h_bear"] = { passed: close < ema21_4h, value: close, threshold: ema21_4h };
  conditions["S:prev_above_emaFast"] = { passed: prevClose > prevEmaFast, value: prevClose, threshold: prevEmaFast };
  conditions["S:close_below_emaFast"] = { passed: close < currEmaFast, value: close, threshold: currEmaFast };
  conditions["S:close_below_emaSlow"] = { passed: close < currEmaSlow, value: close, threshold: currEmaSlow };
  conditions["S:rsi_below_overbought"] = { passed: currRsi < 60, value: currRsi, threshold: 60 };

  return { conditions, indicators };
}

export function diagnoseSignal(
  ctx: StrategyContext,
  strategyName: string,
  _interval: CandleInterval | string,
): DiagnoseResult {
  if (strategyName === "ema-pullback") {
    return diagnoseEmaPullback(ctx);
  }

  // Basic diagnostics for unknown strategies
  return {
    conditions: {},
    indicators: {
      close: ctx.currentCandle.c,
      index: ctx.index,
    },
  };
}
