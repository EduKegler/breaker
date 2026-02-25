# BTC 15m Trading Knowledge Base

> **Version:** 3.0 (living document)
> **Last updated:** 2026-02-25
> **Sources:** Cross-research (Claude, GPT, Gemini, Grok) + previous runs (unverified) + papers/articles
> **Tool:** BREAKER (loop: test -> analyze -> research -> improve -> test)

---

## Core Philosophy

**Less is more.** Simple strategies with few variables outperform complex ones out of sample. Each added rule improves the backtest but likely worsens real results. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness), [source](https://www.quantifiedstrategies.com/simple-vs-complex-trading-strategies/))

**Multiple simple strategies > one complex strategy.** Run separate modules for each market regime. Each module is simple on its own; sophistication comes from the combination. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness))

**Knowing when NOT to trade is as important as trading.** Fewer trades, more selective = better results.

---

## BREAKER Integration

### BREAKER Improvements (2026-02-25)

4 gaps identified during Donchian optimization and fixed:

| Gap | Problem | Fix | Location |
|-----|---------|-----|----------|
| 1. No axis priority | Optimized atrStopMult (secondary) before dcSlow/dcFast (core). Declared axis "exhausted" after 2 values | `coreParameters` per strategy profile. Core params tested FIRST with full range sweep, regardless of diagnostic triggers | build-optimize-prompt.ts, breaker-config.json |
| 2. No spec validation | DI filter was in design but not in .pine. BREAKER optimized 7 iterations of incomplete strategy | `designChecklist` validated before iteration 1. All spec components must be implemented before optimization starts | build-optimize-prompt.ts |
| 3. Day-of-week overfit | BREAKER blocked Wednesday/Monday based on PnL -- classic overfit. Guardrail allowed up to 3 days | Day-of-week blocking FORBIDDEN in prompt. No exceptions | build-optimize-prompt.ts (guardrails) |
| 4. Incomplete range sweep | atrStopMult tested 2.0 and 2.5, declared "exhausted". Should test full range (1.5-3.5 step 0.5) | Explicit rule: axis only exhausted when full min/max/step range explored | build-optimize-prompt.ts |

**Bug fixed:** `backfillLastIteration()` in param-writer.ts. Failed iterations were not recorded in parameter-history.json, causing infinite loop (same change attempted repeatedly after rollback).

### What BREAKER already handles well
- Multi-objective score with complexity factor and sample confidence -> naturally penalizes overfit
- 1 change per iteration (soft enforcement via prompt in `build-optimize-prompt.ts`) -> controlled evolution
- Phases (refine -> research -> restructure) -> only scales complexity when stalled
- Automatic rollback to best checkpoint -> does not degenerate
- Content token + freshness guard -> results are from the correct script
- Guardrails prevent forbidden changes (protected fields, max risk)
- Simplified walk-forward in `parse-results.ts` (70/30 split, hourly consistency)
- Research phase with WebSearch + Claude when stalled

### BREAKER Capabilities

| Capability | Status | Monitor on first loop |
|------------|--------|---------------------------|
| Multi-objective score | `scoring.ts` | -- |
| Variable gate | MR: max 5, Breakout: max 8. Rejects +2/iteration | Does regex `countPineInputs` cover all patterns? |
| Walk-forward + overfit flag | pfRatio < 0.6 -> warning | Flag active? (needs >= 10 trades in split) |
| Strategy profiles | `"strategy": "mean-reversion"` | Asset configured correctly? |
| Session breakdown | Asia/London/NY/Off-peak | Do data match the module's expectation? |
| Automatic rollback | Checkpoint | -- |
| Phases refine -> research -> restructure | Implemented | Does research introduce too much complexity? |

### MR Criteria: Strategy Profile `mean-reversion`

Activated when the asset is configured with `"strategy": "mean-reversion"`.

```json
{
  "mean-reversion": {
    "minPF": 1.4,
    "maxDD": 8
  }
}
```

**Rationale:**
- **PF 1.4** (not 1.8 default): MR has smaller spreads between wins and losses. With ~20% degradation backtest->live, PF 1.4 -> ~1.12 live. Real margin, not break-even
- **DD 8%** (not 4% default): MR in crypto will have larger drawdowns in loss clusters. 4% would force artificial filters

### Walk-Forward Validation

**Automatic:** 70/30 split on exported trades. If `pfRatio < 0.6`, sets `overfitFlag: true` and the prompt displays a warning.

**Limitations:**
- TradingView runs the backtest over the entire period -- the loop indirectly optimizes over the 30% "test" data
- The flag only activates with >= 10 trades in the WF split. MR in the Asian session may have few trades in short periods

**Manual post-loop validation (5 min, recommended):**

```
When the loop converges:
1. Note the backtest period (e.g.: Jan 1 - Sep 30)
2. In TradingView, run the final strategy on a new period (Oct 1 - Dec 31)
3. If PF_new >= PF_loop x 0.6 -> validated
4. If PF_new < PF_loop x 0.6 -> overfit, discard
```

### Variable Gate

Refine does not accept +2 variables per iteration. `maxFreeVariables` limits by profile: MR = 5, Breakout = 8. Count via `countPineInputs` (regex on `input()` declarations).

**Monitor:** The regex may not cover assignment patterns without `input()` (hardcoded constants that act as hidden variables). Check on the first loop whether the count matches manual inspection.

### Session Breakdown

`parse-results.ts` generates Asia/London/NY/Off-peak with count, WR, PF, PnL. The prompt shows it to Claude.

**Sanity validation:**
- MR: operates 24/7, validate that PF is consistent across sessions (not dependent on one specific session)
- Breakout with high PF in London/NY and low PF in Asia = **correct**
- If reversed = suspicious logic

### Stopping criteria per strategy type (implemented in BREAKER)

| Metric | Mean Reversion | Breakout | Trend Continuation | Trend Following | Reversal |
|---------|---------------|----------|-------------------|-----------------|----------|
| **PF** | >= 1.4 | >= 1.6 | >= 1.6 | >= 1.6 | >= 1.8 |
| **DD** | <= 8% | <= 6% | <= 6% | <= 8% | <= 6% |
| **WR** | >= 50% | >= 40% | >= 45% | >= 35% | >= 35% |
| **Trades** | >= 80 | >= 50 | >= 50 | >= 40 | >= 40 |
| **PnL** | > 0 | > 0 | > 0 | > 0 | > 0 |
| **WF pfRatio** | >= 0.6 | >= 0.6 | >= 0.6 | >= 0.6 | >= 0.6 |

**Estimated degradation backtest -> live:**

| Type | Min PF | Degradation | Estimated live PF |
|------|--------|-----------|-----------------|
| MR | 1.4 | ~20% | ~1.12 |
| Breakout | 1.6 | ~30% | ~1.12 |
| TC | 1.6 | ~25% | ~1.20 |
| TF | 1.6 | ~30% | ~1.12 |
| Reversal | 1.8 | ~35% | ~1.17 |

> All stay above PF 1.1 live in pessimistic scenario. Real margin, not break-even. MR degrades less (frequent trades, predictable fills). Reversal degrades more (fills at extremes, small sample).

### Limits per run (implemented)

- **Max free variables:** MR = 5, Breakout = 8, TC/TF/Reversal = 8 (hard gate in refine -- rejects +2 per iteration)
- **Max iterations per strategy:** defined in config (recommendation: 15)
- **Walk-forward:** 70/30 split + pfRatio + automatic overfitFlag (>= 10 trades)
- **Session breakdown:** Asia/London/NY/Off-peak with count, WR, PF, PnL in prompt
- **Include real costs:** commission 0.045% (Hyperliquid taker) + slippage 2 ticks in Pine

### Red flags in backtest

- [ ] PF > 3.0 -> probably overfit
- [ ] Sharpe > 3.0 -> probably overfit
- [ ] DD < 1% -> probably overfit
- [ ] Performance depends on 1-2 specific hours -> fragile (session breakdown helps spot this)
- [ ] Removing 1 variable destroys the result -> overfit on that variable
- [ ] Win rate > 80% -> something is wrong (look-ahead bias?)
- [ ] `overfitFlag: true` (pfRatio < 0.6) -> overfit confirmed by BREAKER
- [ ] Score increasing but trades decreasing drastically -> filtering until it finds noise
- [ ] MR with PF concentrated in 1-2 sessions -> fragile edge, should be consistent 24/7
- [ ] Breakout with high PF in Asia -> edge in the wrong place, suspicious logic

---

## Concerns and Real Risks (Claude's opinion)

These are my concerns that are not consensus among the other AIs, but that I consider important enough to document. Some are technical, others are structural.

### 1. Mean Reversion in crypto != Mean Reversion in equities

Most MR literature comes from equities and forex, where mean reversion is a well-documented phenomenon (especially in pairs and ETFs). Crypto is different:
- BTC can trend for weeks without reverting (bull runs, liquidation cascades)
- There is no clear "fundamental value" for the price to "revert" to
- Session VWAP is a fragile anchor -- if the price opened with a gap, the VWAP already starts displaced

**Real risk:** MR in BTC may simply not have enough edge to be consistent. The 60-68% WR that Grok reported may come from dubious quality sources.

**Mitigation:** That is why we will test first. If BREAKER cannot achieve PF >= 1.4 in 15 iterations with realistic criteria, the honest answer is: MR on 15m BTC does not work well enough. And that is a valid result -- knowing that something does not work saves money.

### 2. Consensus bias from the 4 AIs

The 4 AIs (Claude, GPT, Gemini, Grok) agree on a lot. This seems good, but it could be shared bias:
- All were trained on similar data (trading blogs, indicator documentation, same papers)
- If all learned from the same 50 blog posts about "Bollinger Band mean reversion," the consensus is not independent evidence -- it is an echo of the same source
- None of them actually tested. All are reasoning about what "should" work

**Real risk:** The entire knowledge base may be based on conventional wisdom that does not survive rigorous backtesting.

**Mitigation:** BREAKER is the final judge, not the AIs. If backtest numbers contradict the consensus of the 4 AIs, the numbers win. Always.

### 3. The Asian session may not be consistently range-bound

The argument is: "Asian session has lower volume, so BTC trades sideways, so MR works." But:
- Asia includes Korea, Japan, China -- which are enormous crypto markets
- Asian macro events (BOJ, China data, Korea regulation) can create violent trends during the "Asian session"
- The structure itself may be changing (more algo trading 24/7, less dependence on human sessions)

**Real risk:** The session edge may be weaker than it appears, or may be diminishing over time.

**Mitigation:** The session breakdown in parse-results will show whether the edge actually exists in Asia. If MR has similar PF across all sessions, the session filter is not adding value.

### 4. The TradingView backtester has real limitations

- **Does not model the order book.** In MR, you enter at extremes -- exactly where liquidity is lowest. The real fill may be worse than the backtest assumes.
- **Slippage is an estimate.** TradingView uses fixed or zero slippage. In BTC perp during Asian session (low liquidity), real slippage can be 2-5x the estimate.
- **15m candles hide microstructure.** A candle that "touched VWAP -2sigma and bounced back" may have been a 2-second wick that you would never catch with a real order.

**Real risk:** Pretty backtest -> ugly live trading. The backtest-live gap is larger in strategies that trade at extremes (like MR).

**Mitigation:** After BREAKER validates, do real paper trading for at least 2 weeks before committing capital. Paper trading with real orders (not backtest) reveals true slippage.

### 5. BREAKER's research phase may introduce noise

When BREAKER stalls and goes to the research phase, Claude searches the web. The problem: 90% of content about "trading strategies" online is junk. Affiliate blog posts, courses selling indicators, gurus with no verifiable track record.

**Real risk:** BREAKER imports a "new idea" from a bad blog, that idea adds 3 variables, the backtest improves due to overfit, and now the strategy has a layer of complexity based on blog wisdom.

**Mitigation:**
- When reviewing research phase output, verify: does the idea make logical sense? Or is it just "add indicator X because a blog said so"?
- Whitelist implemented in `research.ts`: domain on the list -> finding goes directly. Domain not on the list -> marked as `[UNVERIFIED SOURCE]` in the brief for Claude optimizer

**Trusted domain whitelist for research:**

**Tier 1 -- Academic / Papers**

| Domain | What it offers |
|---------|---------------|
| `arxiv.org` | Pre-print quantitative finance papers. Free access |
| `ssrn.com` | Academic finance papers. Strategies, overfit, microstructure |
| `scholar.google.com` | Paper aggregator. Cross-reference citations |
| `nber.org` | National Bureau of Economic Research. Macro and finance |
| `jstor.org` | Peer-reviewed articles. Partial free access |

**Tier 2 -- Quant / Data-driven (with backtest)**

| Domain | What it offers |
|---------|---------------|
| `quantifiedstrategies.com` | 1000+ articles with real backtests, no opinion. Crypto + equities |
| `quantpedia.com` | Database of 900+ strategies extracted from academic papers |
| `quantconnect.com` | Open source algo trading platform. Docs + research |
| `quantnomad.com` | Pine Script + backtest. Practical, with code |
| `quantra.quantinsti.com` | Quant courses + articles. Institutional |
| `robotwealth.com` | Professional quant trader blog. Articles with code and data |

**Tier 3 -- Technical / Tools**

| Domain | What it offers |
|---------|---------------|
| `tradingview.com/pine-script-docs` | Official Pine Script v6 documentation |
| `tradingview.com/pine-script-reference` | Complete API reference |
| `luxalgo.com/blog` | Articles on indicators, overfit, algo trading |
| `pinecoders.com` | Official Pine Script community. FAQ + best practices |

**Tier 4 -- Crypto-specific**

| Domain | What it offers |
|---------|---------------|
| `kaiko.com` | Institutional crypto market data. Liquidity and microstructure |
| `glassnode.com` | On-chain analytics. Flows, holders, network metrics |
| `coinalyze.net` | Open interest, funding, liquidations in real time |
| `laevitas.ch` | Crypto derivatives: funding rates, basis, options |
| `hyperliquid.gitbook.io` | Official Hyperliquid documentation. Fees, API, order types |

> **AVOID:** Sites that sell courses with "guaranteed results," exchange affiliate blogs, channels without backtests, forums without technical moderation, anything with "free signals" or "copy trading."

### 6. "Module 3: Do Not Trade" is the hardest to follow

Psychologically, it is much harder NOT to trade than to trade poorly. Especially when:
- BREAKER found a strategy that "works" in backtest
- You are looking at the chart and "see" a setup
- You had 2 losses and want to recover

**Real risk:** Ignoring Module 3 and trading in an uncertain regime, destroying the edge of the other 2 modules.

**Mitigation:** The BREAKER webhook (TradingView -> WhatsApp) is the solution. If the alert did not arrive, do not trade. No discretionary trading. The system decides, not the human.

### 7. Temporal overfit risk in BREAKER

BREAKER runs on TradingView with a fixed date range. If that range includes an atypical period (May 2025 crash, November rally, January chop), the strategy may be optimized for that specific regime.

**Real risk:** Strategy that works in "BTC chopping between 90k-100k" but breaks when BTC is in a strong trend from 100k->130k (or 90k->60k).

**Mitigation:**
- Use the longest possible range in TradingView (6+ months)
- Manual walk-forward on a different period (post-loop)
- If possible, test across 2-3 different regimes (one trending, one ranging, one mixed)

### 8. Accidental complexity via research + restructure

BREAKER's research and restructure phases are powerful but dangerous. Each can add indicators, filters, or change the structural logic. After 15 iterations going through refine -> research -> restructure -> refine..., the strategy may have accumulated 10+ variables without anyone noticing.

**Real risk:** Death by a thousand cuts. Each individual change seemed reasonable, but the accumulation is a fragile strategy with too many moving parts.

**Mitigation:** The `maxFreeVariables` gate (MR=5, Breakout=8) + rejection of +2/iteration in refine limits this. However, in `research` and `restructure` phases the gate is more permissive. Before declaring success, count the `input()` calls in the final Pine. If it exceeded the profile limit, simplify by removing those with the least impact (ablation test: remove 1 at a time and see which makes the least difference -> candidate to cut).

---

## Strategy Taxonomy

### Testable in BREAKER (Pine + TradingView + BTC 15m)

| Type | What it does | KB status | BREAKER profile |
|------|-------------|-----------------|-----------------|
| **Mean Reversion** | Price went too far from the mean, bets it comes back. Enters against the move. Works in sideways markets. | Module 2 (Keltner RSI2). PF 0.86, being optimized. | `mean-reversion` |
| **Breakout** | Price was compressed, bets the breakout generates directional movement. Enters at the explosion. | Module 1 (Donchian + ADX + EMA50 Daily). Baseline PF 0.896 with regime filter. BREAKER optimizing core params. | `breakout` |
| **Trend Continuation** | Trend already exists, waits for a temporary correction, enters on resumption. ABCD, flags, "buy the dip" at EMA. | Not tested. Future candidate. | `trend-continuation` |
| **Trend Following** | Follows the dominant direction without waiting for pullback. MA crossovers, supertrend. Better on higher timeframes. | Not tested as TF. Donchian is used as breakout (Module 1), not trend following. | `trend-following` |
| **Reversal** | Bets the entire trend is over and will reverse. Double top/bottom, RSI divergence. High risk. | Not tested. Sample size likely insufficient on 15m. | `reversal` |

### Not testable in BREAKER (need different infrastructure)

| Type | What it does | Why not |
|------|-------------|---------|
| **Scalping** | Micro-moves of 1-5 candles. Edge from low costs and speed. | Needs 1m/tick, maker-only, low latency. 15m does not work. |
| **Arbitrage** | Price difference between markets (spot vs perp, exchange A vs B). | Needs bots, APIs, low latency. Does not depend on indicators. |
| **Market Making** | Orders on both sides of the book, profits from spread. | Needs HFT, inventory management. Does not work in TradingView. |
| **Pairs / Stat Arb** | Two correlated assets diverge, bets they converge back. | Needs multiple simultaneous assets. Pine does not support well. |
| **Order Flow** | Reads order book, volume delta, footprint charts. | TradingView does not have order book data. |
| **Event-Driven** | Trades around events (FOMC, CPI, halving). | Edge is in the reaction, not indicators. Hard to backtest mechanically. |

### Current coverage vs gaps

```
TRENDING REGIME    ->  Module 1: Breakout (Donchian) -- captures START of the move
                       [GAP] Trend Continuation -- would capture MIDDLE of the move (pullbacks)
                       [GAP] Trend Following -- would capture DURATION of the move
RANGING REGIME     ->  Module 2: Mean Reversion (Keltner RSI2)
UNCERTAIN REGIME   ->  Module 3: Do not trade
```

> **Main gap:** In the trending regime, we only capture the birth of the move (Donchian breakout). If BTC is already trending and makes a healthy pullback, no module trades. Trend Continuation (e.g.: ABCD) is the natural candidate to fill this gap.

### Signal overlap between modules

When multiple modules are active, signals may coincide. This is not a problem -- it is confirmation.

**Same direction (confirmation):** Breakout (Donchian) goes long + TC also goes long = two independent systems agreeing on direction. More conviction.

**Opposite direction (conflict):** MR says short + Breakout says long. With MR operating 24/7, this can happen in London/NY. Simple rule: one position at a time. If already in a position, other module does not enter.

**No arbitration needed between modules.** Each trades in its own regime/session. Same-direction overlap reinforces the thesis.

### How to identify the regime (simple)

**Trending:**
- Price making HH/HL (up) or LH/LL (down)
- Increasing volume in the direction of the move
- Session: London or NY (08:00-20:00 UTC)

**Ranging:**
- Price ping-ponging between support and resistance
- Low / decreasing volume
- Session: Asia (23:00-08:00 UTC) typically

**Uncertain / Compression:**
- Neither is clear
- Active squeeze (BB inside KC)
- Session transition
- **-> DO NOT TRADE**

> **Note on ADX:** ADX is lagging by design -- when it confirms the market is ranging, the market may already be breaking out. ([source](https://www.avatrade.com/education/technical-analysis-indicators-strategies/adx-indicator-trading-strategies)) Use as ONE of the inputs, not as a single binary filter. Prefer price action (HH/HL) + volume as the first read.

---

## Backtest Period

| Use | Period | Reason |
|-----|---------|--------|
| **BREAKER loop (optimization)** | Last 6-9 months | Recent data, current market. ~35,000 candles on 15m = plenty of sample |
| **Manual walk-forward** | 2-3 months before the loop | Data the loop never touched |
| **Stress test (optional)** | Crash or extreme rally period | Not for optimization -- just to understand DD in extreme scenarios |

**Do not use the entire available history.** Pre-ETF BTC (before Jan/2024) is a structurally different market: liquidity, participants, correlations, and volatility have changed. Optimizing on 2021-2022 data pollutes the model with regimes that no longer exist.

**Do not use less than 6 months.** Risk of capturing only one regime (e.g.: only bull) and incorrectly concluding it works.

---

## Module 1: Momentum / Breakout

> **When:** Trending market, all sessions (24/7)
> **Objective:** Capture directional moves

### Base strategy: Donchian Channel Breakout + ADX + EMA50 Daily regime filter

**Selection history:** SQZ (Squeeze Release) was tested first. Short-only passed in-sample but failed walk-forward (-81% degradation, regime overfit). Donchian Channel selected as replacement: simpler (fewer params), works 24/7, trailing exit is structurally sound, and has academic evidence on BTC (QuantifiedStrategies 2025, QuantPedia 2024).

| Indicator | Parameter | Function |
|-----------|-----------|--------|
| Donchian Channel (slow) | dcSlow periods | Entry signal: new high/low breakout |
| Donchian Channel (fast) | dcFast periods | Exit signal: trailing channel stop |
| ADX | 14 periods | Consolidation filter: only enter when ADX < threshold |
| EMA50 Daily | 50-period EMA on daily TF | Regime filter: price > EMA = longs only, price < EMA = shorts only |

```
LONG:  close > DC_upper(slow) AND ADX < adxThreshold AND close > ema50daily
SHORT: close < DC_lower(slow) AND ADX < adxThreshold AND close < ema50daily
EXIT LONG:  close < DC_lower(fast) OR SL hit OR timeout
EXIT SHORT: close > DC_upper(fast) OR SL hit OR timeout
STOP:  ATR-based (atrStopMult, safety fallback)
```

> **Regime filter rationale:** Baseline showed shorts profitable (+$57, WR 42%) and longs toxic (-$230, WR 30%) in bearish/lateral period. Same pattern as SQZ. DI filter (same timeframe) was attempted first but is **redundant** with Donchian breakout -- when price makes 50-bar high, DI+ is already > DI- by definition. Any same-TF directional filter is tautological with breakout signals. EMA50 Daily provides an **independent** regime read from a higher timeframe. With 18 regime transitions in the backtest period (vs only 2 for EMA200 Daily), it has enough granularity to block counter-trend entries without being too slow.

### Free variables for BREAKER

Rule: max 8 free variables (breakout profile).

| # | Variable | Range | Function |
|---|----------|-------|----------|
| 1 | dcSlow | 30-60 | Donchian entry channel period |
| 2 | dcFast | 10-25 | Donchian exit channel period (trailing) |
| 3 | adxThreshold | 20-35 | Max ADX to allow entry (consolidation filter) |
| 4 | atrStopMult | 1.5-3.0 | ATR multiplier for safety stop |
| 5 | maxTradesDay | 2-5 | Daily trade limit |

**Total: 5 variables. EMA50 Daily regime filter is fixed (not optimized -- 18 transitions validated empirically).**

### BREAKER Results

| Run | Date | PF | WR | DD | Trades | PnL | Notes |
|-----|------|----|----|-----|--------|-----|-------|
| BTC-SQZ (L+S) | 2026-02-24 | 1.34 | 46.7% | 7.3% | 105 | +$106 | Original long+short version. Checkpoint saved |
| BTC-SQZ (S-only) | 2026-02-25 | 1.607 | 55% | 4.01% | 60 | +$74 | Short-only. Passed in-sample criteria by 0.007 PF |
| BTC-SQZ (S-only WF) | 2026-02-25 | 0.301 | 38.9% | 9.10% | 36 | -$83 | Walk-forward: FAILED. 81% degradation. Overfit confirmed |
| BTC-DC (pre-EMA50) | 2026-02-25 | 0.686 | 36.2% | 19.62% | 127 | -$172 | Donchian+ADX before regime filter. Superseded by +EMA50 row below |
| BTC-DC (+DI filter) | 2026-02-25 | 0.686 | 36.2% | 19.62% | 127 | -$172 | DI same-TF redundant with breakout. Zero trades filtered. Discarded (pre-EMA50) |
| BTC-DC (+EMA50 daily) | 2026-02-25 | 0.896 | 38.89% | 11.29% | 72 | -$28 | **Current baseline.** Regime filter works: longs PF 0.29->1.18, DD -43%, 0 margin calls. Shorts degraded PF 1.26->0.84 |

> **SQZ: discarded.** Short-only overfit (WF -81%). Edge was bearish drift, not breakout signal.
>
> **DI filter: discarded.** Same-timeframe DI is tautological with Donchian breakout -- when price makes N-bar high, DI+ is already elevated by definition. Zero trades filtered.
>
> **EMA50 Daily regime filter: working.** Eliminated 48 toxic longs (PF 0.29->1.18), removed margin calls, cut DD from 19.6%->11.3%. Shorts degraded (PF 1.26->0.84) -- likely because dcSlow=50 is too slow for bear breakdowns. BREAKER optimizing dcSlow/dcFast as core parameters (gaps fixed: strict axis priority, no day-of-week blocking, full range sweep, design checklist).

---

## Module 2: Mean Reversion

> **When:** Sideways market, all sessions (24/7)
> **Objective:** Capture returns to the mean

### Base strategy (Keltner RSI2)

**Restructured by BREAKER** from the original VWAP Sigma Fade. The restructure phase identified that Keltner Channels + RSI(2) generates cleaner signals than VWAP + RSI(14), and that restricting to the Asian session limited sample size without adding edge.

**Indicators:**

| Indicator | Parameter | Function |
|-----------|-----------|--------|
| Keltner Channels | EMA(20), mult | Reference bands for extremes |
| RSI(2) | 2 periods | Confirms exhaustion (ultra-sensitive, reacts fast) |

**Entry rules:**

```
LONG:
  - Price breaks below lower KC band
  - RSI(2) < 20

SHORT:
  - Price breaks above upper KC band
  - RSI(2) > 80
```

**Management:**

```
STOP:    ATR 1H x 1.5 (guardrail minAtrMult)
TP1:     KC mid (EMA 20) -> take 60%, move stop to BE
TIMEOUT: If TP1 not reached in 8 bars (2h), exit
```

**Operational limits:**
- Max 3 trades per day
- After 2 consecutive losses: shut down until next day

### Free variables for BREAKER to optimize

1. `kcMultiplier` -- KC band multiplier (current: 2.0)
2. `rsi2Long` -- RSI(2) threshold for long (current: 20)
3. `rsi2Short` -- RSI(2) threshold for short (current: 80)
4. `maxTradesDay` -- 1 to 5 (current: 3)
5. `timeoutBars` -- 4 to 16 (current: 8)

**Total: 5 variables. DO NOT add more.**

### BREAKER Results

| Run | Date | PF | WR | DD | Trades | PnL | Notes |
|-----|------|----|----|-----|--------|-----|-------|
| BTC-MR (VWAP) | 2026-02-24 | 1.27 | 56.6% | 2.9% | 83 | +$19 | Was VWAP Sigma Fade. Invalidated by restructure |
| BTC-MR (Keltner) | 2026-02-25 | 0.86 | 50.78% | 9.3% | 128 | -$49 | Baseline post-restructure. Being optimized |

> **Current state:** The VWAP -> Keltner RSI2 restructure invalidated previous results (including TP1 60% iterations from optimization log -- those were invalidated). Current baseline (PF 0.86, WR 50.78%) is below breakeven. BREAKER continues iterating. The hypothesis that ATR(1H) x 1.5 as stop creates adverse R:R (~0.33:1) against KC mid as TP is being investigated.

---

## Module 3: Do Not Trade

> **When:** Uncertain regime, extreme compression, session transition
> **Objective:** Preserve capital

### When NOT to trade

```
- Active squeeze (BB inside KC) without release yet
- Session transition (last 30min of one, first 30min of the next)
- ADX between 18-25 without clear direction (gray zone)
- After 2 consecutive losses in any module
- CPI, FOMC, NFP days (or any major macro event)
- Daily loss > 2R reached
```

**This is not weakness, it is discipline.** Overtrading usually destroys capital faster than losing on individual trades.

---

## Session Map (UTC)

| Session | UTC Time | Character | Module |
|--------|------------|---------|--------|
| Asia | 23:00 - 08:00 | Low vol, range | **Module 2** (MR) + potential **Module 1** (Breakout) |
| London | 08:00 - 13:00 | Expansion, breakouts | **Module 1** (Breakout) + **Module 2** (MR) |
| NY | 13:00 - 20:00 | Directional, maximum liquidity | **Module 1** (Breakout) + **Module 2** (MR) |
| Off-peak | 20:00 - 23:00 | Deceleration | **Module 3** (Do not trade) |

> **MR operates 24/7** after Keltner RSI2 restructure. No longer dependent on a specific session. Session breakdown continues monitoring to validate edge is consistent across sessions.

> **Breakout hours (old data -- not verified in current BREAKER):**
> Best: 07h, 10h, 19h, 22h UTC | Worst (= possible best MR): 02h, 03h UTC
> **Warning: Re-validate with new data in current BREAKER.**

---

## Risk Management (universal -- applies to all modules)

### Exchange: Hyperliquid (perps)

All trades are in perpetual contracts on Hyperliquid. No gas fees, only trading fees + funding.

| Fee | Tier 0 (base) | Tier 1 ($5M 14d vol) | Tier 2 ($100M) |
|-----|--------------|----------------------|----------------|
| **Taker** | 0.045% | 0.040% | 0.030% |
| **Maker** | 0.015% | 0.012% | 0.004% |

**Round trip (taker/taker):** 0.09% at Tier 0 = ~$85.50 per trade of 1 BTC at $95k.
**Round trip (maker/maker):** 0.03% at Tier 0 = ~$28.50 per trade of 1 BTC at $95k.

> **Impact on MR:** With fixed $ risk, tight stop = larger notional = more fees. Monitor `stopAtrMult` -- if too low, fees can dominate. Use limit orders (maker) when possible.

**In Pine Script, configure:**
```
commission_value = 0.045  // taker fee (conservative -- assumes worst case)
slippage = 2              // protectedField -- conservative to cover microstructure
```

**Funding rate:** Paid/received every hour. Not modeled in TradingView backtest. For MR (short trades of 1-2h), impact is minimal. For trend following (trades lasting hours/days), consider it.

### Sizing
- **Risk per trade:** 1% of capital (max 2% on A+ setup)
- **Calculation:** position = risk / stop distance

### Iron rules
- Stop on 1H ATR (via request.security), avoid 15m ATR on BTC. **Note:** in MR Keltner, ATR(1H) x 1.5 as stop vs KC mid as TP may create adverse R:R (~0.33:1). BREAKER is investigating whether stopAtrMult should be a free variable again
- Minimum R:R 1.5:1 (do not enter if stop is too large for the target to make sense)
- Hyperliquid fee (0.045% taker) included in every backtest
- Prefer limit orders (maker 0.015%) when possible to reduce cost
- No martingale. No averaging down. No revenge trading.

### Daily limits
- Max daily loss: 2R -> shut down for today
- Max daily trades: 5 across all modules (declarative/operational cap -- not enforced in code. Each module runs independently in TradingView with its own maxTradesDay. The global 5 is the ceiling; per-module caps of 3 are subordinate internal limits)
- 2 consecutive losses in the same module -> shut down that module until next session

---

## Pine v6 -- Technical Notes

### ATR 1H anti-repaint
```pine
atr1h = request.security(syminfo.tickerid, "60", ta.atr(14)[1], lookahead=barmerge.lookahead_on)
```

### Session tracking (archived -- was used by SQZ)
```pine
string tz = "America/New_York"
bool inAsia = not na(time(timeframe.period, "1800-0300:1234567", tz))
bool inNY   = not na(time(timeframe.period, "0930-1600:23456", tz))
bool asiaStart = inAsia and not inAsia[1]
```

### Keltner Channels + RSI(2) (MR)
```pine
[kcMid, kcUp, kcLo] = ta.kc(close, 20, kcMultiplier, true)
rsi2 = ta.rsi(close, 2)
bool longSignal  = close < kcLo and rsi2 < rsi2Long
bool shortSignal = close > kcUp and rsi2 > rsi2Short
```

### Donchian Channel + ADX + EMA50 Daily (Breakout)
```pine
// Donchian Channels
dcSlowUpper = ta.highest(high, dcSlow)
dcSlowLower = ta.lowest(low, dcSlow)
dcFastUpper = ta.highest(high, dcFast)
dcFastLower = ta.lowest(low, dcFast)

// ADX
[diPlus, diMinus, adxVal] = ta.dmi(14, 14)

// EMA50 Daily regime filter (anti-repaint)
ema50daily = request.security(syminfo.tickerid, "D", ta.ema(close, 50)[1], lookahead=barmerge.lookahead_on)
bool bullRegime = close > ema50daily
bool bearRegime = close < ema50daily

// Entry signals
bool longSignal  = close > dcSlowUpper[1] and adxVal < adxThreshold and bullRegime
bool shortSignal = close < dcSlowLower[1] and adxVal < adxThreshold and bearRegime

// Trailing exit via fast Donchian
bool longExit  = close < dcFastLower[1]
bool shortExit = close > dcFastUpper[1]
```

### Squeeze detection (SQZ -- archived, failed WF)
```pine
// ARCHIVED: SQZ short-only failed walk-forward (PF 0.301, -81% degradation)
[bbMid, bbUp, bbLo] = ta.bb(close, 20, 2.0)
[kcMid, kcUp, kcLo] = ta.kc(close, 20, 1.5, true)
bool squeezeOn = bbLo > kcLo and bbUp < kcUp
```

---

## BREAKER Implementation Order

### Phase 1 -- Validate the foundations (DONE)
1. [x] Module 2 (MR) -- VWAP Sigma Fade tested, restructured to Keltner RSI2
2. [x] Module 1 candidates -- SQZ won initially, failed WF. Replaced with Donchian+ADX+EMA50 Daily regime filter

### Phase 2 -- Refine (NOW)
3. [ ] Donchian + ADX + EMA50 Daily: BREAKER optimizing dcSlow/dcFast as core params. Baseline PF 0.896. Target: PF >= 1.6, DD <= 6%, trades >= 50
4. [ ] MR (Keltner RSI2): optimize from baseline PF 0.86. Investigate adverse R:R (stop ATR 1H x 1.5 vs TP KC mid)
5. [ ] Manual walk-forward validation on new period

### Phase 3 -- Integrate (after both validated)
6. [ ] Run both modules in parallel on the same period
7. [ ] Verify signal overlap: same direction = confirmation, opposite direction = one position at a time
8. [ ] Measure combined result (portfolio PF, combined DD)
9. [ ] Module 3 as filter: if no module gives a signal -> do not trade
10. [ ] Enforce 5 daily trades cap across modules (currently declarative -- per-module maxTradesDay=3 are independent in TV)
11. [ ] Macro blocks (CPI, FOMC, NFP)

### Phase 4 -- Expand coverage (after MR and Donchian validated)
12. [ ] Trend Continuation: code ABCD or pullback-to-EMA in Pine, test in BREAKER with `trend-continuation` profile
13. [ ] Trend Following: test alternatives to Donchian (supertrend, EMA crossover) -- may not work on 15m
14. [ ] Reversal: assess if sample size is viable on 15m before investing time

### Phase 5 -- Infra (future)
15. [ ] Automatic regime switcher (Python, not Pine)
16. [ ] Add more assets if desired (ETH, SOL -- same logic, different parameters)

---

## Pending Decisions

| # | Decision | Status |
|---|---------|--------|
| 1 | Module 1: Donchian + ADX + EMA50 Daily. Baseline PF 0.896. BREAKER optimizing dcSlow/dcFast (core params) | Optimizing. Shorts need dcSlow tuning. 4 BREAKER gaps fixed |
| 2 | MR (Keltner RSI2): optimize to PF 1.4 | Baseline PF 0.86. Investigating adverse R:R stop/TP |
| 3 | Trend Continuation: test ABCD after closing MR/Donchian? | Phase 4 -- fills trending gap |
| 4 | Days off | New data decides |

---

## Evolution Log

| Date | Action | Result | Next step |
|------|------|-----------|---------------|
| 2026-02-23 | Document created. Consolidation from 4 AIs. Old data marked as unverified. | KB v3 defined with 3 simple modules. | Adjust BREAKER. |
| 2026-02-23 | BREAKER updated: strategy profiles, variable gate, session breakdown, WF overfit flag. | 4/4 architecture gaps closed. Code + tests ok. | First real loop with Module 2 (MR). |
| 2026-02-23 | BREAKER: minAtrMult 1.5 in guardrails + commission_value 0.045 protected. MR Pine adjusted. | Fee gap closed. | Configure MR asset and run. |
| 2026-02-24 | First real loop: BTC-SQZ (10 iter) and BTC-MR (10 iter). | SQZ: PF 1.34, +$106. MR: PF 1.27, +$19. | Continue iterating both. |
| 2026-02-24 | Strategy taxonomy: 5 testable in BREAKER, 6 not testable. Gap identified: trend continuation (pullback) not covered. | KB now maps coverage vs gaps. ABCD candidate for Phase 4. | Close MR and SQZ first. |
| 2026-02-24 | Criteria revised per strategy type. MR 1.3->1.4, Breakout 1.8->1.6, new profiles: TC, TF, Reversal. Breakout trades 70->50. | All types guarantee PF >= 1.1 live with pessimistic degradation. | Update profiles in BREAKER config. |
| 2026-02-25 | MR restructured: VWAP Sigma Fade -> Keltner RSI2. Asia-only -> 24/7. Kill switch removed. VWAP results invalidated. | Keltner baseline: PF 0.86, 128 trades, DD 9.3%, PnL -$49. | Investigate adverse R:R (ATR 1H x 1.5 stop vs KC mid TP). Continue optimizing. |
| 2026-02-25 | SQZ short-only: backtest confirmed PF 1.607, passed criteria by 0.007. Walk-forward FAILED: PF 0.301, 81% degradation. | Regime overfit confirmed. Edge was bearish drift, not breakout signal. 92% profit from SessionEnd, TP lost money. | SQZ discarded. Switched to Donchian Channel breakout. |
| 2026-02-25 | Module 1 switched to Donchian Channel + ADX/DI filter. Baseline: PF 0.686, 127 trades, DD 19.6%. DC trail exit works (+$83), SL destroys (-$246). DI filter added to prevent counter-trend entries. | Shorts profitable (+$57), longs toxic (-$230) in bearish period. Same pattern as SQZ but with better exit mechanics. | BREAKER optimizing 5 variables. Watch if DI filter fixes long/short asymmetry. |
| 2026-02-25 | DI filter tested: zero trades filtered. Same-TF DI is redundant with Donchian breakout (tautological). | When price makes 50-bar high, DI+ already > DI- by definition. Any same-TF directional filter is redundant with breakout. | Need higher-TF regime filter instead. |
| 2026-02-25 | EMA50 Daily regime filter added. Longs: only when price > EMA50d. Shorts: only when price < EMA50d. 18 regime transitions (vs 2 for EMA200d). | PF 0.686->0.896 (+31%). Longs PF 0.29->1.18. DD 19.6%->11.3%. 0 margin calls. Shorts degraded PF 1.26->0.84. | BREAKER optimize dcSlow/dcFast to fix shorts. |
| 2026-02-25 | BREAKER 4 gaps identified and fixed: (1) core param priority -- dcSlow/dcFast first, not atrStopMult. (2) design checklist -- validate .pine matches spec before optimizing. (3) day-of-week blocking FORBIDDEN. (4) full range sweep required before declaring axis exhausted. Also fixed: param-history backfill on early exits (bug: failed iterations not recorded -> infinite loop). | Architecture is solid, problems were prompt/config level. All fixes in build-optimize-prompt.ts, breaker-config.json, param-writer.ts. | Re-run BREAKER with fixes on Donchian+EMA50 baseline. |
| 2026-02-25 | KB audit: 5 inconsistencies fixed. (1) BTC-DC baseline row clarified as pre-EMA50/superseded. (2) Consecutive losses standardized to 2 everywhere. (3) Daily 5-trade cap clarified as declarative/operational, not code-enforced. (4) Missing WR filled: breakout 38.89%, MR 50.78%. (5) MR "TP1 60% applied" removed (invalidated by optimization log). | KB consistency restored. | Align keltner-rsi2.pine consecutive loss gate to < 2. |

---

## Glossary

### Exchange

| Term | What it is |
|-------|---------|
| **Hyperliquid** | On-chain perp DEX with order book (CLOB). No gas fees, only trading fees + funding. 130+ perps. Taker 0.045%, maker 0.015% (Tier 0). High liquidity in BTC/ETH. |
| **Perp (Perpetual)** | Futures contract with no expiration date. Most common instrument for leveraged crypto trading. On Hyperliquid, no gas, on-chain settlement. |
| **Taker fee** | Fee charged when your order executes immediately against the book (market order or limit that crosses). On Hyperliquid: 0.045% base. |
| **Maker fee** | Fee charged when your order sits on the book waiting to be filled (limit order). On Hyperliquid: 0.015% base. Can become a negative rebate at higher tiers. |
| **Funding rate** | Periodic payment (every hour on Hyperliquid) between longs and shorts to keep the perp price close to spot. Positive = longs pay shorts. |
| **Slippage** | Difference between the expected price and the actual execution price. Lower in BTC/ETH (high liquidity), higher in altcoins. |

### Market Concepts

| Term | What it is |
|-------|---------|
| **Mean Reversion (MR)** | Strategy that bets the price will return to a mean after moving too far away. E.g.: if BTC dropped too fast below VWAP, buy expecting it to come back. The opposite of trend following. |
| **Breakout** | When price breaks through a support or resistance level and continues in the direction of the break. Breakout strategy = enter at that moment. Does not need a prior trend. |
| **Trend Continuation (Pullback)** | Trend already exists, waits for a temporary correction, enters on resumption. ABCD, flags, "buy the dip" at EMA. Different from breakout: needs a prior trend. |
| **Trend Following** | Follows the dominant direction without waiting for pullback. MA crossovers, supertrend. Works in directional markets, fails in sideways markets. Better on higher timeframes. |
| **Reversal** | Bets the entire trend is over and will reverse. Double top/bottom, RSI divergence. Different from MR: MR expects return to mean within range, reversal expects structural direction change. |
| **Squeeze** | Period of volatility compression (price gets squeezed into a small range). Usually precedes a strong move. Detected when Bollinger Bands are inside Keltner Channels. |
| **Regime** | The current "mode" of the market: trending, ranging (sideways/chop), or compression. Each regime requires a different strategy. |
| **Chop / Choppy** | Market with no clear direction, with erratic moves up and down. Destroys trend strategies. |
| **Fade** | Trading against the move. "Fade the move" = if price went up too much, sell. Main action in mean reversion. |
| **Sweep / Wick** | Quick move that exceeds a level and comes back. Common in BTC -- the price "sweeps" stops and returns. |

### Technical Indicators

| Term | What it is |
|-------|---------|
| **VWAP** | Volume-Weighted Average Price. Volume-weighted average price of the session. Serves as the "fair price" for the period. When price is far above = expensive, far below = cheap. |
| **VWAP Bands (+/-sigma)** | Standard deviation bands around VWAP. +/-1sigma = 68% of prices stay within; +/-2sigma = 95%. Touching +/-2sigma = statistical extreme. |
| **Bollinger Bands (BB)** | Volatility bands around a moving average. Expand when volatility increases, contract when it decreases. Parameters: period (20) and deviations (2.0). |
| **Keltner Channels (KC)** | Similar to BB but uses ATR instead of standard deviation. Less sensitive to spikes. Used alongside BB to detect squeeze. |
| **RSI** | Relative Strength Index. 0-100 oscillator that measures the speed of price changes. RSI < 30 = oversold (possible reversal upward). RSI > 70 = overbought (possible reversal downward). |
| **Stochastic** | Oscillator that compares the closing price with the recent range. %K and %D are its lines. %K crossing above %D in the low zone = buy signal. |
| **ADX** | Average Directional Index. Measures trend STRENGTH (not direction). ADX < 20 = weak/sideways market. ADX > 25 = strong trend. It is lagging -- confirms after it has already happened. |
| **ATR** | Average True Range. Measures average volatility over N periods. Used to calculate stops and targets proportional to current volatility. 1H ATR is more reliable than 15m for BTC. |
| **EMA** | Exponential Moving Average. Moving average that gives more weight to recent data. EMA 9 reacts fast, EMA 50 reacts slowly. Crossover = possible trend change. |
| **SMA** | Simple Moving Average. Simple arithmetic average of N periods. SMA 200 is used as a macro reference (above = bullish, below = bearish). |
| **Donchian Channel** | Channel formed by the highest high and lowest low of N periods. Breaking through the channel = breakout signal. |

### Backtest Metrics

| Term | What it is |
|-------|---------|
| **Profit Factor (PF)** | Gross profit / gross loss. PF = 1.5 means for every $1 lost, you gained $1.50. PF < 1.0 = losing money. |
| **Win Rate (WR)** | % of trades that were profitable. High WR (60%+) is typical of MR; low WR (30-40%) is acceptable in trend following if R:R is high. |
| **Max Drawdown (DD)** | Largest peak-to-valley drop in equity. DD of 10% = at some point you were 10% below your best moment. The lower, the more comfortable to trade. |
| **R:R (Risk:Reward)** | Ratio between what you risk and what you expect to gain. R:R 2:1 = risk $100 to gain $200. |
| **1R** | One unit of risk. If your stop is $100, 1R = $100. TP of 1.5R = target of $150. |
| **Expectancy** | How much you expect to gain per trade on average. (WR x average gain) - ((1-WR) x average loss). Must be positive after costs. |
| **Walk-forward** | Validation method: optimize on one period, test on another that was never seen. Simulates real future performance. |
| **Overfit** | When the strategy adjusted so much to past data that it memorized noise instead of learning real patterns. Beautiful backtest, horrible live trading. |
| **pfRatio** | In BREAKER: test period PF / training period PF. If < 0.6, probably overfit. |

### Market Sessions

| Term | What it is |
|-------|---------|
| **Asian session (Asia)** | 23:00-08:00 UTC. Lower volume and volatility. Price tends to oscillate in range. Best for MR. |
| **London session** | 08:00-13:00 UTC. European liquidity. Breakouts and sweeps common. |
| **NY session** | 13:00-20:00 UTC. Highest volume in BTC. Directional moves. |
| **Overlap** | 13:00-16:00 UTC. London + NY operating together. Maximum liquidity and volatility. |
| **ORB (Opening Range Breakout)** | Range of the first 15-30min of a session. Breaking this range with volume = signal of session direction. |

### BREAKER Terms

| Term | What it is |
|-------|---------|
| **Refine** | Phase of incremental adjustments: changes 1 variable per iteration. |
| **Research** | Phase when stalled: searches for new approaches via web search + Claude. |
| **Restructure** | Phase of structural change: can alter the base logic of the strategy. |
| **Checkpoint** | Snapshot of the best state of the strategy. If it worsens, revert to here. |
| **Rollback** | Revert to the previous checkpoint when an iteration degraded the result. |
| **Gate** | Automatic validation that blocks undesired changes (e.g.: +2 variables in refine). |
| **Kill switch** | Emergency exit condition in Pine. Closes position immediately when the market changes regime. |
| **Strategy profile** | Different config per strategy type in BREAKER (e.g.: `mean-reversion` has PF 1.3 instead of 1.8). |

### Pine Script

| Term | What it is |
|-------|---------|
| **input()** | Adjustable variable declaration in Pine. Each `input()` = 1 free variable that can be optimized. |
| **request.security()** | Function that fetches data from another timeframe (e.g.: 1H ATR on the 15m chart). |
| **ta.vwap()** | Pine v6 built-in function to calculate VWAP with sigma bands. |
| **process_orders_on_close** | Executes orders at bar close, not during. Prevents signals from unfinished candles. |
| **lookahead** | Parameter that controls whether `request.security` can "see the future." Used with `[1]` for anti-repaint. |
| **Anti-repaint** | Technique to ensure the indicator in backtest only uses data that would have been available in real time. Without anti-repaint, backtest lies. |

---

## References

### Principles
- [Simple vs Complex Trading Strategies](https://www.quantifiedstrategies.com/simple-vs-complex-trading-strategies/) -- QuantifiedStrategies
- [Why Simple Strategies Win](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness) -- TradersPost
- [Overfitting in Trading](https://www.luxalgo.com/blog/what-is-overfitting-in-trading-strategies/) -- LuxAlgo
- [Avoid Overfitting](http://adventuresofgreg.com/blog/2025/12/18/avoid-overfitting-testing-trading-rules/) -- Adventures of Greg

### ADX (limitations)
- [ADX Harsh Realities](https://medium.com/@tradingtruths/the-harsh-realities-of-using-the-adx-indicator-in-trading-7f009cc7a76b) -- Medium
- [ADX Limitations](https://www.avatrade.com/education/technical-analysis-indicators-strategies/adx-indicator-trading-strategies) -- AvaTrade
- [ADX on Fast Timeframes](https://www.chartguys.com/articles/adx-indicator) -- ChartGuys

### Previous data (not verified in current BREAKER)
- Old runs: 24+ Donchian iterations, 3 runs. Data such as "SL destroys 72% of edge," "winners last 55h" are hypotheses to re-validate
- Kaiko 2025: BTC volume concentration in US hours (external source, reliable)
- Wen et al. 2022: momentum + reversion coexist in crypto (academic paper)

### AI Consolidation
- Claude (web search + critical analysis)
- GPT (detailed technical strategy, Pine v6, 10 structural changes)
- Gemini (concepts: BB 2.5sigma, sticky band, conservative cooldown)
- Grok (microstructure, 60-68% WR Asian fade)