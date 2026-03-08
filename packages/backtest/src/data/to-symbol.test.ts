import { describe, it, expect } from "vitest";
import { toSymbol } from "./to-symbol.js";

describe("toSymbol", () => {
  it("maps binance to USDT pair", () => {
    expect(toSymbol("BTC", "binance")).toBe("BTC/USDT:USDT");
  });

  it("maps hyperliquid to USDC pair", () => {
    expect(toSymbol("BTC", "hyperliquid")).toBe("BTC/USDC:USDC");
  });

  it("works with other coins", () => {
    expect(toSymbol("SOL", "binance")).toBe("SOL/USDT:USDT");
    expect(toSymbol("SOL", "hyperliquid")).toBe("SOL/USDC:USDC");
  });
});
