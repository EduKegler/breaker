Investigação: Knowledge Base vs Realidade do BREAKER                                          

  ---
  PARTE 2 — Features inteiros do KB que NÃO existem

  1. Module 5: Do Not Trade — ZERO implementação

  O KB define 5 condições DNT (§7.1). Nenhuma está implementada:

  ┌─────┬──────────────────────────────────────┬──────────────────────────────┐
  │  #  │             Condição KB              │            Status            │
  ├─────┼──────────────────────────────────────┼──────────────────────────────┤
  │ 1   │ Active squeeze (BB inside KC)        │ NÃO EXISTE                   │
  ├─────┼──────────────────────────────────────┼──────────────────────────────┤
  │ 2   │ Macro events (CPI/FOMC/NFP) blackout │ NÃO EXISTE                   │
  ├─────┼──────────────────────────────────────┼──────────────────────────────┤
  │ 3   │ Daily loss limit                     │ ✅ Existe (via orchestrator) │
  ├─────┼──────────────────────────────────────┼──────────────────────────────┤
  │ 4   │ Low-liquidity gate 02:00-06:00 UTC   │ NÃO EXISTE                   │
  ├─────┼──────────────────────────────────────┼──────────────────────────────┤
  │ 5   │ Weekend blocking                     │ NÃO EXISTE                   │
  └─────┴──────────────────────────────────────┴──────────────────────────────┘

  Gravidade: ALTA — Saber quando NÃO operar é central à filosofia do KB ("Knowing when NOT to
  trade is as important as trading").

  ---
  9. Module 4: Trend Following — NÃO implementado

  KB §6: Módulo completo de trend following em 4H/Daily com SuperTrend, ADX, Chandelier Exit,
  modelagem de funding rate.

  Realidade: Nenhum arquivo, nenhuma strategy, nenhum código. Está no roadmap (Phase 4) mas não
  existe.

  Gravidade: N/A (é roadmap). Mas é importante saber que ~25% da cobertura de regime (trending
  duration) não existe.

  ---
  10. Funding Rate — ZERO tracking

  KB §6.1 regra 3 e §1.6:
  "BREAKER must subtract estimated funding from PnL"

  Realidade: Grep por "funding" em packages/exchange/src/ e packages/backtest/src/ retorna ZERO
  resultados. Nem backtest nem daemon rastreiam ou modelam funding rate.

  Gravidade: BAIXA para M1-M3 (trades de 1-8h, funding é desprezível). Será CRÍTICA se/quando M4
   for implementado (trades de dias, funding pode custar 1-6%).


  PARTE 3 — Divergências operacionais

  1.  Signal Priority: Fixed Rank vs PF-based

  KB §2.5.1:
  "Highest-PF module (from last BREAKER run) gets the entry"

  Realidade: O daemon usa prioridade fixa: breakout=4 > pullback=3 > mean-reversion=2 >
  trend-following=1. Nunca consulta PF histórico.

  Gravidade: BAIXA — Com poucas estratégias, isso é adequado. A prioridade fixa é mais simples e
   determinística.

  ---
  1.  Partial Fill Handling — NÃO existe

  KB §9.8:
  "If entry order partially fills within 2 bars, cancel remainder and trade the filled size"

  Realidade: O daemon não tem lógica de partial fill detection ou auto-cancel. Se uma entry IOC
  enche parcialmente, o comportamento é indeterminado.

  Gravidade: BAIXA — IOC por definição cancela unfilled portion. Mas se a lógica post-entry
  assume full fill para calcular SL/TP sizes, pode haver inconsistência.


  1.  Orchestrator State: Resets on Restart

  Realidade: Daily PnL, trade count, consecutive losses, e module pause state vivem em memória.
  Se o daemon restartar, tudo zera.

  Gravidade: MÉDIA — Um restart meio do dia reseta o daily loss limit, permitindo potencialmente
   mais trades/risco do que o planejado.

 
  ---
  PARTE 4 — Problemas que eu identifico por análise racional

  1.  Refiner atrStopMult range permite violação do KB

  O breaker-config.json define para breakout: atrStopMult: { min: 1.5, max: 3.0 }. O KB diz
  mínimo 3.0. Isso significa que o refiner pode legitimamente otimizar o ATR mult para 1.5,
  violando a regra do KB. O guardrail minAtrMult: 1.5 também permite isso.

  Fix: Mudar o min para 3.0 no breakout profile (e 2.5 para pullback, 3.0 para MR).

  ---
  20. Refiner design checklist desatualizado vs código

  O designChecklist do breakout lista "Volume confirmation" e "Low-liquidity gate" como
  requisitos — mas o refiner não valida se eles existem no código. São apenas labels
  informativos para o prompt do Claude. Se a strategy não implementa, o refiner não rejeita.

  Fix: Transformar design checklist em validação real (ou pelo menos warning) no estágio de
  guardrails.

  ---
  21. Keltner RSI2 deployed sem ADX mas config exige

  A strategy deployed em packages/backtest/src/strategies/deployed/keltner-rsi2.ts é uma cópia
  frozen do source. Se o source não tem ADX regime filter, o deployed também não tem. O daemon
  está rodando MR sem o filtro que o KB marca como OBRIGATÓRIO.

  Risco real: Em um bull run forte (como BTC rally), a MR vai entrar short "porque o preço está
  na banda superior do Keltner" e tomar stop após stop. Sem ADX < threshold, não sabe que o
  mercado está trending.

  ---
  22. Entry slippage assimétrica não modelada

  O daemon usa entrySlippageBps: 50 (tolerance 0.5%) mas o backtest modela slippageBps: 2
  (0.02%). Há um gap de 25× entre o slippage modelado e o tolerado. Se fills reais estiverem
  entre 2-50 bps, os backtests são otimistas.

  Gravidade: MÉDIA — O slippage real em BTC é provavelmente 1-5 bps (dentro do modelado), mas a
  tolerância de 50bps significa que em condições adversas, o daemon aceita fills muito piores
  sem alertar.

  ---
  23. Multi-coin orchestration sem mutex cross-asset correto

  O KB diz maxOpenPositions: 1 mas não especifica se é per-asset ou global. Na config:
  maxOpenPositions: 1. O daemon tem BTC + SOL configurados. Se o 1 é global, só pode ter 1
  posição total. Se é per-asset, pode ter BTC + SOL simultâneos.

  O daemon trata como per-asset (o orchestrator verifica por coin). Mas o risco é: 2 posições
  simultâneas = 2× exposure, que pode exceder maxDailyLossR em um flash crash que stopa ambas.

  ---
  24. Cooldown 4 bars vs KB 2 bars mínimo

  KB §9.8: "Minimum cooldown: 2 bars"
  Config: cooldownBars: 4

  Não é uma violação (4 > 2), mas é mais conservador que o mínimo. Pode perder setups válidos
  após um stop rápido. Isso é uma escolha de design aceitável.

  ---
  25. Pullback Depth Filter ausente

  KB §5.1 regra 4 — OBRIGATÓRIA:
  "Define what constitutes a valid pullback vs noise vs reversal. Too shallow (< 23%) = noise.
  Too deep (> 78.6%) = reversal."

  Realidade: ema-pullback.ts entra quando preço cruza de volta acima da fast EMA após pullback,
  sem verificar a profundidade do pullback. Pode entrar em pullbacks de 5% (ruído) ou pullbacks
  de 80% (reversão).

  ---
  RESUMO — Ranking por gravidade

  ┌─────┬─────────────────────────────────────┬──────────────┬─────────────────────────────┐
  │  #  │              Problema               │  Gravidade   │            Tipo             │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 5   │ MR sem regime filter (ADX)          │ CRÍTICA      │ Regra KB obrigatória        │
  │     │                                     │              │ violada                     │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 1   │ Breakout sem volume confirmation    │ ALTA         │ Regra KB obrigatória        │
  │     │                                     │              │ violada                     │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 3   │ Breakout ATR mult 2.0 (KB: min 3.0) │ ALTA         │ Parâmetro abaixo do mínimo  │
  │     │                                     │              │ KB                          │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 8   │ DNT Module inexistente              │ ALTA         │ Feature KB inteira ausente  │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 19  │ Refiner permite ATR < mínimo KB     │ ALTA         │ Guardrail insuficiente      │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 21  │ MR deployed operando sem ADX        │ ALTA         │ Risco operacional real      │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 2   │ Breakout sem low-liquidity gate     │ MÉDIA-ALTA   │ Regra KB obrigatória        │
  │     │                                     │              │ violada                     │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 25  │ Pullback sem depth filter           │ MÉDIA        │ Regra KB obrigatória        │
  │     │                                     │              │ violada                     │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 4   │ Pullback ATR mult 2.0 (KB: min 2.5) │ MÉDIA        │ Parâmetro abaixo do mínimo  │
  │     │                                     │              │ KB                          │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 7   │ Risk fixed USD vs % capital         │ MÉDIA        │ Divergência de design       │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 11  │ Sem macro calendar                  │ MÉDIA        │ Feature KB ausente          │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 17  │ Orchestrator state perde em restart │ MÉDIA        │ Gap operacional             │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 22  │ Slippage modelado vs tolerado       │ MÉDIA        │ Gap de modelagem            │
  │     │ diverge                             │              │                             │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 23  │ Multi-coin exposure não controlada  │ MÉDIA        │ Risco cross-asset           │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 10  │ Sem funding rate tracking           │ BAIXA        │ Será crítica para M4        │
  │     │                                     │ (agora)      │                             │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 12  │ Sem session-based filtering         │ BAIXA-MÉDIA  │ Feature KB ausente          │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 13  │ Priority fixed vs PF-based          │ BAIXA        │ Divergência de design       │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 14  │ Sem maker orders                    │ BAIXA-MÉDIA  │ Custo extra                 │
  ├─────┼─────────────────────────────────────┼──────────────┼─────────────────────────────┤
  │ 6   │ Daily loss R-based vs USD-fixed     │ BAIXA        │ Divergência semântica       │
  └─────┴─────────────────────────────────────┴──────────────┴─────────────────────────────┘
