import { describe, it, expect, beforeEach } from "vitest";
import { createOrderId, resetOrderIdCounter } from "./create-order-id.js";

describe("createOrderId", () => {
  beforeEach(() => {
    resetOrderIdCounter();
  });

  it("generates incremental IDs", () => {
    expect(createOrderId()).toBe("ord_1");
    expect(createOrderId()).toBe("ord_2");
    expect(createOrderId()).toBe("ord_3");
  });

  it("resets counter back to 0", () => {
    createOrderId();
    createOrderId();
    resetOrderIdCounter();
    expect(createOrderId()).toBe("ord_1");
  });
});
