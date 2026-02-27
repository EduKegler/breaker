import { describe, it, expect } from "vitest";
import { resolveOrderStatus } from "./order-status.js";

describe("resolveOrderStatus", () => {
  it("maps 'filled' to 'filled'", () => {
    expect(resolveOrderStatus("filled", false)).toBe("filled");
    expect(resolveOrderStatus("filled", true)).toBe("filled");
  });

  it("maps 'triggered' to 'filled'", () => {
    expect(resolveOrderStatus("triggered", false)).toBe("filled");
    expect(resolveOrderStatus("triggered", true)).toBe("filled");
  });

  it("maps 'canceled' to 'cancelled'", () => {
    expect(resolveOrderStatus("canceled", false)).toBe("cancelled");
    expect(resolveOrderStatus("canceled", true)).toBe("cancelled");
  });

  it("maps 'marginCanceled' to 'cancelled'", () => {
    expect(resolveOrderStatus("marginCanceled", false)).toBe("cancelled");
    expect(resolveOrderStatus("marginCanceled", true)).toBe("cancelled");
  });

  it("maps 'rejected' to 'rejected'", () => {
    expect(resolveOrderStatus("rejected", false)).toBe("rejected");
    expect(resolveOrderStatus("rejected", true)).toBe("rejected");
  });

  it("returns 'cancelled' when HL status is undefined and no position exists", () => {
    expect(resolveOrderStatus(undefined, false)).toBe("cancelled");
  });

  it("returns null when HL status is undefined but position still exists", () => {
    expect(resolveOrderStatus(undefined, true)).toBeNull();
  });

  it("returns 'cancelled' for unknown status when no position exists", () => {
    expect(resolveOrderStatus("someUnknownStatus", false)).toBe("cancelled");
  });

  it("returns null for unknown status when position exists", () => {
    expect(resolveOrderStatus("someUnknownStatus", true)).toBeNull();
  });
});
