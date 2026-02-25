# BTC Multi-Timeframe Trading Knowledge Base

> **Version:** 4.0 (living document)
> **Last updated:** 2026-02-25
> **Sources:** Cross-research (Claude, GPT, Gemini, Grok) + papers/articles
> **Tool:** BREAKER (loop: test -> analyze -> research -> improve -> test)
> **Status:** Clean slate. BREAKER reset. All previous results archived.

---

## Core Philosophy

**Less is more.** Simple strategies with few variables outperform complex ones out of sample. Each added rule improves the backtest but likely worsens real results. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness), [source](https://www.quantifiedstrategies.com/simple-vs-complex-trading-strategies/))

**Multiple simple strategies > one complex strategy.** Run separate modules for each market regime. Each module is simple on its own; sophistication comes from the combination. ([source](https://blog.traderspost.io/article/simple-trading-strategies-effectiveness))

**Knowing when NOT to trade is as important as trading.** Fewer trades, more selective = better results.

**BREAKER is the final judge, not the AIs.** If backtest numbers contradict the consensus of the 4 AIs, the numbers win. Always.

---

## Strategy Taxonomy

### Testable in BREAKER (Pine + TradingView + BTC multi-timeframe)

| Type | What it does | Signal/Regime TF | BREAKER profile |
|------|-------------|-----------------|-----------------|
| **Mean Reversion** | Price went too far from the mean, bets it comes back. Enters against the move. Works in sideways markets. | 15m / 1H | `mean-reversion` |
| **Breakout** | Price was compressed, bets the breakout generates directional movement. Enters at the explosion. | 15m / 4H-Daily | `breakout` |
| **Trend Continuation** | Trend already exists, waits for a temporary correction, enters on resumption. ABCD, flags, "buy the dip" at EMA. | 15m / 4H | `trend-continuation` |
| **Trend Following** | Follows the dominant direction without waiting for pullback. MA crossovers, supertrend. Swing-style, holds hours to days. | 4H / Daily | `trend-following` |

> **Reversal discarded.** Bets the entire trend reverses (double top/bottom, RSI divergence). Discarded because: (1) insufficient sample size on intraday BTC, (2) highest degradation backtest->live (~35%), (3) hardest to mechanize -- most reversal setups depend on discretionary context (liquidity sweeps, order flow) that Pine cannot capture reliably.

### Not testable in BREAKER (need different infrastructure)

| Type | What it does | Why not |
|------|-------------|---------|
| **Scalping** | Micro-moves of 1-5 candles. Edge from low costs and speed. | Needs 1m/tick, maker-only, low latency. 15m does not work. |
| **Arbitrage** | Price difference between markets (spot vs perp, exchange A vs B). | Needs bots, APIs, low latency. Does not depend on indicators. |
| **Market Making** | Orders on both sides of the book, profits from spread. | Needs HFT, inventory management. Does not work in TradingView. |
| **Pairs / Stat Arb** | Two correlated assets diverge, bets they converge back. | Needs multiple simultaneous assets. Pine does not support well. |
| **Order Flow** | Reads order book, volume delta, footprint charts. | TradingView does not have order book data. |
| **Event-Driven** | Trades around events (FOMC, CPI, halving). | Edge is in the reaction, not indicators. Hard to backtest mechanically. |

### Coverage by regime

```
TRENDING REGIME    ->  Breakout -- captures START of the move
                       Trend Continuation -- captures MIDDLE of the move (pullbacks)
                       Trend Following (4H/Daily, swing) -- captures DURATION of the move
RANGING REGIME     ->  Mean Reversion
UNCERTAIN REGIME   ->  Do not trade
```

### Signal overlap between modules

When multiple modules are active, signals may coincide. This is not a problem -- it is confirmation.

**Same direction (confirmation):** Breakout goes long + TC also goes long = two independent systems agreeing on direction. More conviction.

**Opposite direction (conflict):** MR says short + Breakout says long. Simple rule: one position at a time. If already in a position, other module does not enter.

**No complex arbitration needed between modules.** Simple mutex rule: one position at a time, first signal wins. See Enforceability Matrix for how this is (and isn't) enforced.

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

## Stopping Criteria per Strategy Type

> **Targets** based on research: PF 1.6-1.8 is realistic for daily/4H timeframes but not for intraday crypto. Sources: QuantifiedStrategies (PF 1.75+ optimal but 1.2+ tradable), TheRobustTrader (1.4-2.0 comfortable range), Freqtrade community (intraday PF 1.07-1.24 common).

| Metric | Mean Reversion | Breakout | Trend Continuation | Trend Following |
|---------|---------------|----------|-------------------|-----------------|
| **Signal TF** | 15m | 15m | 15m | 4H |
| **Regime TF** | 1H | 4H-Daily | 4H | Daily |
| **PF** | >= 1.3 | >= 1.3 | >= 1.4 | >= 1.4 |
| **DD** | <= 8% | <= 10% | <= 10% | <= 12% |
| **WR** | >= 50% | >= 35% | >= 40% | >= 35% |
| **Trades** | >= 80 | >= 50 | >= 50 | >= 30 |
| **PnL** | > 0 | > 0 | > 0 | > 0 |
| **WF pfRatio** | >= 0.6 | >= 0.6 | >= 0.6 | >= 0.6 |

**Estimated degradation backtest -> live:**

| Type | Min PF | Degradation | Estimated live PF |
|------|--------|-----------|-----------------|
| MR | 1.3 | ~20% | ~1.04 |
| Breakout | 1.3 | ~30% | ~0.91 |
| TC | 1.4 | ~25% | ~1.05 |
| TF | 1.4 | ~30% | ~0.98 |

> **Warning:** At PF 1.3 backtest, live PF after degradation is near breakeven. PF 1.5+ in backtest is needed for real margin (~1.05-1.12 live). Strategies that converge at PF 1.3-1.4 should be treated as marginal. MR degrades less (frequent trades, predictable fills). TF degrades more (longer holds, regime changes mid-trade).

### Promotion Gates

The stopping criteria above are **Research Pass** -- the minimum to keep investigating. A strategy that meets them is not ready for money. Three gates, each harder:

| Gate | What it means | Criteria | Who decides |
|------|-------------|----------|-------------|
| **Research Pass** | Strategy has enough signal to keep optimizing. Not random noise | Meets stopping criteria table above (PF, DD, WR, trades, WF) | BREAKER automatic |
| **Paper Trade Pass** | Strategy is robust enough to test with real market conditions (no capital) | Research Pass + OOS Historical holdout PF >= loop x 0.6 + OOS Future PF >= loop x 0.5 + no session where PF < 0.8 + positive expectancy after fees | Manual validation (5-10 min) |
| **Capital Deployment** | Strategy is ready for real money | Paper Trade Pass + 2-4 weeks paper trading with real orders + slippage checklist: compare real fills vs 2-tick estimate (if real slippage > 2x estimate, flag for review) + no behavioral red flags (revenge trading, skipping signals) + operational discipline confirmed. **Ramp-up:** first 1-2 weeks at 0.25-0.5% risk per trade (not full 1%). Scale to 1% only after confirming live metrics match paper | Manual decision |

---

## Walk-Forward Validation

There are 3 distinct validation methods. They test different things and should not be confused.

**1. WF Internal 70/30 (automatic, in BREAKER)**

Splits exported trades from the backtest period into 70% train / 30% test. Computes `pfRatio = PF_test / PF_train`. If < 0.6, sets `overfitFlag: true`.

- **What it tests:** Whether performance is consistent across the backtest period
- **Limitation:** TradingView runs the strategy over the entire period -- the optimization loop indirectly "sees" the 30% test data through parameter selection. This is a diagnostic, not a true out-of-sample test
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

## BREAKER Guidelines

### Limits per run

- **Max free variables:** MR = 6, Breakout = 8, TC/TF = 8 (hard gate in refine -- rejects +2 per iteration)
- **Max iterations per strategy:** defined in config (recommendation: 15)
- **Walk-forward:** 70/30 split + pfRatio + automatic overfitFlag (>= 10 trades)
- **Session breakdown:** Asia/London/NY/Off-peak with count, WR, PF, PnL in prompt
- **Include real costs:** commission 0.045% (Hyperliquid taker) + slippage 2 ticks in Pine
- **Category lock:** BREAKER cannot change strategy type (e.g. breakout -> trend continuation) without explicit user approval. RESTRUCTURE may change indicators/logic within the same category only

### Session breakdown sanity checks

- MR: operates 24/7, validate that PF is consistent across sessions (not dependent on one specific session)
- Breakout with high PF in London/NY and low PF in Asia = **correct**
- If reversed = suspicious logic

### Red flags in backtest (heuristics, not absolute rules)

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

### Trusted domain whitelist for research

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
| `quantstart.com` | Backtesting biases, walk-forward, transaction costs. Classic quant retail reference |
| `blog.quantinsti.com` | Python-based articles on WFO, backtesting methodology, performance metrics |

**Tier 3 -- Technical / Tools**

| Domain | What it offers |
|---------|---------------|
| `tradingview.com/pine-script-docs` | Official Pine Script v6 documentation |
| `tradingview.com/pine-script-reference` | Complete API reference |
| `luxalgo.com/blog` | Articles on indicators, overfit, algo trading |
| `pinecoders.com` | Official Pine Script community. FAQ + best practices |
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

## Concerns and Real Risks

These are concerns that are not consensus among the AIs, but important enough to document. Some are technical, others are structural.

### 1. Mean Reversion in crypto != Mean Reversion in equities

Most MR literature comes from equities and forex, where mean reversion is a well-documented phenomenon (especially in pairs and ETFs). Crypto is different:
- BTC can trend for weeks without reverting (bull runs, liquidation cascades)
- There is no clear "fundamental value" for the price to "revert" to
- Session VWAP is a fragile anchor -- if the price opened with a gap, the VWAP already starts displaced

**Real risk:** MR in BTC may simply not have enough edge to be consistent.

**Mitigation:** Test first. If BREAKER cannot achieve PF >= 1.3 in 15 iterations with realistic criteria, the honest answer is: MR on 15m BTC does not work well enough. And that is a valid result -- knowing that something does not work saves money.

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

**Mitigation:** Session breakdown will show whether the edge actually exists in Asia. If MR has similar PF across all sessions, the session filter is not adding value.

### 4. The TradingView backtester has real limitations

- **Does not model the order book.** In MR, you enter at extremes -- exactly where liquidity is lowest. The real fill may be worse than the backtest assumes.
- **Slippage is an estimate.** TradingView uses fixed or zero slippage. In BTC perp during Asian session (low liquidity), real slippage can be 2-5x the estimate.
- **15m candles hide microstructure.** A candle that "touched VWAP -2sigma and bounced back" may have been a 2-second wick that you would never catch with a real order.

**Real risk:** Pretty backtest -> ugly live trading. The backtest-live gap is larger in strategies that trade at extremes (like MR). Degradation of 20-30% is a base estimate; in volatile regimes (cascades, regime shifts), it can reach 40-50%.

**Mitigation:** After BREAKER validates, do real paper trading for at least 2 weeks before committing capital. Paper trading with real orders (not backtest) reveals true slippage. Slippage checklist is part of the Paper Trade Pass gate.

### 5. BREAKER's research phase may introduce noise

When BREAKER stalls and goes to the research phase, it searches the web. The problem: 90% of content about "trading strategies" online is junk. Affiliate blog posts, courses selling indicators, gurus with no verifiable track record.

**Real risk:** BREAKER imports a "new idea" from a bad blog, that idea adds 3 variables, the backtest improves due to overfit, and now the strategy has a layer of complexity based on blog wisdom.

**Mitigation:**
- When reviewing research phase output, verify: does the idea make logical sense? Or is it just "add indicator X because a blog said so"?
- Whitelist: domain on the list -> finding goes directly. Domain not on the list -> marked as `[UNVERIFIED SOURCE]`

### 6. "Do Not Trade" is the hardest to follow

Psychologically, it is much harder NOT to trade than to trade poorly. Especially when:
- BREAKER found a strategy that "works" in backtest
- You are looking at the chart and "see" a setup
- You had 2 losses and want to recover

**Real risk:** Ignoring the no-trade rule and trading in an uncertain regime, destroying the edge of the other modules.

**Mitigation:** The webhook (TradingView -> WhatsApp) is the solution. If the alert did not arrive, do not trade. No discretionary trading. The system decides, not the human. The orchestrator (Phase 3) will enforce this automatically.

### 7. Temporal overfit risk

BREAKER runs on TradingView with a fixed date range. If that range includes an atypical period (crash, rally, chop), the strategy may be optimized for that specific regime.

**Real risk:** Strategy that works in "BTC chopping between 90k-100k" but breaks when BTC is in a strong trend.

**Mitigation:**
- Use the longest possible range in TradingView (6+ months)
- OOS Historical + OOS Future validation on different periods
- If possible, test across 2-3 different regimes (one trending, one ranging, one mixed)

### 8. Accidental complexity via research + restructure

BREAKER's research and restructure phases are powerful but dangerous. Each can add indicators, filters, or change the structural logic. After 15 iterations, the strategy may have accumulated 10+ variables without anyone noticing.

**Real risk:** Death by a thousand cuts. Each individual change seemed reasonable, but the accumulation is a fragile strategy with too many moving parts.

**Mitigation:** The `maxFreeVariables` gate (MR=6, Breakout=8) + rejection of +2/iteration in refine limits this. Before declaring success, count the `input()` calls in the final Pine. If it exceeded the profile limit, simplify by removing those with the least impact (ablation test: remove 1 at a time and see which makes the least difference -> candidate to cut).

---

## Backtest Period

| Use | Period | Reason |
|-----|---------|--------|
| **BREAKER loop (optimization)** | Last 6-9 months | Recent data, current market. ~35,000 candles on 15m = plenty of sample |
| **OOS Historical holdout** | 2-3 months before the loop period | Data the loop never touched. Tests generalization to earlier regime |
| **OOS Future** | 1-2 months after the loop period | True forward test. Closest proxy to live performance |
| **Stress test (optional)** | Crash or extreme rally period | Not for optimization -- just to understand DD in extreme scenarios |

**Do not use the entire available history.** Pre-ETF BTC (before Jan/2024) is a structurally different market: liquidity, participants, correlations, and volatility have changed. Optimizing on 2021-2022 data pollutes the model with regimes that no longer exist.

**Do not use less than 6 months.** Risk of capturing only one regime (e.g.: only bull) and incorrectly concluding it works.

---

## Module 1: Breakout

> **When:** Trending market
> **Objective:** Capture directional moves
> **Signal TF:** 15m | **Regime TF:** 4H

### Design: Donchian Channel Breakout + ADX + Higher-TF Regime Filter

**Core idea:** Consolidation on higher timeframe -> breakout confirmed on 15m. A Donchian channel on 15m alone (e.g. dcSlow=50 = only 12.5 hours of data) is insufficient to define meaningful consolidation for BTC -- it captures intraday noise, not real compression. The higher-TF regime filter provides the independent context that 15m alone cannot.

| Indicator | Parameter | Function |
|-----------|-----------|--------|
| Donchian Channel (slow) | dcSlow periods | Entry signal: new high/low breakout |
| Donchian Channel (fast) | dcFast periods | Exit signal: trailing channel stop |
| ADX | 14 periods | Consolidation filter: only enter when ADX < threshold |
| Higher-TF regime filter | EMA50 Daily or 4H consolidation | Regime context: direction and/or compression from higher TF |

```
LONG:  close > DC_upper(slow) AND ADX < adxThreshold AND regime confirms bullish
SHORT: close < DC_lower(slow) AND ADX < adxThreshold AND regime confirms bearish
EXIT LONG:  close < DC_lower(fast) OR SL hit OR timeout
EXIT SHORT: close > DC_upper(fast) OR SL hit OR timeout
STOP:  ATR-based (atrStopMult, safety fallback)
```

### Free variables for BREAKER

Rule: max 8 free variables (breakout profile).

| # | Variable | Range | Function |
|---|----------|-------|----------|
| 1 | dcSlow | 30-60 | Donchian entry channel period |
| 2 | dcFast | 10-25 | Donchian exit channel period (trailing) |
| 3 | adxThreshold | 20-35 | Max ADX to allow entry (consolidation filter) |
| 4 | atrStopMult | 1.5-3.0 | ATR multiplier for safety stop |
| 5 | maxTradesDay | 2-5 | Daily trade limit |

**Total: 5 variables. Regime filter is fixed (not optimized).**

> **Lessons from previous testing:** Same-timeframe directional filters (e.g. DI+/DI-) are strongly colinear with Donchian breakout and add no independent information. Higher-TF regime filters (EMA50 Daily, 4H consolidation) provide independent context. Breakout on 15m alone (without higher-TF context) produces too many false signals.

---

## Module 2: Mean Reversion

> **When:** Sideways market, all sessions (24/7)
> **Objective:** Capture returns to the mean
> **Signal TF:** 15m | **Regime TF:** 1H

### Design: Keltner Channels + RSI(2)

**Core idea:** KC bands define extremes, RSI(2) confirms exhaustion. Ultra-sensitive RSI reacts fast to short-term overextension.

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
STOP:    ATR 1H x multiplier (guardrail minAtrMult)
TP:      KC mid (EMA 20)
TIMEOUT: If TP not reached in N bars, exit
```

**Operational limits:**
- Max trades per day (BREAKER optimizes)
- After 2 consecutive losses: shut down until next day

### Free variables for BREAKER

1. `kcMultiplier` -- KC band multiplier
2. `rsi2Long` -- RSI(2) threshold for long
3. `rsi2Short` -- RSI(2) threshold for short
4. `maxTradesDay` -- 1 to 5
5. `timeoutBars` -- 4 to 16
6. `atrStopMult` -- ATR 1H multiplier for stop (1.0 to 2.5)

**Total: 6 variables. Variable 6 added to address known adverse R:R risk (stop too wide vs TP too close). Max free variables for MR raised from 5 to 6.**

> **Known risk: adverse R:R.** ATR-based stop vs KC mid TP can create R:R < 1.0. This is acceptable IF win rate is high enough to produce positive expectancy. If not, `atrStopMult` (variable 6) and/or TP logic must be reworked.

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
| Asia | 23:00 - 08:00 | Low vol, range | **MR** + potential **Breakout** |
| London | 08:00 - 13:00 | Expansion, breakouts | **Breakout** + **MR** |
| NY | 13:00 - 20:00 | Directional, maximum liquidity | **Breakout** + **MR** |
| Off-peak | 20:00 - 23:00 | Deceleration | **MR only**. Breakout disabled. Lower conviction -- monitor edge here |

> **MR operates 24/7**, including off-peak. Session breakdown monitors whether off-peak edge holds. If MR PF in off-peak is consistently < 1.0, revisit restricting it.
>
> **Breakout is session-restricted:** disabled in off-peak (20:00-23:00 UTC). Low volume = too many false breakouts.

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
- **Ramp-up:** first 1-2 weeks of live trading at 0.25-0.5% risk per trade. Scale to 1% after confirming live metrics match paper
- **Calculation:** position = risk / stop distance

### Iron rules
- Stop on 1H ATR (via request.security), avoid 15m ATR on BTC
- **Positive expectancy required:** (WR x avgWin) > ((1-WR) x avgLoss) after fees. MR can have low R:R + high WR. Breakout/TC/TF naturally have high R:R + low WR. The test is expectancy, not R:R alone
- Hyperliquid fee (0.045% taker) included in every backtest
- Prefer limit orders (maker 0.015%) when possible to reduce cost
- No martingale. No averaging down. No revenge trading.

### Daily limits
- Max daily loss: 2R -> shut down for today
- Max daily trades: 5 across all modules (per-module caps are subordinate internal limits)
- 2 consecutive losses in the same module -> shut down that module until next session

### Enforceability Matrix

Some rules are enforceable per-module in Pine Script. Others require an external orchestrator (webhook handler, Python bot, or manual discipline). This distinction matters because TradingView runs each module as an independent script with no shared state.

| Rule | Enforceable in Pine? | How it works |
|------|---------------------|-------------|
| Per-module maxTradesDay | **Yes** -- counter resets daily in each script | Per-module |
| Per-module consecutive loss gate (2) | **Yes** -- counter in each script | Per-module |
| ATR-based stop | **Yes** -- per-trade in Pine | Per-trade |
| Timeout (N bars) | **Yes** -- per-trade in Pine | Per-trade |
| Global 5 trades/day across modules | **No** -- scripts don't share state | Orchestrator (Phase 3) |
| One position at a time across modules | **No** -- scripts don't see each other | Orchestrator (Phase 3) |
| Daily loss 2R shutdown | **No** -- scripts don't share P&L | Orchestrator (Phase 3) |
| Macro event blackout (CPI/FOMC/NFP) | **No** -- Pine has no calendar | Orchestrator (Phase 3) |

> **Implication:** The orchestrator is planned for Phase 3 (first item before parallel testing). A simple Python script receiving webhooks + economic calendar API solves 80% of these gaps.

---

## Pine v6 -- Reference Snippets

### ATR 1H anti-repaint
```pine
atr1h = request.security(syminfo.tickerid, "60", ta.atr(14)[1], lookahead=barmerge.lookahead_on)
```

### Keltner Channels + RSI(2) (MR)
```pine
[kcMid, kcUp, kcLo] = ta.kc(close, 20, kcMultiplier, true)
rsi2 = ta.rsi(close, 2)
bool longSignal  = close < kcLo and rsi2 < rsi2Long
bool shortSignal = close > kcUp and rsi2 > rsi2Short
```

### Donchian Channel + ADX + Regime Filter (Breakout)
```pine
// Donchian Channels
dcSlowUpper = ta.highest(high, dcSlow)
dcSlowLower = ta.lowest(low, dcSlow)
dcFastUpper = ta.highest(high, dcFast)
dcFastLower = ta.lowest(low, dcFast)

// ADX
[diPlus, diMinus, adxVal] = ta.dmi(14, 14)

// Higher-TF regime filter (anti-repaint) -- example: EMA50 Daily
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

### Squeeze detection (reference)
```pine
[bbMid, bbUp, bbLo] = ta.bb(close, 20, 2.0)
[kcMid, kcUp, kcLo] = ta.kc(close, 20, 1.5, true)
bool squeezeOn = bbLo > kcLo and bbUp < kcUp
```

### Session tracking (reference)
```pine
string tz = "America/New_York"
bool inAsia = not na(time(timeframe.period, "1800-0300:1234567", tz))
bool inNY   = not na(time(timeframe.period, "0930-1600:23456", tz))
bool asiaStart = inAsia and not inAsia[1]
```

---

## Implementation Order

### Phase 1 -- Validate the foundations
- Test Module 1 (Breakout) and Module 2 (MR) candidates individually in BREAKER
- Each module must pass Research Gate before moving to Phase 2

### Phase 2 -- Refine
- Optimize each module toward stopping criteria targets
- Walk-forward validation: OOS Historical + OOS Future
- Each module must pass Paper Trade Gate before moving to Phase 3

### Phase 3 -- Integrate
- Build simple orchestrator (Python): webhook receiver -> daily P&L check -> cross-module mutex -> forward to Hyperliquid. Integrate economic calendar API for auto-blackout (CPI, FOMC, NFP)
- Run modules in parallel
- Verify signal overlap and mutex behavior
- Measure combined result (portfolio PF, combined DD)
- Enforce global limits via orchestrator

### Phase 4 -- Expand coverage
- Trend Continuation: 15m signal, 4H regime. BREAKER profile `trend-continuation`
- Trend Following: 4H signal, Daily regime. Swing trading, not day trading. Profile `trend-following`

### Phase 5 -- Infra
- Automatic regime switcher (Python, not Pine)
- Add more assets if desired (ETH, SOL -- same logic, different parameters)

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

### External data
- Kaiko 2025: BTC volume concentration in US hours (institutional crypto data)
- Wen et al. 2022: momentum + reversion coexist in crypto (academic paper)