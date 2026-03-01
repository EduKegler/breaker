# BTC Multi-Timeframe Trading Knowledge Base

> **Version:** 4.1 (living document)
> **Last updated:** 2026-03-01
> **Sources:** Cross-research (Claude, GPT, Gemini, Grok) + papers/articles
> **Tool:** BREAKER (loop: test -> analyze -> research -> improve -> test)
> **Status:** Clean slate. BREAKER reset. All previous results archived.

---

## Table of Contents

**Part 1 -- Foundation**
1. [Core Philosophy](#1-core-philosophy)
2. [Strategy Taxonomy](#2-strategy-taxonomy)

**Part 2 -- Modules**
3. [Module 1: Breakout](#3-module-1-breakout)
4. [Module 2: Mean Reversion](#4-module-2-mean-reversion)
5. [Module 3: Do Not Trade](#5-module-3-do-not-trade)
6. [Module 4: Pullback [WIP]](#6-module-4-pullback)
7. [Module 5: Trend Following [WIP]](#7-module-5-trend-following)

**Part 3 -- Operations**
8. [Session Map](#8-session-map)
9. [Risk Management](#9-risk-management)

**Part 4 -- Validation**
10. [Stopping Criteria & Promotion Gates](#10-stopping-criteria--promotion-gates)
11. [Walk-Forward Validation](#11-walk-forward-validation)
12. [Backtest Period](#12-backtest-period)

**Part 5 -- BREAKER Tool**
13. [BREAKER Guidelines](#13-breaker-guidelines)
14. [Strategy Logic Reference (fixed infrastructure)](#14-strategy-logic-reference)

**Part 6 -- Roadmap & Meta**
15. [Implementation Order](#15-implementation-order)
16. [Concerns and Real Risks](#16-concerns-and-real-risks)
17. [References](#17-references)

---

# Part 1 -- Foundation

## 1. Core Philosophy

**Less is more.** Simple strategies with few variables outperform complex ones out of sample. Each added rule improves the backtest but likely worsens real results. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness), [source](https://www.quantifiedstrategies.com/simple-vs-complex-trading-strategies/))

**Multiple simple strategies > one complex strategy.** Run separate modules for each market regime. Each module is simple on its own; sophistication comes from the combination. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness))

**Knowing when NOT to trade is as important as trading.** Fewer trades, more selective = better results.

**BREAKER is the final judge, not the AIs.** If backtest numbers contradict the consensus of the 4 AIs, the numbers win. Always.

---

## 2. Strategy Taxonomy

### 2.1 Quick reference: 4 active, 7 discarded

| # | Strategy | Status | Phase | Regime |
|---|----------|--------|-------|--------|
| 1 | **Breakout** | Active | Phase 1 (now) | Trending (start of move) |
| 2 | **Mean Reversion** | Active | Phase 1 (now) | Ranging |
| 3 | **Pullback** | Active | Phase 4 (future) | Trending (middle of move) |
| 4 | **Trend Following** | Active | Phase 4 (future) | Trending (duration of move) |
| 5 | Reversal | Discarded | -- | Insufficient sample, highest degradation (~35%), too discretionary |
| 6 | Scalping | Out of scope | -- | Needs 1m/tick, low latency |
| 7 | Arbitrage | Out of scope | -- | Needs multi-exchange bots, no indicators |
| 8 | Market Making | Out of scope | -- | Needs HFT, inventory management |
| 9 | Pairs / Stat Arb | Out of scope | -- | Needs multiple assets simultaneously |
| 10 | Order Flow | Out of scope | -- | Needs tick/L2 data, not OHLCV |
| 11 | Event-Driven | Out of scope | -- | Edge in reaction, not backtestable |

> **Uncertain regime = do not trade** (Module 3). The 4 active strategies cover trending + ranging. Nothing else needed.

### 2.2 Active strategies (detail)

| Type | What it does | Signal/Regime TF | BREAKER profile |
|------|-------------|-----------------|-----------------|
| **Mean Reversion** | Price went too far from the mean, bets it comes back. Enters against the move. Works in sideways markets. | 15m / 1H | `mean-reversion` |
| **Breakout** | Price was compressed, bets the breakout generates directional movement. Enters at the explosion. | 15m / 4H-Daily | `breakout` |
| **Pullback** | Trend already exists, waits for a temporary correction, enters on resumption. ABCD, flags, "buy the dip" at EMA. | 15m / 4H | `pullback` |
| **Trend Following** | Follows the dominant direction without waiting for pullback. MA crossovers, supertrend. Swing-style, holds hours to days. | 4H / Daily | `trend-following` |

> **Reversal discarded.** Bets the entire trend reverses (double top/bottom, RSI divergence). Discarded because: (1) insufficient sample size on intraday BTC, (2) highest degradation backtest->live (~35%), (3) hardest to mechanize -- most reversal setups depend on discretionary context (liquidity sweeps, order flow) that automated backtesting cannot capture reliably.

### 2.3 Discarded strategies (detail)

| Type | What it does | Why not |
|------|-------------|---------|
| **Scalping** | Micro-moves of 1-5 candles. Edge from low costs and speed. | Needs 1m/tick, maker-only, low latency. 15m does not work. |
| **Arbitrage** | Price difference between markets (spot vs perp, exchange A vs B). | Needs bots, APIs, low latency. Does not depend on indicators. |
| **Market Making** | Orders on both sides of the book, profits from spread. | Needs HFT, inventory management. Not viable in candle-based backtesting. |
| **Pairs / Stat Arb** | Two correlated assets diverge, bets they converge back. | Needs multiple simultaneous assets. Out of scope for single-asset BTC system. |
| **Order Flow** | Reads order book, volume delta, footprint charts. | Requires tick/L2 data not available in OHLCV-based backtesting. |
| **Event-Driven** | Trades around events (FOMC, CPI, halving). | Edge is in the reaction, not indicators. Hard to backtest mechanically. |

### 2.4 Coverage by regime

```
TRENDING REGIME    ->  Breakout -- captures START of the move
                       Pullback -- captures MIDDLE of the move (pullbacks)
                       Trend Following (4H/Daily, swing) -- captures DURATION of the move
RANGING REGIME     ->  Mean Reversion
UNCERTAIN REGIME   ->  Do not trade
```

### 2.5 Signal overlap between modules

When multiple modules are active, signals may coincide. This is not a problem -- it is confirmation.

**Same direction (confirmation):** Breakout goes long + Pullback also goes long = two independent systems agreeing on direction. More conviction.

**Opposite direction (conflict):** MR says short + Breakout says long. Simple rule: one position at a time. If already in a position, other module does not enter.

**No complex arbitration needed between modules.** Simple mutex rule: one position at a time, first signal wins. See Enforceability Matrix for how this is (and isn't) enforced.

### 2.6 How to identify the regime

**Trending:**
- Price making HH/HL (up) or LH/LL (down)
- Increasing volume in the direction of the move
- Session: London or NY hours (see Session Map, section 8)

**Ranging:**
- Price ping-ponging between support and resistance
- Low / decreasing volume
- Session: Asia hours typically (see Session Map, section 8)

**Uncertain / Compression:**
- Neither is clear
- Active squeeze (BB inside KC)
- Session transition
- **-> DO NOT TRADE**

> **Note on ADX:** ADX is lagging by design -- when it confirms the market is ranging, the market may already be breaking out. ([source](https://www.avatrade.com/education/technical-analysis-indicators-strategies/adx-indicator-trading-strategies)) Use as ONE of the inputs, not as a single binary filter. Prefer price action (HH/HL) + volume as the first read.

---

# Part 2 -- Modules

> **Scoping rule:** Each module defines its own fixed rules. Rules from one module do not apply to others. For example, volume confirmation is mandatory for Breakout but not for Mean Reversion -- the same indicator can mean different things in different contexts. BREAKER must respect the rules of the module it is currently optimizing and ignore rules from other modules.

## 3. Module 1: Breakout

> **When:** Trending market
> **Objective:** Capture directional moves after compression
> **Signal TF:** 15m | **Regime TF:** 4H or Daily

### 3.1 Fixed rules (BREAKER cannot change)

1. **Max free variables:** 8
2. **HTF regime filter:** mandatory. Architecture locked per RESTRUCTURE, params tunable (count toward 8-var cap). See candidates in 3.2.
3. **Volume confirmation:** mandatory. Volume on breakout bar must exceed recent average by X% (e.g. volume > X * SMA(volume, 20)). This measures **bar-level conviction** -- "is this bar unusually active vs recent bars?" Threshold X is optimizable; the requirement is not. Distinct from rule 7 (session gate). ([Murphy](https://en.wikipedia.org/wiki/Technical_analysis#Volume), [Wyckoff](https://www.wyckoffanalytics.com/wyckoff-method))
4. **Candle close confirmation:** mandatory. Enter only when the 15m candle **closes** beyond the breakout level. Never enter on wick alone. ([Wyckoff upthrust](https://www.wyckoffanalytics.com/wyckoff-method), [Turtle divergence note](https://oxfordstrat.com/coasdfASD32/uploads/2016/01/turtle-rules.pdf))
5. **Timeout exit:** mandatory. Forced exit after N bars to prevent funding bleed on failed breakouts.
6. **ATR-based stop on 1H:** mandatory (not 15m).
7. **Volume-based session gate:** disable entries when trailing 1H volume < X% of the **same hour-of-day baseline** (median or EMA of same UTC hour over last N weeks). This measures **session liquidity** -- "is this hour abnormally dead vs what this hour normally looks like?" Distinct from rule 3 (bar conviction). Account for day-of-week. Threshold X and lookback N are optimizable. ([Amberdata](https://blog.amberdata.io/trading-between-hours-volatility-dispersion-across-multiple-regions), [Kaiko](https://research.kaiko.com/insights/bitcoin-booms-in-low-risk-environment))
8. **Stopping criteria:** PF >= 1.3, DD <= 10%, trades >= 50, pfRatio >= 0.6, avgR >= 0.15. No minimum win rate. ([WR rationale](https://www.tradingview.com/chart/XAUUSD/tDeNSCEn-Breakout-Trading-How-Low-Win-Rate-Systems-Beat-the-Market/))

#### Rationale (for human review, not consumed by BREAKER loop)

<details>
<summary>Why these rules exist</summary>

- **Volume confirmation (rule 3):** foundational principle of breakout trading (Murphy, Wyckoff). Compares the breakout bar's volume against a **recent moving average** (e.g. SMA(volume, 20)) to detect abnormal conviction on that specific bar. This is NOT the same as the session gate (rule 7). False breakout rates in crypto are high -- educational estimates vary widely (some cite 60-70%, but this depends on definitions, timeframe, and conditions; [source](https://www.binance.com/en/square/post/291147927451089)). The exact rate is not canonical, but the directional point is clear: most breakouts without volume follow-through fail.
- **Candle close (rule 4):** wicks through levels without close are the most common fakeout pattern. In Wyckoff terms, an "upthrust" (price pierces resistance then closes back inside) is a distribution signal, not a breakout. This diverges from classic Turtle rules, which entered on intraday price breach without waiting for close -- that approach was for daily-TF commodities with high liquidity. On BTC 15m, close confirmation is a worthwhile filter even at cost of slightly worse entry prices.
- **HTF regime filter (rule 2):** breakout on 15m alone produces too many false signals. The filter has two decision levels: architecture (which type -- locked per RESTRUCTURE) and parameters (tunable by REFINE, count toward 8-var cap).
- **Session gate (rule 7):** a flat 24H rolling average is flawed because US hours structurally dominate ~55% of volume (Kaiko 2025, up from 39% in 2020). Comparing Asian-session volume against a 24H average would systematically block normal trades. Hour-of-day baseline normalizes for the known intraday cycle. Guideline: lowest volume ~02:00-06:00 UTC; ~21:00-23:00 is low but rising (climbs to 00:00 as Asian session begins); peak ~13:00-20:00 UTC. **Venue matters:** Amberdata shows OKX is a clear outlier with flatter intraday profile; [cross-exchange analysis](https://blog.amberdata.io/trading-between-hours-volatility-dispersion-across-exchanges). Weekend volume ~13% of total (down from 21% in 2021) -- consider tighter filters or disable.
- **No WR gate (rule 8):** breakout strategies are asymmetric by nature (typical WR 20-40%). Turtle system: 39% WR, 57.8% CAGR (Curtis Faith). PF and avgR are the real quality gates; gating by WR would kill valid strategies ([BacktestBase](https://www.backtestbase.com/education/win-rate-vs-profit-factor)).

</details>

### 3.2 Strategy candidates

BREAKER can explore any combination fitting the breakout archetype (compression -> explosion). Below are known candidates, not a fixed design.

**Recommended first iteration (starting point, not mandatory):**

> Donchian(20) + EMA200 Daily direction + Volume > 1.5x SMA(vol, 20) on breakout bar + Session gate: 1H vol > 60% of hour-of-day median + ATR(14) 1H stop x 3.0 + Timeout 48 bars (12h) + Partial TP 50% at 2R, trail rest at 1.5 ATR.
> This is the simplest viable version. ~7 vars (Donchian period, EMA period, vol multiplier, session threshold, ATR multiplier, timeout bars, TP R:R). No optional confirmation -- budget is at limit. Optimize from here.

**Variable budget (8 max):**

| Component | Typical vars | Example |
|-----------|-------------|---------|
| Entry signal | 1-2 | Donchian period; BB length + KC multiplier |
| Regime filter | 1-2 | EMA period; ADX period + threshold |
| Volume confirmation (rule 3) | 1 | multiplier vs SMA(volume, 20) |
| Session gate (rule 7) | 1 | threshold % vs hour-of-day baseline |
| ATR stop | 1 | multiplier |
| Timeout | 1 | bars |
| TP structure | 1-2 | R:R target; partial % |
| Confirmation filter (optional) | 1 | RSI threshold |
| **Typical total** | **8-11** | Budget is tight. Simplify TP or drop optional confirmation to stay <= 8 |

**Entry signal candidates:**

| Approach | How it works | Breakout level definition | Notes |
|----------|-------------|--------------------------|-------|
| Donchian Channel | New high/low breakout above/below N-period channel | High: highest high of last N bars. Low: lowest low of last N bars | Classic, simple. Inspired by Turtle Traders (deliberate deviation: we require close, they didn't). [QuantifiedStrategies](https://www.quantifiedstrategies.com/how-we-built-a-bitcoin-trend-following-strategy-using-chatgpt/): Donchian + low ADX on BTC daily positive results (details paywalled) |
| Bollinger Band squeeze release | BB contracts inside KC, then expands. Enter on expansion direction | Upper: BB upper band at squeeze release. Lower: BB lower band. Squeeze = BB inside KC | Compression -> explosion detector |
| Opening Range Breakout (ORB) | Define high/low of first N minutes of a session, trade the break | High/low of first 5/15/30 min after session open ([Investopedia](https://www.investopedia.com/terms/o/opening-range.asp)) | Define opens by **local timezone** (London: 08:00 GMT/BST; NY: 09:30 ET), convert to UTC dynamically. Do NOT hardcode UTC |
| Range breakout | Define range from recent N bars, enter on break | High/low of range. Range = N bars where (high - low) / ATR < threshold | ATR-normalized width to mechanize "what is a range" |
| Volatility expansion | ATR or std dev spikes above threshold | N/A (confirmation, not a level) | Detects explosion itself. Complement to other entries |

**Entry timing candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Breakout close | Enter at candle close beyond level | Faster, more slippage, higher fakeout exposure |
| Retest entry | Wait for close beyond level, then pullback to level. Enter if holds | Tighter stop, fewer fakeouts. Risk: misses fast moves that never retest |

**Regime filter candidates (pick one, then lock per RESTRUCTURE):**

| Approach | Timeframe | What it does | Tunable params |
|----------|-----------|-------------|----------------|
| EMA direction | Daily or 4H | Breakout aligns with higher-TF trend | EMA period(s) |
| ADX threshold | 4H | Low ADX = consolidation (good for entry). High ADX = already trending | ADX period, threshold |
| 4H consolidation | 4H | Narrow range on 4H candles preceding breakout | Lookback period, range width threshold |

**Optional confirmation filter (max 1 -- volume is already mandatory via fixed rule 3):**

| Approach | How it works | Notes |
|----------|-------------|-------|
| RSI momentum | RSI(14) > 50 for longs, < 50 for shorts | Confirms momentum direction. Adds 1 var (period or threshold) |
| MACD alignment | MACD histogram positive/negative | Trend momentum. Adds 0 vars if using defaults, 2 if tuning |

**Exit candidates:**

| Approach | What it does | Typical range | Vars consumed |
|----------|-------------|---------------|---------------|
| Trailing channel (Donchian fast) | Exit on retracement to opposite channel | Period: 5-15 bars | 1 |
| ATR trailing stop | Stop follows price at N x ATR distance | N: 1.5-4.0 | 1 |
| Time-based timeout | Forced exit after N bars | N: 24-96 bars (6-24h on 15m) | 1 |
| Partial TP + trail | Partial profit at R:R, trail rest | 25-75% at R:R 0.5-2.0 | 1-2 |

---

## 4. Module 2: Mean Reversion

> **When:** Sideways/ranging market
> **Objective:** Capture returns to the mean after overextension
> **Signal TF:** 15m | **Regime TF:** 1H

### 4.1 Fixed rules (BREAKER cannot change)

- **Max free variables:** 6
- **Must identify "extreme" and "mean."** The strategy needs a band/channel to define overextension and a center line to define the reversion target.
- **Must include ATR-based stop** on 1H (not 15m).
- **Must include a timeout exit.** MR trades that don't revert must exit before accumulating losses.
- **Operates 24/7** across all sessions. Session breakdown monitors whether edge holds per session. If MR PF in any session is consistently < 1.0, revisit restricting it.
- **2 consecutive losses -> shut down that module until next session.**
- **Stopping criteria:** PF >= 1.3, DD <= 8%, WR >= 50%, trades >= 80, pfRatio >= 0.6

### 4.2 Strategy candidates

BREAKER can explore any combination that fits the mean reversion archetype (price overextended -> bets on return). Below are known candidates.

**Band/channel candidates (defines "extreme"):**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Keltner Channels | EMA(20) +/- ATR x mult. Price outside band = extreme | Adapts to volatility via ATR. Smoother than BB |
| Bollinger Bands | SMA(20) +/- std dev x mult. Price outside band = extreme | Classic. More reactive to volatility spikes than KC |
| Percentage bands | Fixed % distance from moving average | Simple but doesn't adapt to volatility |
| VWAP bands | VWAP +/- std dev. Price outside band = extreme | Session-anchored. Fragile if session opens with gap |

**Exhaustion confirmation candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| RSI(2) | Ultra-short RSI. < 20 = oversold, > 80 = overbought | Very fast reaction. Standard MR confirmation |
| RSI(3-5) | Slightly smoother. Fewer false signals, slower entry | Trade-off: fewer entries but more reliable |
| Stochastic | %K/%D crossover in extreme zones | Similar to RSI but momentum-based |
| Volume spike | Volume > N x SMA(volume) confirms the extreme move is real | Filters weak extremes. May be asymmetric (more useful for shorts in crypto) |

**TP candidates:**

| Approach | What it does | Notes |
|----------|-------------|-------|
| Channel midline | Exit at EMA/SMA center of the band | Conservative, high WR |
| Opposite band | Exit at other extreme | Aggressive, lower WR, higher R:R |
| Partial TP + trail | Exit X% at midline, trail rest | Balances WR and R:R. Consider asymmetry for shorts (squeeze risk) |

---

## 5. Module 3: Do Not Trade

> **When:** Uncertain regime, extreme compression, session transition
> **Objective:** Preserve capital

### 5.1 When NOT to trade

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

## 6. Module 4: Pullback [WIP -- Phase 4]

> **When:** Trending market (trend already established)
> **Objective:** Enter on temporary corrections within an existing trend
> **Signal TF:** 15m | **Regime TF:** 4H
> **Status:** Not yet designed. Placeholder for Phase 4.

### 6.1 Fixed rules (BREAKER cannot change)

- **Max free variables:** 8
- **Must confirm trend exists on higher TF before looking for pullback.** Without an established trend, a "pullback" is just noise.
- **Must define what constitutes a "pullback" vs a reversal.** Depth of retracement matters -- too shallow = noise, too deep = trend may be broken.
- **Must include ATR-based stop** on 1H (not 15m).
- **Must include a timeout exit.**
- **Stopping criteria:** PF >= 1.4, DD <= 10%, trades >= 50, pfRatio >= 0.6, avgR >= 0.15. No strict WR gate -- pullbacks tend to have slightly higher WR than raw breakout (entering with confirmed trend), but this varies. PF and avgR remain the primary quality gates.

### 6.2 Strategy candidates

To be researched. Initial directions:

- Fibonacci retracement levels (38.2%, 50%, 61.8%) as pullback zones
- EMA pullback (price returns to 20/50 EMA in trend direction)
- Flag/pennant patterns (consolidation within trend)
- ABCD pattern (measured move after pullback)
- RSI dip into 40-50 zone (uptrend) or 50-60 zone (downtrend) as entry timing

---

## 7. Module 5: Trend Following [WIP -- Phase 4]

> **When:** Trending market (ride the duration)
> **Objective:** Follow the dominant direction without waiting for pullback
> **Signal TF:** 4H | **Regime TF:** Daily
> **Status:** Not yet designed. Placeholder for Phase 4.

### 7.1 Fixed rules (BREAKER cannot change)

- **Max free variables:** 8
- **This is swing trading, not day trading.** Trades last hours to days. Different risk profile from 15m modules.
- **Must account for funding rate costs.** Holding Hyperliquid perps for multiple days means funding rate is no longer negligible. Include in cost model.
- **Must include ATR-based stop** (Daily ATR, not 1H -- wider stops for swing).
- **Must include a timeout exit** (longer than 15m modules -- days, not hours).
- **Stopping criteria:** PF >= 1.4, DD <= 12%, trades >= 30, pfRatio >= 0.6, avgR >= 0.20. No minimum win rate -- trend following is the canonical low-WR, high-R:R archetype (Curtis Faith/Turtles: 39% WR, 57.8% CAGR). PF and avgR are the real quality gates.

### 7.2 Strategy candidates

To be researched. Initial directions:

- MA crossovers (e.g. 20/50 EMA on 4H)
- Supertrend indicator
- Donchian channel on 4H/Daily (longer periods than breakout module)
- ADX > threshold as trend strength confirmation (opposite usage vs breakout where low ADX = good)
- Trailing stop only (no fixed TP -- let winners run)

---

# Part 3 -- Operations

## 8. Session Map

> **Note:** Times below are approximate non-DST (winter) UTC equivalents. During US/EU DST (Mar-Nov), sessions shift ~1h earlier in UTC. Define sessions by **local timezone** (London: GMT/BST, NY: ET) and convert dynamically. Do NOT hardcode UTC -- DST breaks hardcoded values.

| Session | Local time | Approx UTC (winter) | Character | Module |
|--------|------------|---------------------|---------|--------|
| Asia | HK 09:30-16:00 / Tokyo 09:00-15:00 | ~01:30-07:00 | Low vol, range | **MR** + potential **Breakout** (if volume filter passes) |
| London | 08:00-16:30 GMT | ~08:00-16:30 | Expansion, breakouts | **Breakout** + **MR** |
| NY | 09:30-16:00 ET | ~14:30-21:00 | Directional, maximum liquidity | **Breakout** + **MR** |
| London/NY overlap | -- | ~14:30-16:30 | Peak volume + volatility | **Breakout** primary |

> **MR operates 24/7.** Session breakdown monitors whether edge holds per session. If MR PF in any session is consistently < 1.0, revisit restricting it.
>
> **Breakout is volume-gated, not session-gated.** The volume filter (section 3.1: trailing 1H volume vs same hour-of-day baseline) is the actual gate. Sessions provide context for BREAKER's analysis prompt (count, WR, PF per session), but the binary on/off is driven by volume, not by a hardcoded UTC window. In practice, the volume filter will naturally block most trades during ~02:00-06:00 UTC and allow most during US/London hours, but it adapts to structural changes over time.

---

## 9. Risk Management

*Universal -- applies to all modules.*

### 9.1 Exchange: Hyperliquid (perps)

All trades are in perpetual contracts on Hyperliquid. No gas fees, only trading fees + funding.

| Fee | Tier 0 (base) | Tier 1 ($5M 14d vol) | Tier 2 ($100M) |
|-----|--------------|----------------------|----------------|
| **Taker** | 0.045% | 0.040% | 0.030% |
| **Maker** | 0.015% | 0.012% | 0.004% |

**Round trip (taker/taker):** 0.09% at Tier 0 = ~$85.50 per trade of 1 BTC at $95k.
**Round trip (maker/maker):** 0.03% at Tier 0 = ~$28.50 per trade of 1 BTC at $95k.

> **Impact on MR:** With fixed $ risk, tight stop = larger notional = more fees. Monitor `stopAtrMult` -- if too low, fees can dominate. Use limit orders (maker) when possible.

**In BREAKER engine config:**
```
takerFee: 0.045%    // conservative -- assumes worst case
slippage: 2 ticks   // conservative to cover microstructure
```

**Funding rate:** Paid/received every hour. Not modeled in backtest by default. For MR (short trades of 1-2h), impact is minimal. For trend following (trades lasting hours/days), consider adding to cost model.

### 9.2 Sizing

- **Risk per trade:** 1% of capital (max 2% on A+ setup)
- **Ramp-up:** first 1-2 weeks of live trading at 0.25-0.5% risk per trade. Scale to 1% after confirming live metrics match paper
- **Calculation:** position = risk / stop distance

### 9.3 Leverage Policy

**Max available:** 40x for BTC on Hyperliquid. **Max allowed by this playbook: 5x.** Hard rule.

**Why leverage exists here:** Leverage does NOT change expectancy per trade. A 1% risk trade returns the same R whether at 1x or 10x. What leverage changes is **capital efficiency** -- how much collateral is locked per position, freeing the rest for other modules or as buffer against drawdown.

**Margin modes:**

| Mode | How it works | When to use |
|------|-------------|-------------|
| **Isolated** | Margin locked per position. Liquidation affects only that position. Other positions and free capital untouched. | **Default for all modules.** Prevents one bad trade from cascading. |
| **Cross** | All positions share a single margin pool. Unrealized PnL from winners offsets losers. | Only if running portfolio margin optimization later (Phase 5+). NOT for initial deployment. |

**Leverage tiers:**

| Phase | Max leverage | Rationale |
|-------|-------------|-----------|
| Paper trading | Any (no real capital) | Test freely, but log the leverage used |
| Capital Deployment (weeks 1-2) | 2x | Ramp-up period. Conservative. Focus on execution quality, not returns |
| Capital Deployment (weeks 3+) | 3x | Standard operating leverage after confirming live metrics |
| Experienced (3+ months live) | 5x | Only if all modules are profitable and drawdown < 50% of max allowed |

**Liquidation math (isolated margin, BTC at 40x max):**

Maintenance margin = initial margin at max leverage / 2 = (1/40) / 2 = **1.25% of notional**.

| Your leverage | Initial margin | Liq distance from entry (approx) |
|--------------|---------------|----------------------------------|
| 2x | 50% | ~49.4% |
| 3x | 33.3% | ~32.9% |
| 5x | 20% | ~19.4% |
| 10x | 10% | ~9.4% |
| 20x | 5% | ~4.4% |
| 40x (max) | 2.5% | ~1.25% |

> **Why 5x hard cap:** At 5x, liquidation is ~19% away from entry. BTC ATR Daily is typically 2-5%. Even a 3-sigma daily move (~10-15%) would not liquidate. At 10x+, a large wick during low-liquidity hours can liquidate before your stop fires. The stop is your exit, not the liquidation engine.

**Key rules:**

1. **Stop must ALWAYS be closer than liquidation price.** If your ATR stop is at 3% and your liq price is at 4.4% (10x), you have only 1.4% buffer. That is too thin. At 3x (liq ~33%), you have 30% buffer. Safe.
2. **Leverage is set per-position on Hyperliquid.** Each isolated position can have different leverage. MR (tight stops, frequent trades) can use 3x. Breakout (wider stops, less frequent) can use 2-3x.
3. **Never use leverage to increase position size beyond 1% risk.** Leverage reduces collateral locked, it does NOT mean "bet bigger." If your 1% risk = $100, and stop distance = $1000, position = 0.1 BTC regardless of leverage. At 3x you just lock $3,166 collateral instead of $9,500.
4. **Funding rate awareness:** At higher leverage, funding payments are proportionally larger relative to your margin. For MR (1-2h holds), negligible. For TF (multi-day holds at 3-5x), funding can erode 0.01-0.03% per hour. Monitor.
5. **No leverage adjustment mid-trade.** Set leverage before entry. Increasing leverage on a losing position is equivalent to averaging down -- forbidden.

### 9.4 Iron rules

- Stop on 1H ATR (via request.security), avoid 15m ATR on BTC
- **Positive expectancy required:** (WR x avgWin) > ((1-WR) x avgLoss) after fees. MR can have low R:R + high WR. Breakout/PB/TF naturally have high R:R + low WR. The test is expectancy, not R:R alone
- Hyperliquid fee (0.045% taker) included in every backtest
- Prefer limit orders (maker 0.015%) when possible to reduce cost
- No martingale. No averaging down. No revenge trading.

### 9.5 Daily limits

- Max daily loss: 2R -> shut down for today
- Max daily trades: 5 across all modules (per-module caps are subordinate internal limits)
- 2 consecutive losses in the same module -> shut down that module until next session

### 9.6 Enforceability Matrix

Some rules are enforceable per-module in the BREAKER engine. Others require the orchestrator. This distinction matters because each module runs as an independent strategy instance.

| Rule | Enforceable in engine? | How it works |
|------|----------------------|-------------|
| Per-module maxTradesDay | **Yes** -- counter resets daily in each strategy | Per-module |
| Per-module consecutive loss gate (2) | **Yes** -- counter in each strategy | Per-module |
| ATR-based stop | **Yes** -- per-trade in strategy | Per-trade |
| Timeout (N bars) | **Yes** -- per-trade in strategy | Per-trade |
| Global 5 trades/day across modules | **No** -- strategies don't share state | Orchestrator |
| One position at a time across modules | **No** -- strategies don't see each other | Orchestrator |
| Daily loss 2R shutdown | **No** -- strategies don't share P&L | Orchestrator |
| Macro event blackout (CPI/FOMC/NFP) | **Yes** -- orchestrator has economic calendar API | Orchestrator |
| Leverage cap (5x max) | **No** -- backtests don't model leverage/margin | Orchestrator sets per-position via Hyperliquid API |

> **Implication:** The orchestrator is implemented (TypeScript). Handles mutex, daily P&L limits, macro blackout, leverage enforcement via Hyperliquid API.

---

# Part 4 -- Validation

## 10. Stopping Criteria & Promotion Gates

### 10.1 Minimum criteria per strategy type

> **Targets** based on research: PF 1.6-1.8 is realistic for daily/4H timeframes but not for intraday crypto. Sources: QuantifiedStrategies (PF 1.75+ optimal but 1.2+ tradable), TheRobustTrader (1.4-2.0 comfortable range), Freqtrade community (intraday PF 1.07-1.24 common).
>
> **avgR** = average expectancy per trade in R-multiples. Formula: ((WR x avgWin) - ((1-WR) x avgLoss)) / avgLoss. Example: WR 25%, avg win 4R, avg loss 1R -> avgR = (0.25 x 4 - 0.75 x 1) / 1 = 0.25R. This means each trade is worth 0.25R on average. avgR >= 0.15 means the strategy earns at least 0.15R per trade after accounting for losses.

| Metric | Mean Reversion | Breakout | Pullback | Trend Following |
|---------|---------------|----------|-------------------|-----------------|
| **Signal TF** | 15m | 15m | 15m | 4H |
| **Regime TF** | 1H | 4H-Daily | 4H | Daily |
| **PF** | >= 1.3 | >= 1.3 | >= 1.4 | >= 1.4 |
| **DD** | <= 8% | <= 10% | <= 10% | <= 12% |
| **WR** | >= 50% | -- | -- | -- |
| **avgR** | -- | >= 0.15 | >= 0.15 | >= 0.20 |
| **Trades** | >= 80 | >= 50 | >= 50 | >= 30 |
| **PnL** | > 0 | > 0 | > 0 | > 0 |
| **WF pfRatio** | >= 0.6 | >= 0.6 | >= 0.6 | >= 0.6 |

> **Why WR is a gate for MR but not for Breakout/PB/TF:** Mean reversion profits from frequent small wins -- low WR means the strategy is not reverting reliably, which is a design failure. Breakout/TF profit from asymmetric payoffs (few big winners) -- low WR is expected and normal (Turtle system: 39% WR, 57.8% CAGR). Gating these by WR would kill valid strategies. For Breakout/PB/TF, avgR (average expectancy per trade in R-multiples) replaces WR as the per-trade quality metric.

**Estimated degradation backtest -> live:**

| Type | Min PF | Degradation | Estimated live PF |
|------|--------|-----------|-----------------|
| MR | 1.3 | ~20% | ~1.04 |
| Breakout | 1.3 | ~30% | ~0.91 |
| PB | 1.4 | ~25% | ~1.05 |
| TF | 1.4 | ~30% | ~0.98 |

> **Warning:** At PF 1.3 backtest, live PF after degradation is near breakeven. PF 1.5+ in backtest is needed for real margin (~1.05-1.12 live). Strategies that converge at PF 1.3-1.4 should be treated as marginal. MR degrades less (frequent trades, predictable fills). TF degrades more (longer holds, regime changes mid-trade).

> **KB vs BREAKER config:** The criteria above are the **minimum floor** defined by this playbook. The BREAKER operational config (`breaker-config.json`) may use stricter thresholds (e.g. PF 1.6 instead of 1.3 for breakout, DD 6% instead of 10%). If the config is stricter than the KB, the config prevails. If the config is less strict than the KB, that is a bug -- fix the config.

### 10.2 Promotion Gates

The stopping criteria above are **Research Pass** -- the minimum to keep investigating. A strategy that meets them is not ready for money. Three gates, each harder:

| Gate | What it means | Criteria | Who decides |
|------|-------------|----------|-------------|
| **Research Pass** | Strategy has enough signal to keep optimizing. Not random noise | Meets stopping criteria table above (PF, DD, avgR or WR per module type, trades, WF) | BREAKER automatic |
| **Paper Trade Pass** | Strategy is robust enough to test with real market conditions (no capital) | Research Pass + OOS Historical holdout PF >= loop x 0.6 + OOS Future PF >= loop x 0.5 + no session where PF < 0.8 + positive expectancy after fees | Manual validation (5-10 min) |
| **Capital Deployment** | Strategy is ready for real money | Paper Trade Pass + 2-4 weeks paper trading with real orders + slippage checklist: compare real fills vs 2-tick estimate (if real slippage > 2x estimate, flag for review) + no behavioral red flags (revenge trading, skipping signals) + operational discipline confirmed. **Ramp-up:** first 1-2 weeks at 0.25-0.5% risk per trade (not full 1%). Scale to 1% only after confirming live metrics match paper | Manual decision |

---

## 11. Walk-Forward Validation

There are 3 distinct validation methods. They test different things and should not be confused.

**1. WF Internal 70/30 (automatic, in BREAKER)**

Splits exported trades from the backtest period into 70% train / 30% test. Computes `pfRatio = PF_test / PF_train`. If < 0.6, sets `overfitFlag: true`.

- **What it tests:** Whether performance is consistent across the backtest period
- **Limitation:** The engine runs the strategy over the entire period -- the optimization loop indirectly "sees" the 30% test data through parameter selection. This is a diagnostic, not a true out-of-sample test
- **Caveat:** Only activates with >= 10 trades in the WF split

**2. OOS Historical Holdout (manual, pre-loop)**

Run the final strategy on a period **before** the optimization window (e.g. if BREAKER used Jul-Dec, test on Apr-Jun). Data the loop never touched.

- **What it tests:** Whether the strategy generalizes to a different (earlier) regime
- **When to use:** After BREAKER converges, before paper trading
- **Pass criterion:** PF_holdout >= PF_loop x 0.6

**3. OOS Future (manual, post-loop)**

Run the final strategy on a period **after** the optimization window (e.g. if BREAKER used Jul-Dec, test on Jan-Feb of next year). True forward test.

- **What it tests:** Closest proxy to live performance without real money
- **When to use:** After OOS Historical passes, before capital deployment
- **Pass criterion:** PF_future >= PF_loop x 0.5 (more lenient -- future regime may differ)

> **Recommended sequence:** WF Internal (automatic) -> OOS Historical (manual, 5 min) -> OOS Future (manual, 5 min) -> Paper Trading (2+ weeks) -> Capital Deployment. Each gate must pass before proceeding to the next.

---

## 12. Backtest Period

| Use | Period | Reason |
|-----|---------|--------|
| **BREAKER loop (optimization)** | Last 6-9 months | Recent data, current market. ~35,000 candles on 15m = plenty of sample |
| **OOS Historical holdout** | 2-3 months before the loop period | Data the loop never touched. Tests generalization to earlier regime |
| **OOS Future** | 1-2 months after the loop period | True forward test. Closest proxy to live performance |
| **Stress test (optional)** | Crash or extreme rally period | Not for optimization -- just to understand DD in extreme scenarios |

**Do not use the entire available history.** Pre-ETF BTC (before Jan/2024) is a structurally different market: liquidity, participants, correlations, and volatility have changed. Optimizing on 2021-2022 data pollutes the model with regimes that no longer exist.

**Do not use less than 6 months.** Risk of capturing only one regime (e.g.: only bull) and incorrectly concluding it works.

---

# Part 5 -- BREAKER Tool

## 13. BREAKER Guidelines

### 13.1 Limits per run

- **Max free variables:** MR = 6, Breakout = 8, PB/TF = 8 (hard gate in refine -- rejects +2 per iteration)
- **Max iterations per strategy:** defined in config (recommendation: 15)
- **Walk-forward:** 70/30 split + pfRatio + automatic overfitFlag (>= 10 trades)
- **Session breakdown:** Asia/London/NY with count, WR, PF, PnL in prompt. Also break down by volume quartile (low/medium/high/peak based on hour-of-day baseline)
- **Include real costs:** commission 0.045% (Hyperliquid taker) + slippage 2 ticks in backtest config
- **Category lock:** BREAKER cannot change strategy type (e.g. breakout -> pullback) without explicit user approval. RESTRUCTURE may change indicators/logic within the same category only

### 13.2 Session breakdown sanity checks

- MR: operates 24/7, validate that PF is consistent across sessions (not dependent on one specific session)
- Breakout with high PF in London/NY and low PF in Asia = **correct**
- If reversed = suspicious logic

### 13.3 Red flags in backtest (heuristics, not absolute rules)

- [ ] PF > 3.0 -> strong overfit signal in this system's context (low-frequency intraday BTC)
- [ ] Sharpe > 3.0 -> strong overfit signal (same reasoning)
- [ ] DD < 1% -> strong overfit signal (real crypto strategies have drawdowns)
- [ ] Performance depends on 1-2 specific hours -> fragile (session breakdown helps spot this)
- [ ] Removing 1 variable destroys the result -> overfit on that variable
- [ ] Win rate > 80% -> investigate for look-ahead bias or curve fitting (not impossible, but rare for mechanical strategies on BTC 15m)
- [ ] `overfitFlag: true` (pfRatio < 0.6) -> overfit confirmed by BREAKER's WF internal diagnostic
- [ ] Score increasing but trades decreasing drastically -> filtering until it finds noise
- [ ] MR with PF concentrated in 1-2 sessions -> fragile edge, should be consistent 24/7
- [ ] Breakout with high PF in Asia -> edge in the wrong place, suspicious logic

### 13.4 Trusted domain whitelist for research

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
| `quantnomad.com` | Backtest articles. Practical, with code |
| `quantra.quantinsti.com` | Quant courses + articles. Institutional |
| `robotwealth.com` | Professional quant trader blog. Articles with code and data |
| `quantstart.com` | Backtesting biases, walk-forward, transaction costs. Classic quant retail reference |
| `blog.quantinsti.com` | Python-based articles on WFO, backtesting methodology, performance metrics |

**Tier 3 -- Technical / Tools**

| Domain | What it offers |
|---------|---------------|
| `tradingview.com/chart` | Charting and visual analysis (not used for backtesting) |
| `luxalgo.com/blog` | Articles on indicators, overfit, algo trading |
| `strategyquant.com/doc` | Walk-forward optimization, Monte Carlo degradation, robustness testing docs |

**Tier 4 -- Crypto-specific**

| Domain | What it offers |
|---------|---------------|
| `blog.amberdata.io` | Institutional crypto microstructure research. Temporal liquidity patterns, order book depth, session analysis with real data (50k+ datapoints) |
| `research.kaiko.com` | Data-driven crypto research. Slippage, funding rates, liquidity, exchange microstructure. Institutional grade |
| `kaiko.com` | Institutional crypto market data. Liquidity and microstructure |
| `glassnode.com` | On-chain analytics. Flows, holders, network metrics |
| `glassnode.com/academy` | On-chain education. Supply dynamics, holder behavior, cycle analysis |
| `coinalyze.net` | Open interest, funding, liquidations in real time |
| `laevitas.ch` | Crypto derivatives: funding rates, basis, options |
| `hyperliquid.gitbook.io` | Official Hyperliquid documentation. Fees, API, order types, rate limits |

> **AVOID:** Sites that sell courses with "guaranteed results," exchange affiliate blogs, channels without backtests, forums without technical moderation, anything with "free signals" or "copy trading."

---

## 14. Strategy Logic Reference (fixed infrastructure only)

> **Note:** Strategy-specific logic (entry signals, exit rules, indicator combinations) lives in the code, not in the KB. BREAKER updates the code via REFINE/RESTRUCTURE. The KB only documents fixed infrastructure patterns that all strategies share.

### 14.1 ATR 1H (higher timeframe, anti-repaint)
```typescript
// Use completed 1H candle only (no lookahead)
const atr1h = indicators.atr({ source: '1H', period: 14, offset: 1 })
```

### 14.2 Squeeze detection
```typescript
const bb = indicators.bollingerBands({ period: 20, mult: 2.0 })
const kc = indicators.keltnerChannels({ period: 20, mult: 1.5 })
const squeezeOn = bb.lower > kc.lower && bb.upper < kc.upper
```

### 14.3 Session tracking
```typescript
const sessions = {
  asia:    timeUtils.inSession('18:00-03:00', 'America/New_York'),
  london:  timeUtils.inSession('03:00-12:00', 'America/New_York'),
  ny:      timeUtils.inSession('09:30-16:00', 'America/New_York'),
  offPeak: timeUtils.inSession('16:00-18:00', 'America/New_York'),
}
```

---

# Part 6 -- Roadmap & Meta

## 15. Implementation Order

### Phase 1 -- Validate the foundations
- Test Module 1 (Breakout) and Module 2 (MR) candidates individually in BREAKER
- Each module must pass Research Gate before moving to Phase 2

### Phase 2 -- Refine
- Optimize each module toward stopping criteria targets
- Walk-forward validation: OOS Historical + OOS Future
- Each module must pass Paper Trade Gate before moving to Phase 3

### Phase 3 -- Integrate
- Orchestrator implemented (TypeScript): daily P&L check, cross-module mutex, economic calendar API for auto-blackout (CPI, FOMC, NFP), leverage enforcement via Hyperliquid API
- Run modules in parallel
- Verify signal overlap and mutex behavior
- Measure combined result (portfolio PF, combined DD)
- Enforce global limits via orchestrator

### Phase 4 -- Expand coverage
- Pullback: 15m signal, 4H regime. BREAKER profile `pullback`
- Trend Following: 4H signal, Daily regime. Swing trading, not day trading. Profile `trend-following`

### Phase 5 -- Infra
- Automatic regime switcher (orchestrator)
- Add more assets if desired (ETH, SOL -- same logic, different parameters)

---

## 16. Concerns and Real Risks

These are concerns that are not consensus among the AIs, but important enough to document. Some are technical, others are structural.

### 16.1 Mean Reversion in crypto != Mean Reversion in equities

Most MR literature comes from equities and forex, where mean reversion is a well-documented phenomenon (especially in pairs and ETFs). Crypto is different:
- BTC can trend for weeks without reverting (bull runs, liquidation cascades)
- There is no clear "fundamental value" for the price to "revert" to
- Session VWAP is a fragile anchor -- if the price opened with a gap, the VWAP already starts displaced

**Real risk:** MR in BTC may simply not have enough edge to be consistent.

**Mitigation:** Test first. If BREAKER cannot achieve PF >= 1.3 in 15 iterations with realistic criteria, the honest answer is: MR on 15m BTC does not work well enough. And that is a valid result -- knowing that something does not work saves money.

### 16.2 Consensus bias from the 4 AIs

The 4 AIs (Claude, GPT, Gemini, Grok) agree on a lot. This seems good, but it could be shared bias:
- All were trained on similar data (trading blogs, indicator documentation, same papers)
- If all learned from the same 50 blog posts about "Bollinger Band mean reversion," the consensus is not independent evidence -- it is an echo of the same source
- None of them actually tested. All are reasoning about what "should" work

**Real risk:** The entire knowledge base may be based on conventional wisdom that does not survive rigorous backtesting.

**Mitigation:** BREAKER is the final judge, not the AIs. If backtest numbers contradict the consensus of the 4 AIs, the numbers win. Always.

### 16.3 The Asian session may not be consistently range-bound

The argument is: "Asian session has lower volume, so BTC trades sideways, so MR works." But:
- Asia includes Korea, Japan, China -- which are enormous crypto markets
- Asian macro events (BOJ, China data, Korea regulation) can create violent trends during the "Asian session"
- The structure itself may be changing (more algo trading 24/7, less dependence on human sessions)

**Real risk:** The session edge may be weaker than it appears, or may be diminishing over time.

**Mitigation:** Session breakdown will show whether the edge actually exists in Asia. If MR has similar PF across all sessions, the session filter is not adding value.

### 16.4 Candle-based backtesting has real limitations

- **Does not model the order book.** In MR, you enter at extremes -- exactly where liquidity is lowest. The real fill may be worse than the backtest assumes.
- **Slippage is an estimate.** The engine uses configured slippage (2 ticks). In BTC perp during Asian session (low liquidity), real slippage can be 2-5x the estimate.
- **15m candles hide microstructure.** A candle that "touched KC lower band and bounced back" may have been a 2-second wick that you would never catch with a real order.

**Real risk:** Pretty backtest -> ugly live trading. The backtest-live gap is larger in strategies that trade at extremes (like MR). Degradation of 20-30% is a base estimate; in volatile regimes (cascades, regime shifts), it can reach 40-50%.

**Mitigation:** After BREAKER validates, do real paper trading for at least 2 weeks before committing capital. Paper trading with real orders (not backtest) reveals true slippage. Slippage checklist is part of the Capital Deployment gate.

### 16.5 BREAKER's research phase may introduce noise

When BREAKER stalls and goes to the research phase, it searches the web. The problem: 90% of content about "trading strategies" online is junk. Affiliate blog posts, courses selling indicators, gurus with no verifiable track record.

**Real risk:** BREAKER imports a "new idea" from a bad blog, that idea adds 3 variables, the backtest improves due to overfit, and now the strategy has a layer of complexity based on blog wisdom.

**Mitigation:**
- When reviewing research phase output, verify: does the idea make logical sense? Or is it just "add indicator X because a blog said so"?
- Whitelist: domain on the list -> finding goes directly. Domain not on the list -> marked as `[UNVERIFIED SOURCE]`

### 16.6 "Do Not Trade" is the hardest to follow

Psychologically, it is much harder NOT to trade than to trade poorly. Especially when:
- BREAKER found a strategy that "works" in backtest
- You are looking at the chart and "see" a setup
- You had 2 losses and want to recover

**Real risk:** Ignoring the no-trade rule and trading in an uncertain regime, destroying the edge of the other modules.

**Mitigation:** The orchestrator is the solution. If the system did not generate a signal, do not trade. No discretionary trading. The system decides, not the human. The orchestrator enforces this automatically.

### 16.7 Temporal overfit risk

BREAKER runs on a fixed date range of historical data. If that range includes an atypical period (crash, rally, chop), the strategy may be optimized for that specific regime.

**Real risk:** Strategy that works in "BTC chopping between 90k-100k" but breaks when BTC is in a strong trend.

**Mitigation:**
- Use the longest possible range (6+ months)
- OOS Historical + OOS Future validation on different periods
- If possible, test across 2-3 different regimes (one trending, one ranging, one mixed)

### 16.8 Accidental complexity via research + restructure

BREAKER's research and restructure phases are powerful but dangerous. Each can add indicators, filters, or change the structural logic. After 15 iterations, the strategy may have accumulated 10+ variables without anyone noticing.

**Real risk:** Death by a thousand cuts. Each individual change seemed reasonable, but the accumulation is a fragile strategy with too many moving parts.

**Mitigation:** The `maxFreeVariables` gate (MR=6, Breakout=8) + rejection of +2/iteration in refine limits this. Before declaring success, count the tunable parameters in the final strategy config. If it exceeded the profile limit, simplify by removing those with the least impact (ablation test: remove 1 at a time and see which makes the least difference -> candidate to cut).

### 16.9 Leverage amplifies behavioral errors

Leverage is a capital efficiency tool, not a profit multiplier. But psychologically it acts as one: seeing a larger notional position makes losses feel bigger, triggering revenge trading, premature stop-moving, or position increases.

**Real risk:** A trader using 5x leverage who experiences a normal 3-trade losing streak (-3R = -3% of account) sees -15% drawdown on the position's notional value. This "feels" much worse than it is and triggers emotional overrides.

**Mitigation:**
- Hard cap at 5x in the playbook (see Leverage Policy section). Even 5x is only allowed after 3+ months of profitable live trading.
- Ramp-up: start at 2x during Capital Deployment. Increase only after confirming emotional stability under drawdown.
- Always think in R (risk units), never in $ notional. The leverage is invisible if your risk per trade is always 1% of account.
- Isolated margin only: prevents one module's loss from liquidating another module's position.

---

## 17. References

### Principles
- [Simple vs Complex Trading Strategies](https://www.quantifiedstrategies.com/simple-vs-complex-trading-strategies/) -- QuantifiedStrategies
- [Why Simple Strategies Win](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness) -- TradersPost
- [Overfitting in Trading](https://www.luxalgo.com/blog/what-is-overfitting-in-trading-strategies/) -- LuxAlgo
- [Avoid Overfitting](http://adventuresofgreg.com/blog/2025/12/18/avoid-overfitting-testing-trading-rules/) -- Adventures of Greg

### ADX (limitations)
- [ADX Harsh Realities](https://medium.com/@tradingtruths/the-harsh-realities-of-using-the-adx-indicator-in-trading-7f009cc7a76b) -- Medium
- [ADX Limitations](https://www.avatrade.com/education/technical-analysis-indicators-strategies/adx-indicator-trading-strategies) -- AvaTrade
- [ADX on Fast Timeframes](https://www.chartguys.com/articles/adx-indicator) -- ChartGuys

### Breakout
- [Original Turtle Trading Rules](https://oxfordstrat.com/coasdfASD32/uploads/2016/01/turtle-rules.pdf) -- Curtis Faith, OriginalTurtles.org. Donchian channel breakout, intraday entry (no close confirmation), N-based position sizing
- [Donchian + low ADX on BTC daily](https://www.quantifiedstrategies.com/how-we-built-a-bitcoin-trend-following-strategy-using-chatgpt/) -- QuantifiedStrategies. Backtested with positive results (summary accessible, detailed rules paywalled)
- Murphy, J. J. -- Technical Analysis of the Financial Markets. Volume confirmation as foundational principle of breakout validity
- [Wyckoff Method](https://www.wyckoffanalytics.com/wyckoff-method) -- Wyckoff Analytics. Upthrust (price pierces resistance, closes back inside) as classic false breakout / distribution signal
- [Opening Range Breakout (ORB)](https://www.investopedia.com/terms/o/opening-range.asp) -- Investopedia. Definition: high/low of the first N minutes after session open
- [ChartScout: 7-Point Fakeout Detection Checklist](https://www.binance.com/en/square/post/291147927451089) -- Binance Square. Educational content, source of the ~60-70% false breakout estimate (not canonical)
- [Breakout Trading: How Low Win-Rate Systems Beat the Market](https://www.tradingview.com/chart/XAUUSD/tDeNSCEn-Breakout-Trading-How-Low-Win-Rate-Systems-Beat-the-Market/) -- TradingView (Zeiierman). Breakout WR typically 20-40%, profitability from asymmetric R:R
- [Profit Factor vs Win Rate vs Payoff Ratio](https://www.backtestbase.com/education/win-rate-vs-profit-factor) -- BacktestBase. "30-40% WR can be highly profitable if PF exceeds 1.5"

### External data
- [Kaiko 2025: Bitcoin Booms in Low-Risk Environment](https://research.kaiko.com/insights/bitcoin-booms-in-low-risk-environment) -- 55% of BTC-USD volume in US hours (up from 39% in 2020), weekend volume ~13%
- [Amberdata 2023: Trading Between Hours - Volatility Dispersion Across Multiple Regions](https://blog.amberdata.io/trading-between-hours-volatility-dispersion-across-multiple-regions) -- BTC/USDT Binance hourly volume/volatility by region, GK volatility analysis (single exchange, single pair)
- [Amberdata 2023: Trading Between Hours - Crypto Volatility Dispersion Across Exchanges](https://blog.amberdata.io/trading-between-hours-volatility-dispersion-across-exchanges) -- Multi-exchange comparison (Binance, Coinbase, Bybit, Kraken, OKX, HTX). Shows broadly similar patterns except OKX outlier. GK peaks vary by exchange
- Wen et al. 2022: momentum + reversion coexist in crypto (academic paper)