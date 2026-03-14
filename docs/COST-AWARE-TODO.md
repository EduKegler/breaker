# Cost-Aware Validation — TODO

Itens pendentes para fechar a validação completa do deep-research-report.md.
Referência: seções "O que medir no backtest" e "Como validar sem se autoenganar".

---

## 1. Sharpe Ratio (ou equivalente)

**Status:** não implementado
**Prioridade:** alta — é métrica obrigatória no documento
**Esforço estimado:** baixo

O documento exige "Sharpe ou métrica equivalente". A equity curve já existe no engine (`EquityCurve` com `EquityPoint[]`), então o cálculo é direto:

- Converter equity points em retornos diários (ou por trade)
- `Sharpe = mean(returns) / std(returns) × sqrt(252)` (annualizado)
- Alternativa: Sortino (penaliza só downside vol), mais relevante para contas pequenas onde drawdown mata

**Onde adicionar:**
- Novo campo `sharpeRatio: number | null` em `Metrics`
- Precisa receber `equityPoints` ou retornos — computeMetrics hoje só recebe trades
- Opção A: calcular no `run-backtest.ts` a partir do `BacktestResult.equityPoints` (fora do computeMetrics)
- Opção B: função separada `computeSharpe(equityPoints)` em `analysis/`

**Considerações:**
- Com 40 trades em 90 dias, o Sharpe diário tem N pequeno (~90 pontos) — reportar com disclaimer
- Para contas de $100, Sortino pode ser mais informativo (downside risk é o que mata)
- O documento diz "Sharpe ou equivalente" — implementar ambos (Sharpe + Sortino) é barato

---

## 2. Dispersão por Janela de Horário (surfacing)

**Status:** dados existem, falta exibir
**Prioridade:** média — o dado já está computado, só não aparece no output cost-aware
**Esforço estimado:** baixo

O `TradeAnalysis` já tem:
- `bySession: Record<SessionName, SessionStats>` — Asia, London, NY, Off-peak (count, pnl, winRate, profitFactor)
- `bestHoursUTC: HourStats[]` — top 3 horas por PnL
- `worstHoursUTC: HourStats[]` — bottom 3 horas por PnL

**O que falta:**
- Mostrar `bySession` no output do `run-backtest.ts` (tabela de sessões com PnL/WR/PF por sessão)
- Incluir no `compare-strategies.ts` como indicador de consistência
- Cruzar com cost-aware: edge líquido por sessão (se a sessão com mais trades tem edge negativo, é red flag)

**Por que importa:**
O documento recomenda "priorização de janelas" e menciona que sobreposição Europa/EUA tende a ter melhor liquidez. Se uma estratégia só funciona em Off-peak, provavelmente depende de slippage baixo que não existe nesse horário.

---

## 3. PBO/CSCV (Probability of Backtest Overfitting)

**Status:** não implementado
**Prioridade:** média-baixa — o plano original já excluía, mas o documento lista como ferramenta conceitual importante
**Esforço estimado:** alto (2-3 dias)

O documento lista "PBO/CSCV para risco de overfitting" em ferramentas conceituais. Isso mede a probabilidade de que o melhor resultado de uma varredura de parâmetros seja overfitting.

**O que envolve:**
- Implementar Combinatorially Symmetric Cross-Validation (CSCV): dividir os dados em S subsets, testar todas as combinações de in-sample/out-of-sample
- Calcular PBO = fração das combinações onde o melhor in-sample performa abaixo da mediana out-of-sample
- PBO > 0.5 = provavelmente overfitted

**Complexidade:**
- Requer rodar a estratégia N vezes com diferentes splits de dados
- Com S=16 subsets, são C(16,8) = 12870 combinações — cada uma precisa de backtest
- Otimização: compartilhar candle cache, paralelizar, usar subset de combinações
- Integrar no refiner como gate de promoção (PBO < threshold)

**Alternativa mais leve:**
- Walk-forward já existe e pega boa parte do overfitting
- Adicionar múltiplos walk-forward windows (rolling) seria 80% do valor com 20% do esforço

---

## 4. Dispersão por Regime

**Status:** não implementado — requer mudança arquitetural
**Prioridade:** média — o documento menciona em métricas obrigatórias e na arquitetura recomendada
**Esforço estimado:** médio-alto

O documento define três regimes (trend mode, range mode, no-trade) e exige "dispersão por regime" nas métricas. Hoje o engine não sabe em qual regime cada trade aconteceu.

**O que envolve:**

1. **Strategy emite tag de regime por trade** — o `Signal` ou `CompletedTrade` precisa de um campo `regime?: string` indicando "trend" | "range" | "mixed" | etc.
2. **Engine propaga a tag** — quando a strategy retorna um Signal, o regime tag é carregado até o CompletedTrade
3. **Analysis agrupa por regime** — novo campo em TradeAnalysis: `byRegime: Record<string, DirectionStats>` (mesmo shape que `byDirection`)
4. **Métricas por regime** — PF, WR, edge líquido, trades/day por regime separado

**Por que é arquitetural:**
- Exige mudar a interface `Signal` (ou adicionar campo ao `CompletedTrade`)
- Cada strategy precisa implementar a classificação de regime
- O refiner precisa entender e preservar a tag ao gerar/modificar strategies
- Não é algo que se adiciona "de fora" — a strategy é quem sabe o regime

**Abordagem alternativa (sem mudar Signal):**
- Classificar regime ex-post a partir dos indicadores no momento do trade (EMA slope, ATR percentile, etc.)
- Menos preciso mas não requer mudança de interface
- Pode ser implementado como pós-processamento em `trade-analysis.ts`
