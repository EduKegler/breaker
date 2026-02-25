# Optimization Log — BTC Mean Reversion (Keltner RSI2)

## History Summary

### Era 1: VWAP Sigma + RSI(14) — iters 1-20 (2026-02-24)
- Asia-session VWAP fade with RSI(14) confirmation
- Exhausted all parametric levers after 20 iterations
- Core failures: Asia-only window capped trades at ~36/year; RSI(14) quality boundary; ATR(1H) SL vs VWAP TP created adverse R:R
- Final state: PnL=+11.92, Trades=61, PF=1.24, DD=3.0% (best iter 19, but below criteria)

### Era 2: Keltner RSI2 restructure — iter 21 research (2026-02-24)
- Replaced VWAP sigma with Keltner Channel EMA(20) ± 2×ATR(14)
- Replaced RSI(14) with RSI(2) for 20× signal frequency
- Replaced Asia-only with 24/7 trading
- Added volume filter on shorts, EMA200 1H regime (later removed)
- KC midline as TP target, ATR(1H)×1.5 as SL

### Era 2 iterations 21-28 (2026-02-25) — INVALIDATED
- ~40 log entries across two loop cycles (5-loop and 10-loop)
- **Reason for invalidation**: recurring FILE PERSISTENCE bug — the orchestrator logged "changes applied" but the .pine file was never actually modified in most iterations. Backtest results reflect the unchanged baseline, not the proposed changes. Iteration numbering also broke (multiple entries sharing same global iter number).
- Last reliable backtest from this era (baseline, no changes applied): **PnL=-49.27, Trades=128, WR=50.8%, PF=0.86, DD=9.3%**
- Key insights extracted before invalidation:
  - ATR(1H) × 1.5 SL vs KC mid TP creates ~0.33:1 R:R (breakeven WR=75%) — structural problem
  - consecLosses<2 caused trade blockade (128→7 trades when SL tightened)
  - Short TP2 (40% remainder after TP1) had 0% WR, -$12.95 — pure loss bucket
  - Volume filter on shorts improved short WR from 23.9%→41.4%
  - EMA200H direction gate: longs WR=77.8% with filter (9 trades), but created 83% short bias in test period

---

## Current Baseline — needs backtest validation

**Pine state** (`keltner-rsi2.pine` as of 2026-02-25):

| Parameter | Value | Notes |
|-----------|-------|-------|
| kcMultiplier | 2.0 | Free variable |
| rsi2Long | 20 | Free variable |
| rsi2Short | 80 | Free variable |
| maxTradesDay | 3 | Free variable |
| timeoutBars | 8 | Free variable |
| riskTradeUsd | 10.0 | Structural |
| cooldownBars | 4 | Structural |
| dailyLossUsd | 20.0 | Structural |
| stopDist | ATR(1H) × 1.5 | SL from 1H ATR via request.security |
| consecLosses guard | < 3 | Changed from <2 (was causing blockade) |
| Long exit | 100% at KC mid + SL | Single TP |
| Short exit | TP1 60% at KC mid + SL, TP2 40% SL-only | Split exit |
| Short volume gate | volume > 1.5 × SMA(20) | Quality filter |
| EMA200H | Plotted only, no entry gate | Removed from signals |

**Last known metrics** (from baseline before TP1 60% and consecLosses<3 changes):
- PnL=-49.27 USD, Trades=128, WR=50.8%, PF=0.86, DD=9.3%

**Pending validation**: TP1 60% split + consecLosses<3 have NOT been backtested yet.

**Known structural issues** (from invalidated era, but analysis is sound):
1. ATR(1H) × 1.5 SL vs KC mid TP → adverse R:R (~0.33:1). Switching to ATR(15m) or reducing multiplier would improve R:R.
2. Short TP2 (40% after TP1) historically had 0% WR — may still be a pure loss bucket even at 40%.
3. EMA200H direction gate dramatically improved long quality but killed trade count in bear-biased periods.
