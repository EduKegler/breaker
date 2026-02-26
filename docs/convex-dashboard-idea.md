# Convex + Dashboard — Ideia futura

Referência: Peter Steinberg usa Convex no OpenClaw com boas recomendações.

## Objetivo

UI web pra acompanhar trades por estratégia em tempo real.

## Arquitetura proposta

```
┌─────────────────────────────────────────────┐
│              Infra atual (mantém)            │
│  backtest · breaker · webhook · hl-broker   │
└──────────────┬──────────────────────────────┘
               │ grava eventos via SDK
               ▼
┌─────────────────────────────────────────────┐
│              Convex                          │
│  • trades (por estratégia, entry/exit/pnl)  │
│  • posições abertas                         │
│  • alertas recebidos                        │
│  • métricas de otimização do breaker        │
└──────────────┬──────────────────────────────┘
               │ subscriptions reativas
               ▼
┌─────────────────────────────────────────────┐
│          Web UI (Next.js/React)             │
│  • dashboard por estratégia                 │
│  • equity curve, drawdown, win rate         │
│  • posições live                            │
│  • histórico de otimizações                 │
└─────────────────────────────────────────────┘
```

## Por que Convex

- TypeScript-first, encaixa no stack atual
- Subscriptions reativas (trades aparecem na tela sem polling)
- Cron nativo (pode disparar otimizações automáticas)
- Zero config de infra pro backend da UI

## O que NÃO migrar pro Convex

- **Backtest engine** — computação pesada, SQLite local é ideal
- **Candle cache** — time-series grande, better-sqlite3 é perfeito
- **Webhook** — Express simples, trocar não traz ganho

## Caminho incremental

1. **hl-broker** — quando executar trades, grava no Convex (estratégia, asset, side, size, pnl)
2. **UI mínima** — tabela de trades + equity curve por estratégia
3. **Expande** — webhook grava alertas, breaker grava resultados de otimização
4. **Scheduling** — cron do Convex pra disparar otimizações automáticas

## Pacote

Criar `packages/dashboard` com Convex + Next.js quando chegar a hora.
