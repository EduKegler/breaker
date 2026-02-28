import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { printSummary, generateHTML } from "./dashboard.js";
import type { DashboardEvent } from "../types/events.js";

const sampleEvent: DashboardEvent = {
  ts: "2026-02-21T12:00:00.000Z",
  iter: 1,
  stage: "PARSE_DONE",
  status: "success",
  pnl: 242.68,
  pf: 1.493,
  dd: 6.11,
  trades: 188,
  message: "All criteria passed",
  run_id: "20260221_120000",
  asset: "BTC",
};

describe("generateHTML", () => {
  it("returns fallback for empty events", () => {
    const html = generateHTML([]);
    expect(html).toContain("No events found");
  });

  it("includes metrics in output", () => {
    const html = generateHTML([sampleEvent]);
    expect(html).toContain("242.68");
    expect(html).toContain("1.493");
    expect(html).toContain("6.11%");
    expect(html).toContain("188");
    expect(html).toContain("20260221_120000");
  });

  it("generates valid HTML structure", () => {
    const html = generateHTML([sampleEvent]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<table>");
  });

  it("generates PnL chart with multiple PARSE_DONE events", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, iter: 1, pnl: 100 },
      { ...sampleEvent, iter: 2, pnl: 150 },
      { ...sampleEvent, iter: 3, pnl: 200 },
    ];
    const html = generateHTML(events);
    expect(html).toContain("<svg");
    expect(html).toContain("polyline");
    expect(html).toContain("PnL Over Iterations");
  });

  it("shows different status colors", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, status: "success" },
      { ...sampleEvent, iter: 2, status: "error", pnl: -50 },
      { ...sampleEvent, iter: 3, status: "info" },
    ];
    const html = generateHTML(events);
    expect(html).toContain("#4CAF50"); // success = green
    expect(html).toContain("#f44336"); // error = red
    expect(html).toContain("#2196F3"); // other = blue
  });

  it("escapes HTML entities in fields (XSS prevention)", () => {
    const maliciousEvent: DashboardEvent = {
      ...sampleEvent,
      message: '<script>alert("xss")</script>',
      stage: 'TEST<img src=x onerror="alert(1)">',
    };
    const html = generateHTML([maliciousEvent]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles event without PARSE_DONE stage (no metrics)", () => {
    const event: DashboardEvent = {
      ...sampleEvent,
      stage: "BACKTEST_START",
    };
    const html = generateHTML([event]);
    expect(html).toContain("BACKTEST_START");
    // Should not show latest metrics section
    expect(html).not.toContain("Latest PnL");
  });

  it("computes max iter from all events", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, iter: 1 },
      { ...sampleEvent, iter: 5 },
      { ...sampleEvent, iter: 3 },
    ];
    const html = generateHTML(events);
    expect(html).toContain("5"); // max iter
  });

  it("shows warning icon for anomalous events", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, iter: 1, pnl: 100, trades: 180 },
      { ...sampleEvent, iter: 2, stage: "OPTIMIZE", status: "info", message: "block hour 15" },
      { ...sampleEvent, iter: 2, pnl: 130, trades: 195 },
    ];
    const html = generateHTML(events);
    // Warning icon (&#9888;) should appear for the anomalous event
    expect(html).toContain("&#9888;");
    expect(html).toContain("dataset shift");
  });

  it("does not show warning icon when no anomalies", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, iter: 1, pnl: 200, trades: 180 },
      { ...sampleEvent, iter: 2, pnl: 210, trades: 175 },
    ];
    const html = generateHTML(events);
    expect(html).not.toContain("&#9888;");
  });

  it("handles metrics with all null values", () => {
    const event: DashboardEvent = {
      ...sampleEvent,
      pnl: 0,
      pf: 0,
      dd: 0,
      trades: 0,
    };
    const html = generateHTML([event]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("handles no chart when only non-PARSE_DONE events", () => {
    const events: DashboardEvent[] = [
      { ...sampleEvent, stage: "BACKTEST_START" },
      { ...sampleEvent, iter: 2, stage: "OPTIMIZE" },
    ];
    const html = generateHTML(events);
    expect(html).not.toContain("PnL Over Iterations");
    expect(html).not.toContain("<svg");
  });

  it("escapes XSS in table cell data", () => {
    const event: DashboardEvent = {
      ...sampleEvent,
      stage: '<img onerror="alert(1)">',
      message: '"><script>evil()</script>',
    };
    const html = generateHTML([event]);
    // Table cells should be escaped via esc()
    expect(html).toContain("&lt;img onerror=");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  });
});

describe("printSummary", () => {
  it("prints 'No events found' for empty array", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSummary([]);
    expect(spy).toHaveBeenCalledWith("No events found.");
    spy.mockRestore();
  });

  it("prints summary with metrics for PARSE_DONE events", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    printSummary([sampleEvent]);

    expect(logs.some((l) => l.includes("B.R.E.A.K.E.R. Dashboard"))).toBe(true);
    expect(logs.some((l) => l.includes("Run ID"))).toBe(true);
    expect(logs.some((l) => l.includes("242.68"))).toBe(true);
    expect(logs.some((l) => l.includes("1.493"))).toBe(true);
    expect(logs.some((l) => l.includes("188"))).toBe(true);
    spy.mockRestore();
  });

  it("prints event table with anomaly flags", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const events: DashboardEvent[] = [
      { ...sampleEvent, iter: 1, pnl: 100, trades: 180 },
      { ...sampleEvent, iter: 2, stage: "OPTIMIZE", status: "info", message: "block hour 15" },
      { ...sampleEvent, iter: 2, pnl: 130, trades: 195 },
    ];
    printSummary(events);

    expect(logs.some((l) => l.includes("[!]"))).toBe(true);
    spy.mockRestore();
  });

  it("does not show latest metrics when no PARSE_DONE", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    printSummary([{ ...sampleEvent, stage: "BACKTEST_START" }]);

    expect(logs.some((l) => l.includes("Latest Metrics"))).toBe(false);
    spy.mockRestore();
  });
});
