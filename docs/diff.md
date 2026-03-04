# KB Drift Report — v4.5 (2026-03-04)

> Gerado por análise cruzada de `docs/knowledge-base.md` contra o codebase.
> **NÃO editar o KB com base neste relatório** — decisões são do usuário.

---

## 1. KB Espera, Código NÃO Faz

### 1.1 🔴 [§6] Module 4 — Trend Following NÃO EXISTE

**Complexidade:** 🔴 Alta (5-10 dias)

KB §6 define M4 como estratégia ativa (Phase 4) com SuperTrend 4H, ADX Daily, ATR Daily stop ≥3.0, trailing exit (Chandelier), funding rate modeling, timeout em dias. Nenhum arquivo de estratégia M4 encontrado em `packages/backtest/src/strategies/`. Indicadores necessários (SuperTrend, Chandelier Exit, MACD) também não existem.

**Impacto:** Cobertura de regime incompleta — falta "duration of moves" (dias/semanas).

---

### 1.2 🔴 [§5.1 regra 4] M3 Pullback — Fibonacci Depth Filter OBRIGATÓRIO ausente

**Complexidade:** 🟡 Média (1-3 dias)

KB §5.1 regra 4: *"Pullback depth filter: mandatory. Too shallow (<~23%) = noise. Too deep (>~78.6% Fib) = reversal."*

`ema-pullback.ts` apenas verifica:

```typescript
prevClose < prevEmaFast && close > currEmaFast
```

Não filtra profundidade do pullback. Entra em toda correção indiscriminadamente. Indicador de Fibonacci retracement também não existe.

**Impacto:** Entradas em noise (micro-dips) e reversals (pullbacks profundos demais).

---

### 1.3 🔴 [§7.1 regra 1] M5 Squeeze Detection — Bollinger Bands NÃO EXISTE

**Complexidade:** 🟡 Média (2-3 dias)

KB §7.1: *"BB(20, 2.0) inside KC(20, 1.5) on 15m AND BB width decreasing for ≥4 bars"*

Indicador Bollinger Bands não existe em `packages/backtest/src/indicators/`. Keltner Channel existe, mas sem BB o squeeze detection (BB inside KC) é impossível. Gate 1 do M5 (DNT) não pode funcionar.

**Impacto:** Sistema pode entrar em períodos de compressão extrema — pior cenário para breakout.

---

### 1.4 🟡 [§2.5.4 Gate 3] Volatility Spike Gate NÃO IMPLEMENTADO

**Complexidade:** 🟡 Média (1-3 dias)

KB §7.2 define: *"If price moved >X% in Y bars → block all entries for Z bars"*. KB §2.5.5 especifica que o risk loop de 30s deveria checar volatility spike. Nenhuma referência a volatility spike no orchestrator ou strategy-runner. Gates 1 (daily loss), 2 (trade count), 4 (mutex), 5 (cooldown) estão implementados. Gate 3 está ausente.

**Impacto:** Sistema pode entrar durante flash crashes, CPI, FOMC sem proteção.

---

### 1.5 🟡 [§8, §14.3] Session Tracking — NÃO IMPLEMENTADO (business logic)

**Complexidade:** 🟡 Média (1-3 dias)

KB §14.3 especifica `timeUtils.inSession()` com timezones locais (Asia/Tokyo, Europe/London, America/New_York) e conversão DST dinâmica. Não existe nenhuma utilidade de sessão no backtest ou exchange. Apenas um componente de UI no explorer (`session-highlight.ts`) com horas UTC hardcoded para visualização.

**Impacto:** Sem breakdown de PF/WR por sessão para diagnóstico BREAKER. KB diz que é diagnóstico (não gate), mas é input para análise.

---

## 2. Discrepâncias KB vs Código

### 2.1 🟡 `maxRiskTradeUsd: 25` no Refiner vs KB `$10`

**Complexidade:** 🟢 Baixa (< 1 dia)

KB §1.6: `riskPerTradeUsd = $10` (default). `breaker-config.json` linha 80: `maxRiskTradeUsd: 25`. `exchange-config.json` linha 52: `riskPerTradeUsd: 10` (correto).

O refiner permite otimizar estratégias com risco de até $25/trade, mas o daemon executa com $10. Estratégias otimizadas para $25 terão sizing diferente em produção.

**Impacto:** Degradação de performance não modelada na transição backtest→live.

---

### 2.2 🟢 RWA Asset Class `minPF: 1.2` < KB minimum 1.3

**Complexidade:** 🟢 Baixa (< 1 dia)

KB §10.1: *"If config is less strict than KB, that is a bug."* `breaker-config.json` define `rwa` asset class com `minPF: 1.2`. KB baseline mínimo é 1.3.

**Nota:** `rwa` não é crypto — pode ter justificativa. Se intencional, documentar override explícito.

---

### 2.3 🟢 Cooldown — Per-StrategyRunner, não centralizado no orchestrator

**Complexidade:** 🟢 Baixa (< 1 dia)

KB §2.5.4 Gate 5: *"Cooldown per-module per-asset"*. Implementação: `barsSinceExit` vive em cada `StrategyRunner` (per-asset). Funciona corretamente no design atual (1 module per runner per asset), mas não é enforcement centralizado na orquestração.

**Impacto:** Baixo — funciona no design atual. Pode precisar refatorar se múltiplos modules por asset forem adicionados.

---

## 3. Problemas Adicionais (Racionais/Intuitivos)

### 3.1 🟡 Explorer Session Highlight usa UTC hardcoded

**Complexidade:** 🟢 Baixa (< 1 dia)

`packages/explorer/src/lib/primitives/session-highlight.ts` define sessões como Asia (0-8 UTC), Europe (7-16 UTC), America (13-22 UTC) — valores fixos. KB §8: *"Do NOT hardcode UTC — DST breaks hardcoded values."* Durante US/EU DST (Mar-Nov), as sessões estão ~1h erradas no gráfico.

---

### 3.2 🟢 Funding rate no backtest é fixo (0.0004/8h)

**Complexidade:** 🟢 Baixa (< 1 dia)

`execution-model.ts` usa `fundingRate8h: 0.0004` (fixo, calm-market). KB §6.1 regra 3 exige modelagem explícita para M4 (swing trades de dias): *"At bull-market spike rates, costs can reach 0.72-1.20% daily."* Para M1-M3 (1-12h holds) o impacto é mínimo, mas M4 quando implementado precisará de funding dinâmico ou conservador.

---

## 4. Matches Confirmados ✅

| Aspecto | KB | Código | Status |
|---------|-----|--------|--------|
| M1 Donchian: max 8 vars | §3.1 r1 | 6 vars | ✅ |
| M1: HTF regime filter | §3.1 r2 | EMA(200) Daily | ✅ |
| M1: Volume confirmation | §3.1 r3 | Vol > 1.5x SMA(20) | ✅ |
| M1: Candle close confirmation | §3.1 r4 | `c > prevSlowUpper` | ✅ |
| M1: Timeout exit | §3.1 r5, range 24-96 bars, rec. 48 | 20 bars default | ⚠️ Abaixo do range — confirmar se resultado de otimização BREAKER |
| M1: ATR 1H stop | §3.1 r6 | ATR(14) 1H × 3.0 | ✅ |
| M2 Keltner: max 6 vars | §4.1 r1 | 6 vars | ✅ |
| M2: Band/channel extreme | §4.1 r2 | Keltner Channel | ✅ |
| M2: Regime filter (ranging) | §4.1 r3 | ADX < 25 em 1H | ✅ |
| M2: Wide/catastrophic stop | §4.1 r4 | 3.0x ATR 1H | ✅ |
| M2: Timeout exit | §4.1 r5, range 12-48 bars | 8 bars default | ⚠️ Abaixo do range — confirmar se resultado de otimização BREAKER |
| M2: 24/7 operation | §4.1 r8 | Sem time gate | ✅ |
| M2: Long/short asymmetry | §4.1 r7 | rsi2Long ≠ rsi2Short | ✅ |
| M3: max 8 vars | §5.1 r1 | 6 vars | ✅ |
| M3: HTF trend confirmation | §5.1 r2 | EMA(21) 4H | ✅ |
| M3: Pullback confirmation | §5.1 r3 | EMA fast cross | ✅ |
| M3: ATR 1H stop | §5.1 r6 | ATR(14) 1H × 2.5 | ✅ |
| M3: Timeout exit | §5.1 r7 | 30 bars default | ✅ |
| Orch: Priority M1>M3>M2>M4 | §2.5.1 | breakout(4)>pullback(3)>mr(2)>tf(1) | ✅ |
| Orch: Opposite direction skip | §2.5.1 | Ambos rejeitados | ✅ |
| Orch: Daily loss gate + force close | §2.5.4 G1 | Block entries + heartbeat 30s | ✅ |
| Orch: Max 5 trades/day global | §2.5.4 G2 | Cross-coin counter | ✅ |
| Orch: Mutex 1 pos/asset | §2.5.4 G4 | pendingCoins + positionBook + pendingEntryBook | ✅ |
| Orch: Risk loop 30s | §2.5.5 | HEARTBEAT_MS = 30000 | ✅ |
| Config: maxDailyLossR = 2 | §1.6 | exchange-config.json | ✅ |
| Config: maxTradesPerDay = 5 | §1.6 | exchange-config.json | ✅ |
| Config: riskPerTradeUsd = 10 | §1.6 | exchange-config.json | ✅ |
| Config: maxLeverage = 5 | §9.3 | exchange-config.json | ✅ |
| Backtest: slippage 10 bps | §1.6 | execution-model.ts | ✅ |
| Backtest: commission 0.045% | §1.6 | execution-model.ts | ✅ |
| Backtest: fundingRate8h 0.0004 | §9.1 | execution-model.ts | ✅ |
| Daemon: entrySlippageBps 50 | §1.6 | exchange-config.json | ✅ |
| Orders: M1/M4 = IOC, M2/M3 = ALO | §9.8 | handle-signal.ts bifurcation | ✅ |
| Orders: ALO rejected → NO IOC fallback | §9.8 | handle-signal.ts:228-243 | ✅ |
| Orders: GTC expires after 2 bars | §9.8 | strategy-runner.ts:482-510 | ✅ |
| Orders: Cooldown after stop (bars) | §9.8 | barsSinceExit in strategy-runner | ✅ |
| PnL: recorded on ALL close paths | §9.7 | 8 paths verified | ✅ |
| Stopping criteria: ALL profiles aligned | §10.1 | breaker-config.json | ✅ |
| WF: pfRatio ≥ 0.6, overfitFlag | §11 | breaker-config.json | ✅ |

---

## 5. Resumo de Prioridades

### 🔴 Must Fix (violação de regra obrigatória KB)

| # | Item | KB Ref | Complexidade |
|---|------|--------|-------------|
| 1 | M3 Fibonacci depth filter (regra obrigatória ausente) | §5.1 r4 | 🟡 Média |
| 2 | `maxRiskTradeUsd: 25` no refiner (KB diz $10) | §1.6 | 🟢 Baixa |

### 🟡 Should Implement (features KB missing, próximos sprints)

| # | Item | KB Ref | Complexidade |
|---|------|--------|-------------|
| 3 | Bollinger Bands indicator + M5 squeeze detection | §7.1 | 🟡 Média |
| 4 | Volatility spike gate (Gate 3 do orchestrator) | §2.5.4, §7.2 | 🟡 Média |
| 5 | Session tracking utility (business logic, DST) | §8, §14.3 | 🟡 Média |
| 6 | Fix explorer session-highlight UTC hardcoded | §8 | 🟢 Baixa |
| 7 | RWA asset class minPF 1.2 → 1.3 (ou documentar override) | §10.1 | 🟢 Baixa |

### 🔵 Future (Phase 4+)

| # | Item | KB Ref | Complexidade |
|---|------|--------|-------------|
| 8 | M4 Trend Following (estratégia + indicadores: SuperTrend, Chandelier, MACD) | §6 | 🔴 Alta |
| 9 | Fibonacci retracement indicator (para M3 depth filter) | §5.2 | 🟡 Média |
| 10 | Funding rate dinâmico para M4 swing trades | §6.1 r3 | 🟡 Média |
