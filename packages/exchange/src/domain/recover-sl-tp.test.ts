import { describe, it, expect } from "vitest";
import { recoverSlTp } from "./recover-sl-tp.js";
import type { HlOpenOrder } from "../types/hl-client.js";

const makeOrder = (overrides: Partial<HlOpenOrder> = {}): HlOpenOrder => ({
  coin: "BTC",
  oid: 1,
  side: "A",
  sz: 0.01,
  limitPx: 0,
  orderType: "limit",
  isTrigger: false,
  triggerPx: 0,
  triggerCondition: "",
  reduceOnly: false,
  isPositionTpsl: false,
  ...overrides,
});

describe("recoverSlTp", () => {
  it("returns stopLoss=0 and empty takeProfits when no orders", () => {
    const result = recoverSlTp("BTC", 0.01, []);
    expect(result.stopLoss).toBe(0);
    expect(result.takeProfits).toEqual([]);
  });

  it("recovers SL from trigger+reduceOnly order", () => {
    const orders = [
      makeOrder({ isTrigger: true, reduceOnly: true, triggerPx: 93000 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.stopLoss).toBe(93000);
  });

  it("recovers TPs from non-trigger+reduceOnly orders", () => {
    const orders = [
      makeOrder({ oid: 2, reduceOnly: true, limitPx: 97000, sz: 0.005 }),
      makeOrder({ oid: 3, reduceOnly: true, limitPx: 99000, sz: 0.005 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.takeProfits).toEqual([
      { price: 97000, pctOfPosition: 0.5 },
      { price: 99000, pctOfPosition: 0.5 },
    ]);
  });

  it("ignores orders for other coins", () => {
    const orders = [
      makeOrder({ coin: "ETH", isTrigger: true, reduceOnly: true, triggerPx: 3000 }),
      makeOrder({ coin: "ETH", reduceOnly: true, limitPx: 4000, sz: 1 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.stopLoss).toBe(0);
    expect(result.takeProfits).toEqual([]);
  });

  it("ignores non-reduceOnly orders", () => {
    const orders = [
      makeOrder({ isTrigger: true, reduceOnly: false, triggerPx: 93000 }),
      makeOrder({ reduceOnly: false, limitPx: 97000, sz: 0.005 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.stopLoss).toBe(0);
    expect(result.takeProfits).toEqual([]);
  });

  it("recovers both SL and TPs together", () => {
    const orders = [
      makeOrder({ oid: 1, isTrigger: true, reduceOnly: true, triggerPx: 93000 }),
      makeOrder({ oid: 2, reduceOnly: true, limitPx: 97000, sz: 0.005 }),
      makeOrder({ oid: 3, reduceOnly: true, limitPx: 99000, sz: 0.005 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.stopLoss).toBe(93000);
    expect(result.takeProfits).toHaveLength(2);
  });

  it("handles zero posSize gracefully for TP pctOfPosition", () => {
    const orders = [
      makeOrder({ reduceOnly: true, limitPx: 97000, sz: 0.005 }),
    ];
    const result = recoverSlTp("BTC", 0, orders);
    expect(result.takeProfits).toEqual([{ price: 97000, pctOfPosition: 0 }]);
  });

  it("returns trailingStopLoss=null with single trigger order", () => {
    const orders = [
      makeOrder({ isTrigger: true, reduceOnly: true, triggerPx: 93000 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders, "long");
    expect(result.stopLoss).toBe(93000);
    expect(result.trailingStopLoss).toBeNull();
  });

  it("returns trailingStopLoss=null when no direction provided (backward compat)", () => {
    const orders = [
      makeOrder({ oid: 1, isTrigger: true, reduceOnly: true, triggerPx: 93000 }),
      makeOrder({ oid: 2, isTrigger: true, reduceOnly: true, triggerPx: 94000 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders);
    expect(result.trailingStopLoss).toBeNull();
  });

  it("discriminates fixed vs trailing SL for long: lower=fixed, higher=trailing", () => {
    const orders = [
      makeOrder({ oid: 1, isTrigger: true, reduceOnly: true, triggerPx: 93000 }),
      makeOrder({ oid: 2, isTrigger: true, reduceOnly: true, triggerPx: 94500 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders, "long");
    expect(result.stopLoss).toBe(93000);
    expect(result.trailingStopLoss).toBe(94500);
  });

  it("discriminates fixed vs trailing SL for short: higher=fixed, lower=trailing", () => {
    const orders = [
      makeOrder({ oid: 1, isTrigger: true, reduceOnly: true, triggerPx: 97000 }),
      makeOrder({ oid: 2, isTrigger: true, reduceOnly: true, triggerPx: 95500 }),
    ];
    const result = recoverSlTp("BTC", 0.01, orders, "short");
    expect(result.stopLoss).toBe(97000);
    expect(result.trailingStopLoss).toBe(95500);
  });
});
