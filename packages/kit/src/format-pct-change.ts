export function formatPctChange(pct: number, decimals = 2): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(decimals)}%`;
}
