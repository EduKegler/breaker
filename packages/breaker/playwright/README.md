# TradingView Playwright Runner

Estrutura pronta para:
1. Entrar no TradingView (sessao persistente).
2. Aplicar uma strategy `.pine` no grafico.
3. Rodar o Strategy Tester.
4. Exportar resultados (CSV da aba **List of Trades**) e salvar screenshot.

## Requisitos

- Node.js 18+
- Conta no TradingView logada

## Setup

```bash
cd /Users/edu/Projects/pine/automation/tradingview-playwright
cp .env.example .env
npm install
npx playwright install chromium
```

## Configuracao

Edite o `.env`:

- `AUTH_FILE`: arquivo de sessao persistente.
- `DOWNLOAD_DIR`: pasta para CSV/screenshot/metadata.
- `HEADLESS`: `false` recomendado no inicio.

> **Nota:** `STRATEGY_FILE` e `TV_CHART_URL` NAO ficam no `.env` — sao exportados
> automaticamente pelo `breaker-loop.sh` com base no `ASSET` selecionado.
> Para rodar o backtest isolado (sem o loop), exporte manualmente:
> ```bash
> ASSET=BTC STRATEGY_FILE=../../assets/BTC/strategy.pine npm run backtest
> ```

## Uso

### 1) Salvar sessao de login

```bash
npm run login
```

O navegador vai abrir. Faca login manualmente no TradingView e pressione ENTER no terminal para salvar a sessao em `AUTH_FILE`.

### 2) Executar backtest e exportar

```bash
npm run backtest
```

Saidas em `DOWNLOAD_DIR`:
- `*-<nome_export>.csv` (List of Trades)
- `*-strategy-tester.png`
- `*-metadata.json`

## Observacoes importantes

- TradingView pode alterar seletores/labels de UI ao longo do tempo. O script usa seletores alternativos, mas pode precisar ajustes.
- Se houver CAPTCHA/2FA, o fluxo de login deve ser manual (`npm run login`).
- O script assume que o arquivo `.pine` e uma `strategy(...)`. Se for `indicator(...)`, o Strategy Tester nao gera trades.
