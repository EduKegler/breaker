---
name: kb-drift
description: Check knowledge base for drift against codebase. Use when the user says "kb drift", "verifica kb", "knowledge base check", "drift check", "checa o kb", "kb desatualizado", or wants to verify if the knowledge base matches the code.
allowed-tools: "Read, Glob, Grep, Agent"
---

# Knowledge Base Drift Check — Deep Analysis

Cross-check `docs/knowledge-base.md` against the actual codebase to find:
1. **KB expects, code doesn't do** — features/rules described in KB that are not implemented
2. **Code does, KB doesn't mention** — features that exist in code but KB doesn't describe
3. **Discrepancies** — where KB and code disagree on values, behavior, or architecture
4. **Additional problems** — rational/intuitive issues discovered during analysis

## Complexity Levels

Each finding MUST include a complexity estimate:
- 🔴 **Alta** (3-10 dias): novo módulo/indicador, mudanças cross-package, testes extensos
- 🟡 **Média** (1-3 dias): mudança localizada em 1-2 arquivos, testes moderados
- 🟢 **Baixa** (< 1 dia): config, ajuste de parâmetro, ou mudança trivial

## Steps

### 1. Read the Knowledge Base

Read `docs/knowledge-base.md` in chunks (file is ~1400 lines). Focus on:
- §1.6 Canonical Parameters (fees, slippage, risk, stops, variable caps)
- §2.5 Orchestrator Specification (mutex, priority, global gates)
- §3-7 Module specifications (fixed rules, strategy candidates, stopping criteria)
- §9 Risk Management (sizing, leverage, iron rules, daily limits, enforceability matrix, trade lifecycle, order management, drawdown recovery)
- §10 Stopping Criteria & Promotion Gates
- §13 BREAKER Guidelines (limits per run, red flags)
- §14 Strategy Logic Reference (ATR, squeeze, session tracking)

If the file doesn't exist, inform the user and STOP.

### 2. Deep codebase exploration

Use Agent (Explore) subagents **in parallel** to check ALL of these areas:

#### a) Strategy implementations vs KB module rules
- Read ALL strategy `.ts` files in `packages/backtest/src/strategies/`
- For EACH strategy, cross-check against its KB module fixed rules:
  - **M1 Breakout** (KB §3.1): volume confirmation mandatory? candle close confirmation? HTF regime filter? timeout exit? ATR 1H stop? free var count ≤ 8?
  - **M2 Mean Reversion** (KB §4.1): band/channel extreme? regime filter (ADX < threshold)? wide/no stop? timeout? 24/7 operation? free var count ≤ 6?
  - **M3 Pullback** (KB §5.1): HTF trend confirmation 4H+? pullback confirmation? **pullback depth filter (Fibonacci, mandatory)**? ATR 1H stop? timeout? free var count ≤ 8?
  - **M4 Trend Following** (KB §6.1): does it even exist? SuperTrend/MACD? Daily ATR stop ≥ 3.0? trailing exits? funding cost modeling? ADX Daily filter? free var count ≤ 6?
  - **M5 Do Not Trade** (KB §7): squeeze detection? volatility spike filter? weekend filter? daily loss force-close?
- Check that param names, ranges (min/max), defaults, and timeframes match KB

#### b) Indicators availability
- List ALL indicators in `packages/backtest/src/indicators/`
- Check which KB-referenced indicators are **missing**:
  - Bollinger Bands (needed for §7.1.1 squeeze, §4.2 MR candidate)
  - SuperTrend (needed for §6.2 TF signal)
  - Chandelier Exit (needed for §6.2 TF trailing)
  - Williams %R (§4.2 MR candidate — optional)
  - MACD (§6.2 TF candidate — optional)

#### c) Orchestrator behavior vs KB §2.5
- Read `packages/exchange/src/domain/orchestrator.ts`
- Verify:
  - Module priority order: M1 > M3 > M2 > M4 (§2.5.1)
  - Same bar conflict resolution (§2.5.1)
  - **Daily loss gate: block entries AND force-close positions?** (§2.5.4 Gate 1)
  - **Volatility spike gate** (§2.5.4 Gate 3)
  - **Cooldown per-module per-asset** (§2.5.4 Gate 5)
  - Risk loop runs every 30s (§2.5.5)

#### d) Config values vs KB
- Read `packages/refiner/breaker-config.json`
- Compare EVERY metric in KB §10.1 stopping criteria table against config:
  - Per-profile: minPF, maxDD, minWR, minTrades, minAvgR, maxFreeVariables
  - KB §10.1 note: "If config is less strict than KB, that is a **bug**"
- Check for phantom profiles (profiles in config that KB discards/doesn't define)
- Compare guardrails (maxAtrMult, minAtrMult, globalMaxTradesDay)

#### e) Risk & operational rules
- Read `packages/exchange/src/domain/check-risk.ts` and `signal-to-intent.ts`
- Compare against KB §9 (sizing, leverage, iron rules, daily limits)
- Check trade lifecycle (§9.7) implementation
- Check order management (§9.8): order types per module, partial fills, stale signals
- Check drawdown recovery (§9.9): daily loss → shut down + force close

#### f) Backtest execution model vs KB §1.6
- Read `packages/backtest/src/engine/execution-model.ts`
- Compare: slippage, commission, funding rate values
- Check: KB §9.1 says "Not modeled in backtest by default" for funding — does code agree?

#### g) Session tracking vs KB §8, §14.3
- Check if session detection uses local timezones with DST or hardcoded UTC
- KB is emphatic: "Do NOT hardcode UTC — DST breaks hardcoded values"

### 3. Identify additional problems

Beyond KB drift, look for rational/intuitive problems:
- **Race conditions**: daily reset timing, trailing SL order window, reconcile loop gaps
- **Silent failures**: what happens when critical operations fail? Are there gaps?
- **Correlation risk**: multi-asset positions during correlated crashes
- **Static vs dynamic models**: funding rate, basis risk, volatility assumptions
- **Edge cases**: liquidation without PnL recording, candle gaps, ALO rejections in fast markets

### 4. Report findings

Present a structured report with FOUR sections:

```
## 1. KB Espera, Código NÃO Faz
For each: [KB section] description, what's missing, complexity level

## 2. Discrepâncias KB vs Código
For each: [KB section] KB says X, code says Y, impact, complexity level

## 3. Problemas Adicionais (Racionais/Intuitivos)
For each: description, scenario, impact, complexity level

## 4. Matches Confirmados ✅
Table of verified matches between KB and code

## 5. Resumo de Prioridades
- Must Fix (KB says it's a bug or mandatory rule violation)
- Should Implement (missing KB features, next sprints)
- Future (Phase 4+ features)
```

**DO NOT update** `knowledge-base.md` — only list findings so the user can decide what to fix.
**DO NOT write to** `docs/diff.md` — present the report directly in conversation.
