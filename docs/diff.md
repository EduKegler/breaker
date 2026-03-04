  Resumo por esforço:

  - TRIVIAL (< 5 min cada): #8, #12, #18, #21
  - BAIXA (< 1h cada): #6, #9, #10, #1
  - MÉDIA (1-4h cada): #2, #7
  - ALTA (1+ dia): #3, #5

PARTE 1 — Regras KB obrigatórias violadas
  ---
  1. Pullback sem depth filter (KB §5.1 regra 4 — OBRIGATÓRIA)

  KB §5.1 regra 4:
  "Define what constitutes a valid pullback vs noise vs reversal. Too shallow (< ~23%) = noise. Too deep (> ~78.6%) = likely
  reversal."

  Realidade: ema-pullback.ts entra quando:
  prevClose < prevEmaFast && close > currEmaFast && close > currEmaSlow
  Não há nenhuma verificação de profundidade do pullback. Qualquer cruzamento de volta acima da EMA rápida gera sinal — seja um
  pullback de 2% (ruído) ou de 50% (possível reversão).

  Gravidade: MÉDIA — pode gerar sinais em micro-retrações que são ruído, e em retrações profundas que são reversões.

  ---
  3. Module 5 "Do Not Trade" — praticamente inexistente

  KB §7: Define 4 condições de DNT:

  ┌─────┬────────────────────────────────────────────────┬──────────────────────────────────────────┐
  │  #  │                  Condição KB                   │             Status no código             │
  ├─────┼────────────────────────────────────────────────┼──────────────────────────────────────────┤
  │ 1   │ Active squeeze (BB inside KC)                  │ NÃO EXISTE — grep retorna zero           │
  ├─────┼────────────────────────────────────────────────┼──────────────────────────────────────────┤
  │ 2   │ Volatility spike filter (preço > X% em Y bars) │ NÃO EXISTE — grep retorna zero           │
  ├─────┼────────────────────────────────────────────────┼──────────────────────────────────────────┤
  │ 3   │ Daily loss limit → force close                 │ EXISTE (orchestrator shouldForceClose()) │
  ├─────┼────────────────────────────────────────────────┼──────────────────────────────────────────┤
  │ 4   │ Weekend blocking                               │ NÃO EXISTE                               │
  └─────┴────────────────────────────────────────────────┴──────────────────────────────────────────┘

  Gravidade: ALTA — O KB diz "Knowing when NOT to trade is as important as trading." 3 de 4 condições DNT não estão implementadas. A
   volatility spike é particularmente preocupante — sem ela, o daemon opera normalmente durante FOMC, CPI, flash crashes, etc.

  ---
  4. Module 4: Trend Following — NÃO implementado

  KB §6: Módulo completo de trend following em 4H/Daily (SuperTrend, ADX Daily, Chandelier Exit, modelagem de funding).

  Realidade: Zero código. Nenhuma strategy, nenhum arquivo. Está no roadmap (Phase 4).

  Gravidade: INFORMATIVA — é roadmap, não bug. Mas ~25% da cobertura de regime (trending duration) não existe.

  ---
  PARTE 2 — Divergências de design

  5. Signal priority: fixed rank vs PF-based

  KB §2.5.1:
  "Highest-PF module (from last BREAKER run) gets the entry"

  Realidade: O orchestrator usa prioridade fixa hardcoded:
  const MODULE_PRIORITY: Record<ModuleType, number> = {
    "breakout": 4, "pullback": 3, "mean-reversion": 2, "trend-following": 1,
  };
  Nunca consulta PF histórico.

  KB §2.5.1 (tiebreaker):
  "M1 Breakout > M3 Pullback > M2 MR > M4 TF [...] override with live PF data once available"

  A prioridade fixa coincide com o tiebreaker do KB. Mas o KB diz para usar PF como critério primário e rank fixo apenas como
  tiebreaker. Na prática, com poucas strategies, o resultado é o mesmo.

  Gravidade: BAIXA — adequado para o estado atual.

  ---
  6. Orchestrator state perde em restart

  Realidade: dailyPnl, tradesToday, consecutiveLosses, paused — tudo vive em memória. Se o daemon reiniciar meio do dia, tudo zera.

  // orchestrator.ts — sem persistência
  private dailyPnl = 0;
  private tradesToday = 0;

  Risco: Um restart no meio do dia reseta o daily loss limit e trade count. Se já havia $15 de loss e 4 trades, após restart o
  daemon "esquece" e permite mais $20 de loss e 5 novos trades.

  Gravidade: MÉDIA — mitigado pelo fato que restarts são raros em produção e o reconcile-loop rehidrata posições. Mas o state do
  orchestrator em si não é recuperado.

  ---
  7. maxOpenPositions = 1 mas 2 coins configurados

  exchange-config.json:
  "guardrails": { "maxOpenPositions": 1 }
  "coins": [{ "coin": "BTC", ... }, { "coin": "SOL", ... }]

  check-risk.ts (linha 41):
  if (input.openPositions >= guardrails.maxOpenPositions) { ... }

  Problema: openPositions conta quantas posições existem globalmente. Com maxOpenPositions: 1, se BTC tem posição aberta, SOL não
  pode entrar. O KB §2.5.1 diz "one position at a time per asset" (mutex per-asset), não global. Mas a implementação é global — o
  que é mais conservador que o KB pede.

  Se a intenção é seguir o KB (posições simultâneas em assets diferentes), o valor deveria ser 2+ ou o check deveria ser per-asset.

  Gravidade: BAIXA — mais conservador que o KB, o que é seguro. Mas limita a operação multi-asset.

  ---
  1. Backtest funding rate: modelo simplificado vs KB

  KB §1.6:
  "Avg BTC funding rate ~0.005-0.01%/hour. HL-specific: hourly settlement"

  Backtest engine (execution-model.ts):
  fundingRate8h: 0.0001  // 0.01% per 8h

  O backtest modela funding como rate fixa por 8h, não dinâmica, não hourly como HL faz. A taxa default é 0.0001 = 0.01%/8h =
  0.00125%/h. O KB diz que calm-market rates são ~0.005-0.01%/h — ou seja, 4-8x maiores que o modelado.

  Para M1-M3 (trades de 1-8h), a diferença é pequena em valor absoluto. Para M4 (se implementado), seria catastrófica.

  Gravidade: MÉDIA — para trades curtos o impacto é mínimo, mas o modelo subestima custos de funding. O KB alerta sobre isso
  explicitamente.

  ---
  1.  Backtest commission: taker-only, sem maker distinction

  KB §9.8:
  "Entry (M1 Breakout): Limit at breakout level (maker 0.015%)"
  "Entry (M2 MR): Limit at band touch (maker 0.015%)"

  Backtest engine: Usa commissionPct: 0.045 (taker) para todas as operações. O KB diz que M1 e M2 deveriam usar limit orders (maker
  fee). Na prática, o daemon já usa ALO/GTC para M1 e M2 (0.015% maker), mas o backtest modela 0.045% taker.

  Isso significa que o backtest é mais pessimista que a realidade para entries — os resultados reais devem ser ligeiramente melhores
   que os backtestados (economiza 0.03% por entry × 2 sides = 0.06% round trip).

  Gravidade: POSITIVA — backtests são conservadores. Não é um problema, é uma margem de segurança.

  ---
  PARTE 3 — Problemas que identifico por análise racional

  12. Keltner RSI2 short tem volume gate, long NÃO tem

  // keltner-rsi2.ts — LONG (sem volume check)
  if (close < kcLower && rsi2 < rsi2LongThresh) { return signal; }

  // SHORT (COM volume check)
  if (close > kcUpper && rsi2 > rsi2ShortThresh && currentCandle.v > 1.5 * volAvg20) { ... }

  A assimetria long/short é intencional? O KB §4.1 regra 7 fala de assimetria ("Short MR requires tighter risk controls"), mas o
  volume filter no short mas não no long parece inconsistente. Se o volume filter no short é para evitar entrar em breakouts
  genuínos, a mesma lógica deveria se aplicar ao long (preço caindo forte com volume = bear trend, não reversion).

  Gravidade: MÉDIA — em tendência de queda forte com volume, o long vai entrar sem filtro e provavelmente tomar stop.

  ---
  13. Donchian entry price é o nível do canal, não o close

  // donchian-adx.ts
  return {
    direction: "long",
    entryPrice: prevSlowUpper,  // ← nível do canal
    ...
  };

  O entryPrice é setado para prevSlowUpper (nível do canal), mas o close pode estar significativamente acima do canal (breakout
  forte). Na engine de backtest, entryPrice !== null significa GTC limit order — será preenchido ao preço do canal. No daemon, vira
  ALO order no nível do canal.

  Risco: Se o preço já está muito acima do canal, o ALO não vai preencher (seria taker, não maker) e o order é rejeitado. Isso é by
  design (ALO garante maker fee), mas significa que breakouts fortes podem ser perdidos porque o preço já passou do nível limit.

  Gravidade: BAIXA-MÉDIA — perde breakouts explosivos, mas evita pagar taker fee. Tradeoff consciente? O KB §9.8 diz "Entry (M1
  Breakout): Limit at breakout level (maker)" — está alinhado.

  ---
  14. Keltner RSI2 entry price = KC band, não close

  Mesmo problema que #13:
  entryPrice: kcLower,   // long — limit no KC lower
  entryPrice: kcUpper,   // short — limit no KC upper

  Para MR, isto é correto — entra no nível da banda (maker). Se o preço já voltou para dentro do canal, o ALO não preenche e o sinal
   expira. Isso pode ser bom (preço já reverteu, setup passed) ou ruim (perde a melhor parte da reversão).

  Gravidade: BAIXA — alinhado com KB §9.8.

  ---
  15. EMA Pullback usa entryPrice: null (IOC/taker)

  // ema-pullback.ts
  entryPrice: null,  // IOC market order

  KB §9.8:
  "Entry (M3 Pullback): Market on confirmation close (taker)"

  Alinhado com o KB. O pullback entra via market order (taker). Correto.

  ---
  16. Orchestrator não tem gate de "position open on this asset" (mutex)

  KB §2.5.4 gate 4:
  "Is there an open position on this asset? → BLOCK new entries on this asset (mutex)"

  Realidade: O orchestrator (canSignal()) verifica:
  1. Daily loss
  2. Max trades/day
  3. Module paused

  Não verifica se já existe posição aberta naquele asset. O check-risk.ts verifica maxOpenPositions globalmente, mas não há mutex
  per-asset no orchestrator.

  Na prática, o maxOpenPositions: 1 no check-risk funciona como mutex global (se BTC tem posição, nada mais entra). Mas se
  maxOpenPositions fosse > 1, não haveria proteção per-asset.

  Gravidade: BAIXA — com maxOpenPositions: 1 global, funciona. Mas o design é frágil se expandir.

  ---
  17. Cooldown é global, não per-module per-asset

  KB §2.5.4 gate 5:
  "Is cooldown active for this module on this asset?"

  Realidade: O cooldownBars é implementado no strategy-runner.ts via barsSinceExit. Cada runner tem seu próprio counter, o que é
  efetivamente per-module per-asset (cada runner = 1 module × 1 coin). Está correto.

  Gravidade: NENHUMA — implementação correta.

  ---
  18. Walk-forward no refiner vs KB stopping criteria

  KB §10.1:

  ┌─────────┬──────────┬────────┬──────────┬─────────┐
  │ Métrica │ Breakout │   MR   │ Pullback │   TF    │
  ├─────────┼──────────┼────────┼──────────┼─────────┤
  │ PF      │ >= 1.3   │ >= 1.3 │ >= 1.4   │ >= 1.4  │
  ├─────────┼──────────┼────────┼──────────┼─────────┤
  │ DD      │ <= 10%   │ <= 8%  │ <= 10%   │ <= 12%  │
  ├─────────┼──────────┼────────┼──────────┼─────────┤
  │ WR      │ --       │ >= 50% │ --       │ --      │
  ├─────────┼──────────┼────────┼──────────┼─────────┤
  │ avgR    │ >= 0.15  │ --     │ >= 0.15  │ >= 0.20 │
  └─────────┴──────────┴────────┴──────────┴─────────┘

  breaker-config.json:
  "breakout":        { "minPF": 1.3, "maxDD": 10, "minWR": 40, "minTrades": 50, "minAvgR": 0.15 }
  "mean-reversion":  { "minPF": 1.3, "maxDD": 8, "minWR": 50, "minTrades": 80 }

  Problema no MR: O KB diz minAvgR é "--" (não necessário para MR), e o config não tem minAvgR para MR. Correto.

  Problema no breakout: O KB diz WR: -- (sem gate), mas o config tem minWR: 40. Isso é mais restritivo que o KB — o KB
  explicitamente diz que breakout não deve ter gate de WR porque "Turtle system: 39% WR, 57.8% CAGR". O minWR: 40 poderia rejeitar
  estratégias válidas no estilo Turtle.

  Gravidade: BAIXA-MÉDIA — restritivo demais pode eliminar boas estratégias de breakout.

  ---
  19. Deployed strategies podem divergir do source

  O processo promote copia strategies de src/strategies/ para src/strategies/deployed/. Mas não há check automático de que deployed
  === source. Se alguém editar o source sem promover, o daemon roda uma versão diferente do que o refiner otimiza.

  Gravidade: BAIXA — é by design (deployed = frozen, source = development). Mas o risco é divergência silenciosa.

  ---
  20. Orchestrator heartbeat 30s vs KB 15m

  KB §2.5.5:
  "Heartbeat: Runs every 15m bar close (aligned with fastest module)"

  Realidade: O daemon roda heartbeat a cada 30 segundos:
  // daemon.ts — heartbeat interval
  setInterval(() => orchestrator.shouldForceClose(), 30_000);

  Isto é mais agressivo que o KB pede (30s vs 15m). Force close avaliado a cada 30s em vez de a cada 15 minutos.

  Gravidade: POSITIVA — mais proteção que o KB requer. Bom.

  ---
  21. Day reset limpa consecutive losses e module pause

  // orchestrator.ts
  resetDayIfNeeded(currentDay: string): void {
    for (const mod of this.modules.values()) {
      mod.consecutiveLosses = 0;
      mod.paused = false;
    }
  }

  Todo dia à meia-noite UTC, todas as module pauses são resetadas. Se um módulo teve 2 losses consecutivos às 23:55 UTC e foi
  pausado, às 00:00 UTC ele é despausado.

  O KB §2.5 não menciona reset diário de pause. A lógica de "2 consecutive losses → pause" deveria persistir além do day boundary?
  Se um módulo está consistentemente perdendo, o reset diário permite que ele continue perdendo dia após dia.

  Gravidade: BAIXA-MÉDIA — o KB §9.9 diz "If you're hitting the daily cap multiple days in a row, the problem is the strategy" — mas
   não menciona reset automático de module pause.