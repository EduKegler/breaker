import { describe, it, expect } from "vitest";
import { AlertPayloadSchema } from "./alert.js";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    alert_id: "test-1",
    event_type: "ENTRY",
    asset: "BTC",
    side: "LONG",
    entry: 100_000,
    sl: 95_000,
    qty: 0.01,
    ...overrides,
  };
}

describe("AlertPayloadSchema", () => {
  it("accepts a valid payload", () => {
    const result = AlertPayloadSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it("accepts valid tp1 and tp2", () => {
    const result = AlertPayloadSchema.safeParse(
      validPayload({ tp1: 105_000, tp2: 110_000 }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects sl = 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ sl: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects sl < 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ sl: -1 }));
    expect(result.success).toBe(false);
  });

  it("rejects tp1 = 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ tp1: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects tp1 < 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ tp1: -50 }));
    expect(result.success).toBe(false);
  });

  it("rejects tp2 = 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ tp2: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects tp2 < 0", () => {
    const result = AlertPayloadSchema.safeParse(validPayload({ tp2: -1 }));
    expect(result.success).toBe(false);
  });

  it("allows omitted tp1 and tp2", () => {
    const result = AlertPayloadSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });
});
