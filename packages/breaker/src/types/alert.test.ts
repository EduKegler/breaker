import { describe, it, expect } from "vitest";
import { AlertPayloadSchema } from "./alert.js";

const validComplete = {
  alert_id: "abc-123",
  event_type: "ENTRY" as const,
  asset: "BTC",
  side: "LONG" as const,
  entry: 50000,
  sl: 49000,
  tp1: 52000,
  tp2: 55000,
  tp1_pct: 50,
  qty: 0.1,
  leverage: 10,
  risk_usd: 100,
  notional_usdc: 5000,
  margin_usdc: 500,
  signal_ts: 1700000000000,
  bar_ts: 1700000000000,
};

const validMinimal = {
  alert_id: "abc-123",
  event_type: "ENTRY" as const,
  asset: "BTC",
  side: "LONG" as const,
  entry: 50000,
  sl: 49000,
  qty: 0.1,
};

describe("AlertPayloadSchema", () => {
  it("accepts complete valid payload (all fields)", () => {
    const result = AlertPayloadSchema.safeParse(validComplete);
    expect(result.success).toBe(true);
  });

  it("accepts minimal payload (only required fields)", () => {
    const result = AlertPayloadSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
  });

  it("rejects empty alert_id", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, alert_id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing alert_id", () => {
    const { alert_id: _, ...noAlertId } = validMinimal;
    const result = AlertPayloadSchema.safeParse(noAlertId);
    expect(result.success).toBe(false);
  });

  it("rejects invalid event_type", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, event_type: "EXIT" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid side", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, side: "UP" });
    expect(result.success).toBe(false);
  });

  it("rejects negative entry", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, entry: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects zero qty", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, qty: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts tp1 as undefined (optional field)", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, tp1: undefined });
    expect(result.success).toBe(true);
  });

  it("rejects tp1_pct > 100", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, tp1_pct: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects tp1_pct < 0", () => {
    const result = AlertPayloadSchema.safeParse({ ...validMinimal, tp1_pct: -1 });
    expect(result.success).toBe(false);
  });
});
