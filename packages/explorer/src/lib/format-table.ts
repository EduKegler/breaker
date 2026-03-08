import { parseUtc } from "./parse-utc.js";

export function formatDate(dt: string): string {
  return parseUtc(dt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatPrice(price: number | null): string {
  if (price == null) return "\u2014";
  return price >= 100
    ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${price.toFixed(4)}`;
}
