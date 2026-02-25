# Optimization Log — BTC Donchian ADX

## Baseline (iter 0) — 2026-02-25
- **Strategy**: Dual Donchian Channel Breakout with ADX consolidation filter + EMA50 daily regime filter
- **Pine file**: `donchian-adx.pine`
- **Replaces**: Squeeze Release (archived — failed walk-forward PF 0.301)
- **Metrics**: PnL=-28.41 USD, Trades=72, WinRate=38.9%, PF=0.896, DD=11.29%
- **Long/Short split**: Longs 15t, WR=53%, PF=1.18, PnL=+7.91 | Shorts 57t, WR=35%, PF=0.84, PnL=-36.32
- **Exit breakdown**: DC Trail exits dominant, 0 margin calls (down from 2 pre-regime-filter)
- **Key observations**:
  - EMA50 daily regime filter fixed long toxicity (PF 0.29 → 1.18) by filtering longs in bear regime
  - Shorts degraded (PF 1.26 → 0.84) — hypothesis: dcSlow=50 too wide for bear breakdowns
  - DC Trail exit generates real edge. No fixed TP.
  - 0 margin calls (down from 2) — regime filter prevents oversized entries in wrong direction
- **Free variables (5)**: dcSlow=50, dcFast=20, adxThreshold=25, atrStopMult=2.0, maxTradesDay=3
- **Priority**: Sweep dcSlow (30-60, step 5) and dcFast (10-25, step 5) first — shorter channels may catch bear breakdowns faster

## Iteration 1 (loop 1/10, phase: refine) — 2026-02-25 15:44
- **Diagnostic**: PARAMETRIC — ATR safety stop triggered; 9 Short SL exits at 0% WR destroy -96.46 USD. atrMult trigger rule fires (96.46 > |totalPnL| 28.41).
- **Metrics**: PnL=-28.41 USD, Trades=72, WinRate=38.9%, PF=0.90, DD=11.3%
- **Change applied** (only 1): `atrStopMult` 2.0 → 2.5
- **Actual result**: PnL=-103.96 USD (DEGRADED), Trades=94, PF=0.692, DD=15.17%
- **Why it failed**: Wider stop didn't just convert SL→DC Trail. It also generated 22 new low-quality entries (72→94 trades) at worse prices. The increased trade count flooded in losers that overwhelmed any SL reduction benefit.
- **Verdict**: ROLLED BACK to atrStopMult=2.0
- **Next steps**: atrStopMult 2.5 failed → pivot to dcSlow 35 (signal quality, not SL width). Pending hypothesis from rank#2.
