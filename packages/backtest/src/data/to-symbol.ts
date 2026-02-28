export type DataSource = "binance" | "hyperliquid";

/** Map coin + source to CCXT unified symbol. */
export function toSymbol(coin: string, source: DataSource): string {
  switch (source) {
    case "binance":
      return `${coin}/USDT:USDT`;
    case "hyperliquid":
      return `${coin}/USDC:USDC`;
  }
}
