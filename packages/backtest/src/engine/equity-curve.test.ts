import { describe, it, expect } from "vitest";
import { EquityCurve } from "./equity-curve.js";

describe("EquityCurve", () => {
  it("starts at initial capital", () => {
    const ec = new EquityCurve(1000);
    expect(ec.getEquity()).toBe(1000);
    expect(ec.getPeak()).toBe(1000);
    expect(ec.getCurrentDrawdown()).toBe(0);
  });

  it("tracks equity increase", () => {
    const ec = new EquityCurve(1000);
    ec.record(1, 0, 100);
    expect(ec.getEquity()).toBe(1100);
    expect(ec.getPeak()).toBe(1100);
    expect(ec.getCurrentDrawdown()).toBe(0);
  });

  it("tracks drawdown correctly", () => {
    const ec = new EquityCurve(1000);
    ec.record(1, 0, 200); // equity = 1200, peak = 1200
    ec.record(2, 1, -300); // equity = 900, peak = 1200
    expect(ec.getEquity()).toBe(900);
    expect(ec.getPeak()).toBe(1200);
    expect(ec.getCurrentDrawdown()).toBeCloseTo(-0.25, 10); // -300/1200
  });

  it("computes max drawdown percentage", () => {
    const ec = new EquityCurve(1000);
    ec.record(1, 0, 500); // 1500
    ec.record(2, 1, -600); // 900 (dd = -600/1500 = -40%)
    ec.record(3, 2, 200); // 1100
    ec.record(4, 3, -50); // 1050
    expect(ec.getMaxDrawdownPct()).toBeCloseTo(-40, 5);
  });

  it("returns total return and percentage", () => {
    const ec = new EquityCurve(1000);
    ec.record(1, 0, 250);
    expect(ec.getTotalReturn()).toBe(250);
    expect(ec.getTotalReturnPct()).toBeCloseTo(25, 10);
  });

  it("records points with correct structure", () => {
    const ec = new EquityCurve(1000);
    ec.record(100, 0, 50);
    ec.record(200, 1, -20);
    const points = ec.getPoints();
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      timestamp: 100,
      barIndex: 0,
      equity: 1050,
      drawdown: 0,
    });
    expect(points[1].equity).toBe(1030);
    expect(points[1].drawdown).toBeCloseTo(-20 / 1050, 10);
  });

  it("getTotalReturnPct returns 0 when initialCapital is 0", () => {
    const ec = new EquityCurve(0);
    ec.record(1, 0, 50);
    expect(ec.getTotalReturnPct()).toBe(0);
    expect(ec.getTotalReturn()).toBe(50);
  });

  it("getPoints returns a copy", () => {
    const ec = new EquityCurve(1000);
    ec.record(1, 0, 10);
    const p1 = ec.getPoints();
    ec.record(2, 1, 20);
    const p2 = ec.getPoints();
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(2);
  });
});
