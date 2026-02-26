import { describe, it, expect } from "vitest";
import { detectAnomalies } from "./anomalies.js";
import type { DashboardEvent } from "../types/events.js";

function makeEvent(overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return {
    ts: "2026-02-22T12:00:00Z",
    iter: 1,
    stage: "PARSE_DONE",
    status: "success",
    pnl: 200,
    pf: 1.5,
    dd: 5,
    trades: 180,
    message: "",
    run_id: "test-run",
    asset: "BTC",
    ...overrides,
  };
}

describe("detectAnomalies", () => {
  it("returns events unchanged when no anomalies", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, pnl: 210, trades: 175 }),
    ];
    const result = detectAnomalies(events);
    expect(result).toHaveLength(2);
    expect(result[0].anomalies).toBeUndefined();
    expect(result[1].anomalies).toBeUndefined();
  });

  it("detects dataset shift when trades increase after filter", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "OPTIMIZE", status: "info", message: "block hour 15" }),
      makeEvent({ iter: 2, pnl: 190, trades: 195 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toContain("dataset shift provavel");
  });

  it("does NOT flag dataset shift when trades decrease after filter", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "OPTIMIZE", status: "info", message: "block hour 15" }),
      makeEvent({ iter: 2, pnl: 210, trades: 170 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toBeUndefined();
  });

  it("detects PnL swing >20% (positive)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 100, trades: 180 }),
      makeEvent({ iter: 2, pnl: 130, trades: 175 }),
    ];
    const result = detectAnomalies(events);
    expect(result[1].anomalies).toBeDefined();
    expect(result[1].anomalies![0]).toMatch(/swing grande \(\+30\.0%\)/);
  });

  it("detects PnL swing >20% (negative)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, pnl: 150, trades: 175 }),
    ];
    const result = detectAnomalies(events);
    expect(result[1].anomalies).toBeDefined();
    expect(result[1].anomalies![0]).toMatch(/swing grande \(-25\.0%\)/);
  });

  it("does NOT flag PnL swing <=20%", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, pnl: 175, trades: 175 }),
    ];
    const result = detectAnomalies(events);
    // 12.5% change — below threshold
    expect(result[1].anomalies).toBeUndefined();
  });

  it("detects multiple anomalies on same event", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 150 }),
      makeEvent({ iter: 2, stage: "FILTER", status: "info", message: "removing hour" }),
      makeEvent({ iter: 2, pnl: 140, trades: 180 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toBeDefined();
    expect(result[2].anomalies!.length).toBe(2);
    expect(result[2].anomalies).toContain("dataset shift provavel");
    expect(result[2].anomalies![1]).toMatch(/swing grande/);
  });

  it("handles empty events array", () => {
    expect(detectAnomalies([])).toEqual([]);
  });

  it("handles single PARSE_DONE event (no comparison possible)", () => {
    const events = [makeEvent({ iter: 1, pnl: 200, trades: 180 })];
    const result = detectAnomalies(events);
    expect(result).toHaveLength(1);
    expect(result[0].anomalies).toBeUndefined();
  });

  it("detects filter via message 'block' (non-FILTER/OPTIMIZE stage)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "CUSTOM_STEP", status: "info", message: "block hour 15" }),
      makeEvent({ iter: 2, pnl: 190, trades: 195 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toContain("dataset shift provavel");
  });

  it("detects filter via message 'remove' (non-FILTER/OPTIMIZE stage)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "CUSTOM_STEP", status: "info", message: "remove bad hours" }),
      makeEvent({ iter: 2, pnl: 190, trades: 195 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toContain("dataset shift provavel");
  });

  it("detects filter via message 'filtro' (non-FILTER/OPTIMIZE stage)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "CUSTOM_STEP", status: "info", message: "filtro aplicado" }),
      makeEvent({ iter: 2, pnl: 190, trades: 195 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toContain("dataset shift provavel");
  });

  it("detects filter via message 'bloque' (non-FILTER/OPTIMIZE stage)", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 200, trades: 180 }),
      makeEvent({ iter: 2, stage: "CUSTOM_STEP", status: "info", message: "bloquear hora 14" }),
      makeEvent({ iter: 2, pnl: 190, trades: 195 }),
    ];
    const result = detectAnomalies(events);
    expect(result[2].anomalies).toContain("dataset shift provavel");
  });

  it("skips PnL swing check when previous PnL is zero", () => {
    const events = [
      makeEvent({ iter: 1, pnl: 0, trades: 180 }),
      makeEvent({ iter: 2, pnl: 100, trades: 175 }),
    ];
    const result = detectAnomalies(events);
    // Division by zero avoided — no swing anomaly
    expect(result[1].anomalies).toBeUndefined();
  });
});
