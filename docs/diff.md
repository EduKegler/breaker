---
  KB Drift Report — 2026-03-04

  Comparação completa entre docs/knowledge-base.md (v4.5) e o codebase real.

  ★ Insight ─────────────────────────────────────
  A análise cruzou ~1400 linhas de KB contra ~70+ arquivos em 7 packages. O KB é um documento vivo que define o "ideal" do BREAKER,
  mas o código evoluiu independentemente em vários pontos. Os drifts mais críticos estão nas features de proteção (DNT) que o KB
  considera essenciais mas não existem no código.
  ─────────────────────────────────────────────────

  ---
  1. KB Espera, Código NÃO Faz

  1.1 🔴 Módulo 5: Do Not Trade — NÃO IMPLEMENTADO

  KB §7.1-7.3 define módulo completo com poder de veto.

  ┌────────────────────────────────────────────┬─────────────────┬───────────────────────────────────────────────┬──────────────┐
  │                 Componente                 │     KB ref      │                    Status                     │ Complexidade │
  ├────────────────────────────────────────────┼─────────────────┼───────────────────────────────────────────────┼──────────────┤
  │ Squeeze detection (BB inside KC → block    │ §7.1.1, §14.2   │ ❌ Não existe. BB indicator também não existe │ 🟡 Média     │
  │ all)                                       │                 │                                               │              │
  ├────────────────────────────────────────────┼─────────────────┼───────────────────────────────────────────────┼──────────────┤
  │ Volatility spike filter (price > X% em Y   │ §7.1.2, §7.2    │ ❌ Não existe em nenhum lugar                 │ 🟡 Média     │
  │ bars → pause Z bars)                       │                 │                                               │              │
  ├────────────────────────────────────────────┼─────────────────┼───────────────────────────────────────────────┼──────────────┤
  │ Daily loss force-close (fechar posições    │ §7.1.3, §2.5.4  │ ⚠️  Parcial — bloqueia novas entradas mas NÃO  │ 🟢 Baixa     │
  │ abertas)                                   │ Gate 1          │ fecha posições abertas                        │              │
  ├────────────────────────────────────────────┼─────────────────┼───────────────────────────────────────────────┼──────────────┤
  │ Weekend filter (Sat-Sun UTC, optional)     │ §7.1.4          │ ❌ Não existe                                 │ 🟢 Baixa     │
  └────────────────────────────────────────────┴─────────────────┴───────────────────────────────────────────────┴──────────────┘

  Impacto: O sistema opera sem proteção contra CPI, FOMC, hacks, cascatas de liquidação. O KB diz: "This is not weakness, it is
  discipline."

  ---
  1.2 🔴 Estratégia Trend Following (M4) — NÃO IMPLEMENTADA

  KB §6 tem especificação completa.

  ┌───────────────────────────────────┬───────────────────────────────────┬──────────────┐
  │            Componente             │              Status               │ Complexidade │
  ├───────────────────────────────────┼───────────────────────────────────┼──────────────┤
  │ SuperTrend indicator              │ ❌                                │ 🟡 Média     │
  ├───────────────────────────────────┼───────────────────────────────────┼──────────────┤
  │ Chandelier Exit indicator         │ ❌                                │ 🟡 Média     │
  ├───────────────────────────────────┼───────────────────────────────────┼──────────────┤
  │ Strategy trend-following.ts       │ ❌                                │ 🔴 Alta      │
  ├───────────────────────────────────┼───────────────────────────────────┼──────────────┤
  │ Funding rate dinâmico no backtest │ ⚠️  Existe mas estático (0.04%/8h) │ 🟡 Média     │
  └───────────────────────────────────┴───────────────────────────────────┴──────────────┘

  Nota: KB Phase 4 (§15) diz que M4 vem depois de M1+M2+M3 passarem Paper Trade Gate. Esperado que não exista ainda, mas os
  indicators deveriam ser preparados.

  ---
  1.3 🟡 Bollinger Bands — Indicador Ausente

  KB §4.2, §7.1.1, §14.2 referencia BB extensivamente. Necessário para squeeze detection (pré-requisito do DNT). Não existe em
  packages/backtest/src/indicators/.

  ---
  1.4 🟡 Pullback Depth Filter — AUSENTE (mandatory)

  KB §5.1 rule 4: "Define what constitutes a valid pullback vs noise vs reversal. Too shallow (<23%) = noise. Too deep (>78.6%) =
  reversal."

  ema-pullback.ts não tem nenhum filtro de profundidade de pullback. Entra apenas quando close cruza EMA fast + RSI check. A regra é
   marcada como mandatory no KB.

  2.3 🟡 Session Tracking sem DST

  KB §8, §14.3: "Define sessions by local timezone [...] Do NOT hardcode UTC"

  get-session-for-hour.ts: mapeamento fixo de horas UTC. Quando DST muda (Mar-Nov), sessões ficam erradas por ~1h. Impacta análise
  de sessão do refiner.

  1. Problemas Adicionais (Racionais/Intuitivos)

  3.1 🔴 Funding Rate Estático no Backtest

  Backtest usa 0.005%/h fixo. Realidade:
  - Calm: 0.005-0.01%/h ✅
  - Bull run: 0.03-0.05%/h (6-10x maior)

  Trade long de 5 dias em bull: custo real ~3-6% vs ~0.6% no backtest. Para M4 (trend following), isso transforma lucro em prejuízo.
   Complexidade: 🔴 Alta

  ---
  3.3 🟡 Janela de 30s sem SL

  Se SL placement falha E compensating close falha: posição fica sem proteção por até 30s (próximo reconcile). Flash crash de 30s em
   BTC = potenciais $200-500+ de perda extra. Complexidade: 🟡 Média

  ---
  3.5 🟡 Cross-Exchange Basis sem Telemetria

  Sinais Binance, execução HL. KB nota divergência "5-15 bps, até 50+ bps". Nenhuma telemetria contínua. Se basis se deteriorar
  sistematicamente, o sistema não detecta. Complexidade: 🟡 Média

  ---
  3.6 ✅ Liquidação sem PnL Recording — RESOLVIDO

  Corrigido: `syncPositionsAndBroadcast`, heartbeat force-close e `POST /close-position` agora chamam `orchestrator.recordClose()`.
  Antes, apenas o ReconcileLoop gravava PnL, mas WS events chegavam primeiro e "comiam" a posição do PositionBook.

  ---
  3.8 🟡 Indicator Warmup vs Live Gap

  Se houver gap entre último candle histórico (warmup) e primeiro WS candle (live), indicadores (EMA, RSI) podem ter "salto" que não
   acontece no backtest. Complexidade: 🟡 Média
