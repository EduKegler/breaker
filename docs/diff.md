KB Drift Report — v4.5 vs Codebase (2026-03-04)                                                                                   
                                                                          
  ---                                                                                                                               
  1. KB Espera, Código NÃO Faz                                                                                                      

  1.2 M4 Trend Following — Módulo inteiro ausente (KB §6)

  - KB diz: SuperTrend/MACD no 4H, ADX Daily como regime filter, stop ATR Daily ≥3.0, trailing exits, modelar funding rate, ≤6
  variáveis
  - Código: Não existe nenhum arquivo de estratégia TF. Nem indicador SuperTrend nem Chandelier Exit
  - 🔴 Alta (5-10 dias) — novo módulo completo: estratégia + 2 indicadores (SuperTrend, Chandelier) + testes + deployed copy

  1.3 Pullback Depth Filter — Fibonacci (KB §5.1 regra 4, mandatory)

  - KB diz: Filtro de profundidade do pullback é OBRIGATÓRIO. Fibonacci (23.6%-78.6%) ou distância-do-MA. Rejeitar pullbacks rasos
  (noise) e profundos (reversão)
  - Código: ema-pullback.ts usa apenas EMA crossovers. Nenhuma detecção de swing, nenhum cálculo de Fibonacci, nenhum filtro de
  profundidade
  - 🔴 Alta (3-5 dias) — algoritmo de swing detection + cálculo de retracement + integração na strategy

  1.5 Virtual Stop Fallback para MR no-stop (KB §9.2)

  - KB diz: Quando MR opera sem stop fixo, usar virtual stop para sizing: virtualStop = ATR distance catastrófico (ex: 5x ATR 1H).
  Position size calculado como se o stop existisse
  - Código: signal-to-intent.ts linha 30: quando stopDist = 0, size = 0 → trade rejeitado. Nenhum fallback
  - Impacto: MR sem stop simplesmente não funciona — silenciosamente gera size 0
  - 🟡 Média (1-2 dias) — adicionar cálculo de virtual stop quando stopDist ≤ 0

  1.6 Cooldown per-module per-asset no Orchestrator (KB §2.5.4 Gate 5)

  - KB diz: Gate 5 no orchestrator: "Is cooldown active for this module on this asset? → BLOCK (min 2-bar cooldown after stop)"
  - Código: Cooldown existe no StrategyRunner via barsSinceExit, não no Orchestrator
  - Nota: KB §9.6 (Enforceability Matrix) diz "Cooldown → Yes — timestamp check in strategy runner", o que contradiz §2.5.4 Gate 5
  - 🟢 Baixa (ambiguidade no KB — runner já implementa, mas spec diz orchestrator)

  1.7 Indicadores ausentes para M4

  - SuperTrend — bloqueante para M4 (§6.2 "recommended first iteration")
  - Chandelier Exit — alternativa de trailing exit para M4
  - Williams %R — opcional para MR (melhor performance que RSI em backtests)
  - MACD — opcional para breakout/TF
  - 🔴 Alta (SuperTrend+Chandelier: 4-7 dias) / 🟡 Média (Williams %R, MACD: 1-2 dias cada)

  ---
  1. Discrepâncias KB vs Código

  2.1 M2 Variable Count: 7 > 6 (KB §4.1 regra 1)

  - KB diz: Max 6 free vars para Mean Reversion
  - Código: keltner-rsi2.ts tem 7 params: kcMultiplier, rsi2Long, rsi2Short, adxThreshold, maxTradesDay, timeoutBars, atrStopMult
  - Nota: maxTradesDay é optimizable: false, mas ainda conta como parâmetro na interface
  - Fix: Remover maxTradesDay da strategy (é responsabilidade do orchestrator, gate global)
  - 🟢 Baixa (< 1 dia) — remover 1 param

  2.2 Funding Rate "not modeled in backtest" vs código que modela

  - KB §9.1 nota: "Funding rate not modeled in backtest by default"
  - Código: DEFAULT_EXECUTION.fundingRate8h = 0.0004 — funding IS modeled, ativamente deduzido do PnL
  - Direção: KB está desatualizado. O código está CORRETO (modelar funding é melhor)
  - 🟢 Baixa (< 1 dia) — atualizar nota no KB

  2.3 Explorer session-highlight: UTC hardcoded vs KB §14.3 DST-aware

  - KB diz: "Do NOT hardcode UTC — DST breaks hardcoded values". Define sessions em timezone local com DST automático
  - Backtest: ✅ getSessionForTimestamp() é DST-aware (usa Intl.DateTimeFormat)
  - Explorer: ✗ session-highlight.ts usa SESSIONS array com startHour/endHour UTC fixos. Falha no inverno/transição DST
  - 🟡 Média (1-2 dias) — importar lógica DST-aware ou replicar no explorer

  2.4 Deployed vs Source strategy timeouts divergem

  - M1 Breakout: source timeoutBars=24 (6h), deployed=20 (5h)
  - M2 MR: source timeoutBars=12 (3h), deployed=8 (2h)
  - Impacto: Deployed é consistentemente mais agressivo. Pode ser intencional (tuning live), mas não está documentado
  - 🟢 Baixa (< 1 dia) — documentar divergência ou sincronizar

  2.5 M3 naming convention inconsistente

  - KB pattern: "{ASSET} {TF} {Category} — {Strategy Name}"
  - M1: "BTC 15m Breakout — Donchian ADX" ✅
  - M2: "BTC 15m Mean Reversion — Keltner RSI2" ✅
  - M3: "EMA Pullback Continuation" ✗ — falta prefixo BTC 15m Pullback —
  - 🟢 Baixa (< 1 dia)

  ---
  3. Problemas Adicionais (Racionais/Intuitivos)

  3.1 Division by zero em signal-to-intent quando stopDist = 0

  - Cenário: Qualquer signal com stopLoss === entryPrice ou sem stop → stopDist = 0 → size = 0/0 ou Infinity
  - Impacto: Trade silenciosamente descartado (size 0) ou potencial NaN/Infinity propagado
  - Relacionado a: 1.5 (virtual stop fallback)
  - 🟡 Média (1 dia) — guard clause + virtual stop

  3.2 Orchestrator dailyPnl transient state durante rapid restarts

  - Cenário: Bug investigado nesta sessão. Daemon reinicia rapidamente (tsx --watch), estado in-memory corrompido
  - Status: CORRIGIDO (seedDailyPnl + sanity check vs DB implementados no commit 5dd179a)
  - ✅ Já resolvido

  3.3 Squeeze gate ausente pode permitir entradas em compressão

  - Cenário: Mercado em squeeze (BB dentro de KC), strategies individuais podem ter seu próprio squeeze check (M1 donchian-adx tem),
   mas M2/M3 não
  - Impacto: MR pode entrar durante squeeze quando deveria estar bloqueado globalmente
  - Relacionado a: 1.1 (squeeze gate no orchestrator)
  - 🔴 Alta

  3.4 maxTradesDay duplicado entre strategy e orchestrator

  - Cenário: maxTradesDay é parâmetro da strategy (per-coin per-module) E gate global do orchestrator (5 trades/day cross-all)
  - Impacto: Sem conflito funcional, mas confuso. Strategy-level é per-asset, orchestrator é global
  - 🟢 Baixa — mover para orchestrator only, remover das strategies