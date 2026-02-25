import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import XLSX from "xlsx";
import {
  computeFilterSimulations,
  computeWalkForward,
  parsePineParamsFromContent,
  parsePineParams,
  detectStaleness,
  parseOverviewSheet,
  parseRiskAdjustedSheet,
  parseTradesAnalysisSheet,
  countTradesInListSheet,
  parsePropertiesSheet,
  findLatestXlsx,
  analyzeTradeListSheet,
  countPineInputs,
  getSessionForHour,
  computeSessionBreakdown,
} from "./parse-results.js";
import { findMetricInSheet, excelSerialToDate, sheetToRows } from "../lib/xlsx-utils.js";
import type { HourBucket, DayBucket, ExitTypeBucket, TradeMapEntry, PineParams, XlsxParams } from "../types/parse-results.js";

// --- Helper: create a sheet from rows ---
function makeSheet(rows: unknown[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}

describe("findMetricInSheet", () => {
  it("finds a metric by label with auto column search", () => {
    const sheet = makeSheet([
      ["Header A", "Header B"],
      ["lucro líquido", 242.68],
      ["other metric", 100],
    ]);
    expect(findMetricInSheet(sheet, "lucro líquido")).toBe(242.68);
  });

  it("finds a metric with exact match", () => {
    const sheet = makeSheet([
      ["Label", "Value"],
      ["total de negociações em aberto", 0],
      ["total de negociações", 188],
    ]);
    // exact should skip "em aberto" and find the right one
    expect(
      findMetricInSheet(sheet, "total de negociações", { exact: true, skipZero: true }),
    ).toBe(188);
  });

  it("finds a metric with specific colOffset", () => {
    const sheet = makeSheet([
      ["Label", "Col B", "Col C"],
      ["lucro líquido", 242.68, 10.5],
    ]);
    expect(
      findMetricInSheet(sheet, "lucro líquido", { exact: true, colOffset: 2 }),
    ).toBe(10.5);
  });

  it("returns null for missing label", () => {
    const sheet = makeSheet([["foo", 42]]);
    expect(findMetricInSheet(sheet, "nonexistent")).toBe(null);
  });

  it("skips zero values when skipZero is true", () => {
    const sheet = makeSheet([
      ["total de negociações", 0],
      ["total de negociações", 150],
    ]);
    expect(
      findMetricInSheet(sheet, "total de negociações", { skipZero: true }),
    ).toBe(150);
  });
});

describe("excelSerialToDate", () => {
  it("converts Excel serial to correct UTC date", () => {
    // 2024-01-01 00:00:00 UTC = serial 45292
    const date = excelSerialToDate(45292);
    expect(date).not.toBeNull();
    expect(date!.getUTCFullYear()).toBe(2024);
    expect(date!.getUTCMonth()).toBe(0); // January
    expect(date!.getUTCDate()).toBe(1);
  });

  it("returns null for non-finite input", () => {
    expect(excelSerialToDate(NaN)).toBeNull();
    expect(excelSerialToDate(Infinity)).toBeNull();
  });
});

describe("computeFilterSimulations", () => {
  it("computes hour and day simulations correctly", () => {
    const byHour: Record<number, HourBucket> = {
      10: { count: 20, pnl: -30 },
      14: { count: 15, pnl: 50 },
      3: { count: 2, pnl: -5 }, // below minTradesForFilter (6), should be excluded
    };
    const byDow: Record<string, DayBucket> = {
      Mon: { count: 25, pnl: -20 },
      Fri: { count: 10, pnl: 35 },
    };
    const byExitType: Record<string, ExitTypeBucket> = {
      "S-SL": { count: 50, pnl: -100, wins: 0 },
      "Close Position": { count: 80, pnl: 250, wins: 40 },
    };
    const totalPnl = 150;
    const totalTrades = 130;

    const result = computeFilterSimulations(
      totalTrades,
      byHour,
      byDow,
      byExitType,
      totalPnl,
    );

    // Hour 3 should be excluded (count < 6)
    expect(result.byHour.length).toBe(2);
    // Hour 10 has negative pnl, blocking it improves pnl: pnlDelta = -(-30) = 30
    const hour10 = result.byHour.find((h) => h.hour === 10);
    expect(hour10).toBeDefined();
    expect(hour10!.pnlDelta).toBe(30);
    expect(hour10!.tradesAfter).toBe(110);

    // Day simulations
    expect(result.byDay.length).toBe(2);
    const mon = result.byDay.find((d) => d.day === "Mon");
    expect(mon!.pnlDelta).toBe(20);

    // SL removal
    expect(result.removeAllSL.tradesRemoved).toBe(50);
    expect(result.removeAllSL.pnlDelta).toBe(100);
  });

  it("handles empty inputs", () => {
    const result = computeFilterSimulations(0, {}, {}, {}, 0);
    expect(result.totalTrades).toBe(0);
    expect(result.byHour).toEqual([]);
    expect(result.byDay).toEqual([]);
    expect(result.removeAllSL.tradesRemoved).toBe(0);
  });
});

describe("computeWalkForward", () => {
  it("returns null for fewer than 10 trades", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    for (let i = 0; i < 9; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i * 0.01,
        exitSerial: 45292 + i * 0.01 + 0.005,
        pnl: i % 2 === 0 ? 10 : -5,
      };
    }
    expect(computeWalkForward(tradeMap)).toBeNull();
  });

  it("splits trades into train/test and computes hour consistency", () => {
    // Create 20 trades across different hours
    const tradeMap: Record<string, TradeMapEntry> = {};
    for (let i = 0; i < 20; i++) {
      // Spread across 2 hours (hour 10 and hour 14)
      const hourOffset = i % 2 === 0 ? 10 / 24 : 14 / 24;
      tradeMap[String(i)] = {
        entrySerial: 45292 + i * 1 + hourOffset,
        exitSerial: 45292 + i * 1 + hourOffset + 0.01,
        pnl: i % 2 === 0 ? 10 : -5,
      };
    }

    const result = computeWalkForward(tradeMap);
    expect(result).not.toBeNull();
    expect(result!.trainTrades).toBe(14); // 70% of 20
    expect(result!.testTrades).toBe(6);
    expect(result!.splitRatio).toBe(0.7);
    expect(result!.hourConsistency.length).toBeGreaterThan(0);
  });
});

describe("parsePineParamsFromContent", () => {
  const samplePine = `
//@version=6
strategy("Test", overlay=true)
riskTradeUsd = 10.0
atrMult = 4.0
maxBarsToTp1 = 20
rr1 = 0.5
rr2 = 4.0
cooldownBars = 3
shortOnly = false
useDailyTrend = true
useSessionFilter = true
useDayFilter = true
useVwap = false
useAtrGate = false
useVolume = false
useRsi = false
useSuper = false
useBreakEvenAfterTp1 = true

badHour = hour(time, "UTC")
isBadHour = badHour == 0 or badHour == 4 or badHour == 6

badDay = dayofweek(time, "UTC")
isBadDay = badDay == dayofweek.thursday or badDay == dayofweek.saturday
`;

  it("extracts numeric params", () => {
    const params = parsePineParamsFromContent(samplePine);
    expect(params.riskTradeUsd).toBe(10.0);
    expect(params.atrMult).toBe(4.0);
    expect(params.maxBarsToTp1).toBe(20);
    expect(params.rr1).toBe(0.5);
    expect(params.rr2).toBe(4.0);
    expect(params.cooldownBars).toBe(3);
  });

  it("extracts boolean filters", () => {
    const params = parsePineParamsFromContent(samplePine);
    expect(params.filters.shortOnly).toBe(false);
    expect(params.filters.useDailyTrend).toBe(true);
    expect(params.filters.useSessionFilter).toBe(true);
    expect(params.filters.useVwap).toBe(false);
  });

  it("extracts blocked hours", () => {
    const params = parsePineParamsFromContent(samplePine);
    expect(params.blockedHours).toEqual([0, 4, 6]);
  });

  it("extracts blocked days", () => {
    const params = parsePineParamsFromContent(samplePine);
    expect(params.blockedDays).toEqual(["Thu", "Sat"]);
  });

  it("returns empty arrays for pine without filters", () => {
    const minimal = `riskTradeUsd = 5.0`;
    const params = parsePineParamsFromContent(minimal);
    expect(params.blockedHours).toEqual([]);
    expect(params.blockedDays).toEqual([]);
    expect(params.riskTradeUsd).toBe(5.0);
  });

  it("extracts Session ORB + Squeeze params", () => {
    const orbPine = `
//@version=6
strategy("BTC Session ORB + Squeeze", overlay=true)
riskTradeUsd = 5.0
slAtrMult = 1.5
rrTarget = 3.0
maxBarsInTrade = 60
cooldownBars = 4
adxMin = 20.0
bbLen = 20
bbMult = 2.0
kcLen = 20
kcMult = 1.5
emaLen = 40
adxLen = 14
atrLen = 14
minStopPct = 0.003
maxNotionalUsd = 1500.0
maxEntriesPerDay = 4
dailyLossUsd = 10.0
useDayFilter = true
`;
    const params = parsePineParamsFromContent(orbPine);
    expect(params.riskTradeUsd).toBe(5.0);
    expect(params.slAtrMult).toBe(1.5);
    expect(params.rrTarget).toBe(3.0);
    expect(params.maxBarsInTrade).toBe(60);
    expect(params.cooldownBars).toBe(4);
    expect(params.adxMin).toBe(20.0);
    expect(params.bbLen).toBe(20);
    expect(params.bbMult).toBe(2.0);
    expect(params.kcLen).toBe(20);
    expect(params.kcMult).toBe(1.5);
    expect(params.emaLen).toBe(40);
    expect(params.adxLen).toBe(14);
    expect(params.atrLen).toBe(14);
    expect(params.minStopPct).toBe(0.003);
    expect(params.maxNotionalUsd).toBe(1500.0);
    expect(params.maxEntriesPerDay).toBe(4);
    expect(params.dailyLossUsd).toBe(10.0);
    expect(params.filters.useDayFilter).toBe(true);
    // Legacy params should be undefined
    expect(params.atrMult).toBeUndefined();
    expect(params.rr1).toBeUndefined();
    expect(params.rr2).toBeUndefined();
    expect(params.maxBarsToTp1).toBeUndefined();
  });
});

describe("detectStaleness", () => {
  it("returns false when params match", () => {
    const pine: PineParams = {
      riskTradeUsd: 10,
      atrMult: 4.0,
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: 10,
      atrMult: 4.0,
      maxBarsToTp1: NaN,
      rr1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    expect(detectStaleness(pine, xlsx)).toBe(false);
  });

  it("returns true when params diverge", () => {
    const pine: PineParams = {
      riskTradeUsd: 10,
      atrMult: 5.0,
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: 10,
      atrMult: 4.0,
      maxBarsToTp1: NaN,
      rr1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    expect(detectStaleness(pine, xlsx)).toBe(true);
  });

  it("returns false when either param set is null", () => {
    expect(detectStaleness(null, null)).toBe(false);
    expect(detectStaleness(null, { riskTradeUsd: 10, atrMult: 4, maxBarsToTp1: 20, rr1: 0.5, rr2: 4, cooldownBars: 3 })).toBe(false);
  });

  it("returns true when pine has value but xlsx has NaN", () => {
    const pine: PineParams = {
      riskTradeUsd: 10,
      atrMult: 4.0,
      rr1: 0.5,
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: 10,
      atrMult: 4.0,
      rr1: NaN, // Pine has 0.5 but XLSX is NaN
      maxBarsToTp1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    // With plain constants (no input.*), xlsx params are NaN — skip, not stale
    expect(detectStaleness(pine, xlsx)).toBe(false);
  });

  it("returns false when both are NaN for a param", () => {
    const pine: PineParams = {
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: NaN,
      atrMult: NaN,
      maxBarsToTp1: NaN,
      rr1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    expect(detectStaleness(pine, xlsx)).toBe(false);
  });

  it("detects staleness within tolerance", () => {
    const pine: PineParams = {
      riskTradeUsd: 10.0001,
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: 10.0,
      atrMult: NaN,
      maxBarsToTp1: NaN,
      rr1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    // Difference < 0.001 tolerance
    expect(detectStaleness(pine, xlsx)).toBe(false);
  });

  it("returns false (not stale) when ALL xlsx params are NaN", () => {
    const pine: PineParams = {
      riskTradeUsd: 10,
      atrMult: 4.5,
      rr1: 0.5,
      rr2: 4.0,
      filters: {},
      blockedHours: [],
      blockedDays: [],
    };
    const xlsx: XlsxParams = {
      riskTradeUsd: NaN,
      atrMult: NaN,
      maxBarsToTp1: NaN,
      rr1: NaN,
      rr2: NaN,
      cooldownBars: NaN,
    };
    // When all xlsx params are NaN (plain constants, no inputs), should NOT be stale
    expect(detectStaleness(pine, xlsx)).toBe(false);
  });
});

describe("findMetricInSheet — additional cases", () => {
  it("parses string values as numbers", () => {
    const sheet = makeSheet([
      ["Label", "Value"],
      ["profit factor", "$1.45 USD"],
    ]);
    expect(findMetricInSheet(sheet, "profit factor")).toBe(1.45);
  });

  it("returns null when colOffset cell is empty", () => {
    const sheet = makeSheet([
      ["Label", ""],
      ["lucro líquido", null],
    ]);
    expect(
      findMetricInSheet(sheet, "lucro líquido", { exact: true, colOffset: 1 }),
    ).toBe(null);
  });

  it("parses string value at colOffset", () => {
    const sheet = makeSheet([
      ["Label", "$150.50"],
    ]);
    expect(
      findMetricInSheet(sheet, "Label", { exact: true, colOffset: 1 }),
    ).toBe(150.50);
  });

  it("uses case-insensitive matching", () => {
    const sheet = makeSheet([
      ["LUCRO LÍQUIDO", 100],
    ]);
    expect(findMetricInSheet(sheet, "lucro líquido")).toBe(100);
  });

  it("uses partial matching by default", () => {
    const sheet = makeSheet([
      ["total de negociações em aberto", 5],
    ]);
    expect(findMetricInSheet(sheet, "total de negociações")).toBe(5);
  });
});

describe("sheetToRows", () => {
  it("converts sheet to array of row objects", () => {
    const sheet = makeSheet([
      ["Name", "Value", "Notes"],
      ["alpha", 10, "first"],
      ["beta", 20, "second"],
    ]);
    const rows = sheetToRows(sheet);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: "alpha", Value: 10, Notes: "first" });
    expect(rows[1]).toEqual({ Name: "beta", Value: 20, Notes: "second" });
  });

  it("returns empty array for header-only sheet", () => {
    const sheet = makeSheet([["Header"]]);
    const rows = sheetToRows(sheet);
    expect(rows).toHaveLength(0);
  });
});

describe("excelSerialToDate — additional cases", () => {
  it("returns null for non-number input", () => {
    expect(excelSerialToDate("not-a-number" as unknown as number)).toBeNull();
  });

  it("handles fractional serial (time component)", () => {
    // 45292.5 = 2024-01-01 12:00:00 UTC
    const date = excelSerialToDate(45292.5);
    expect(date).not.toBeNull();
    expect(date!.getUTCHours()).toBe(12);
  });
});

describe("computeWalkForward — additional cases", () => {
  it("skips trades without entry or exit serial", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    // 12 trades total, but 3 incomplete
    for (let i = 0; i < 12; i++) {
      if (i < 3) {
        // Incomplete: no exit serial
        tradeMap[String(i)] = {
          entrySerial: 45292 + i,
          pnl: 10,
        };
      } else {
        tradeMap[String(i)] = {
          entrySerial: 45292 + i,
          exitSerial: 45292 + i + 0.01,
          pnl: i % 2 === 0 ? 10 : -5,
        };
      }
    }
    // Only 9 complete trades — below threshold of 10
    expect(computeWalkForward(tradeMap)).toBeNull();
  });

  it("handles custom split ratio", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    for (let i = 0; i < 20; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i,
        exitSerial: 45292 + i + 0.01,
        pnl: i % 2 === 0 ? 10 : -5,
      };
    }
    const result = computeWalkForward(tradeMap, 0.8);
    expect(result).not.toBeNull();
    expect(result!.trainTrades).toBe(16); // 80% of 20
    expect(result!.testTrades).toBe(4);
    expect(result!.splitRatio).toBe(0.8);
  });
});

describe("parsePineParamsFromContent — additional cases", () => {
  it("parses input.float() wrapping correctly", () => {
    const pine = `
atrMult = input.float(4.5, "ATR Multiplier", minval=1.0, maxval=10.0)
rr1 = input.float(0.5, "TP1 R", minval=0.1)
rr2 = 4.0
`;
    const params = parsePineParamsFromContent(pine);
    expect(params.atrMult).toBe(4.5);
    expect(params.rr1).toBe(0.5);
    expect(params.rr2).toBe(4.0);
  });

  it("handles pine with no matching patterns", () => {
    const params = parsePineParamsFromContent("// empty script\nplot(close)");
    expect(params.blockedHours).toEqual([]);
    expect(params.blockedDays).toEqual([]);
    expect(params.filters).toEqual({});
  });

  it("deduplicates blocked hours", () => {
    const pine = `
badHour = hour(time, "UTC")
isBadHour = badHour == 10 or badHour == 10 or badHour == 14
`;
    const params = parsePineParamsFromContent(pine);
    expect(params.blockedHours).toEqual([10, 14]);
  });

  it("maps all known day names", () => {
    const pine = `
badDay = dayofweek(time, "UTC")
isBadDay = badDay == dayofweek.sunday or badDay == dayofweek.monday or badDay == dayofweek.tuesday or badDay == dayofweek.wednesday or badDay == dayofweek.friday
`;
    const params = parsePineParamsFromContent(pine);
    expect(params.blockedDays).toContain("Sun");
    expect(params.blockedDays).toContain("Mon");
    expect(params.blockedDays).toContain("Tue");
    expect(params.blockedDays).toContain("Wed");
    expect(params.blockedDays).toContain("Fri");
    expect(params.blockedDays).toHaveLength(5);
  });

  it("extracts blocked hours from utcHour == N pattern (not just badHour)", () => {
    const pine = `
badHour = utcHour == 0 or utcHour == 1 or utcHour == 5
`;
    const params = parsePineParamsFromContent(pine);
    expect(params.blockedHours).toEqual([0, 1, 5]);
  });

  it("extracts blocked hours from mixed badHour and utcHour patterns", () => {
    const pine = `
isBadHour = badHour == 3 or badHour == 7
altBadHour = utcHour == 10
`;
    const params = parsePineParamsFromContent(pine);
    expect(params.blockedHours).toEqual([3, 7, 10]);
  });
});

// --- Phase 2: New sheet parser tests ---

describe("parseOverviewSheet", () => {
  it("finds PnL via pt-br 'lucro liquido' label", () => {
    const sheet = makeSheet([
      ["Métrica", "Todos", "Long", "Short"],
      ["Lucro líquido", 250.5, 180.3, 70.2],
      ["Máximo drawdown do patrimônio (intrabarra)", -500, -5.2, null],
    ]);
    const result = parseOverviewSheet(sheet);
    expect(result.totalPnl).toBe(250.5);
  });

  it("finds PnL via 'net profit'", () => {
    const sheet = makeSheet([
      ["Metric", "All"],
      ["Net Profit", 100.5],
    ]);
    const result = parseOverviewSheet(sheet);
    expect(result.totalPnl).toBe(100.5);
  });

  it("finds drawdown", () => {
    const sheet = makeSheet([
      ["Métrica", "Todos", "Pct"],
      ["Lucro líquido", 250.5, 10],
      ["Máximo drawdown do patrimônio (intrabarra)", -500, -5.2],
    ]);
    const result = parseOverviewSheet(sheet);
    expect(result.maxDrawdownPct).toBe(-5.2);
  });

  it("returns nulls for empty sheet", () => {
    const sheet = makeSheet([["nothing here", "no data"]]);
    const result = parseOverviewSheet(sheet);
    expect(result.totalPnl).toBeNull();
    expect(result.maxDrawdownPct).toBeNull();
  });
});

describe("parseRiskAdjustedSheet", () => {
  it("finds PF via 'fator de lucro'", () => {
    const sheet = makeSheet([
      ["Métrica", "Valor"],
      ["Fator de lucro", 1.493],
    ]);
    const result = parseRiskAdjustedSheet(sheet);
    expect(result.profitFactor).toBe(1.493);
  });

  it("finds PF via 'profit factor'", () => {
    const sheet = makeSheet([
      ["Metric", "Value"],
      ["Profit Factor", 1.65],
    ]);
    const result = parseRiskAdjustedSheet(sheet);
    expect(result.profitFactor).toBe(1.65);
  });

  it("returns null when absent", () => {
    const sheet = makeSheet([["Metric", "Value"], ["Other", 42]]);
    const result = parseRiskAdjustedSheet(sheet);
    expect(result.profitFactor).toBeNull();
  });
});

describe("parseTradesAnalysisSheet", () => {
  it("finds numTrades and winRate via pt-br labels", () => {
    const sheet = makeSheet([
      ["Métrica", "Valor", "Pct"],
      ["Total de negociações", 188, null],
      ["Porcentagem rentável", null, 32.5],
    ]);
    const result = parseTradesAnalysisSheet(sheet);
    expect(result.numTrades).toBe(188);
    expect(result.winRate).toBe(32.5);
  });

  it("finds numTrades and winRate via en labels", () => {
    const sheet = makeSheet([
      ["Metric", "Value", "Pct"],
      ["Total Closed Trades", 200, null],
      ["Percent Profitable", null, 28.0],
    ]);
    const result = parseTradesAnalysisSheet(sheet);
    expect(result.numTrades).toBe(200);
    expect(result.winRate).toBe(28.0);
  });

  it("returns nulls for empty sheet", () => {
    const sheet = makeSheet([["nothing", 0]]);
    const result = parseTradesAnalysisSheet(sheet);
    expect(result.numTrades).toBeNull();
    expect(result.winRate).toBeNull();
  });
});

describe("countTradesInListSheet", () => {
  it("counts rows starting with 'sa'", () => {
    const sheet = makeSheet([
      [1, "Entrada long", 45292, "signal", 0, 0, 0, 0],
      [1, "Saída long", 45292.1, "TP1", 0, 0, 0, 10],
      [2, "Entrada short", 45293, "signal", 0, 0, 0, 0],
      [2, "Saída short", 45293.1, "SL", 0, 0, 0, -5],
    ]);
    expect(countTradesInListSheet(sheet)).toBe(2);
  });

  it("counts rows starting with 'ex' (English Exit)", () => {
    const sheet = makeSheet([
      [1, "Entry long", 45292, "signal", 0, 0, 0, 0],
      [1, "Exit long", 45292.1, "TP1", 0, 0, 0, 10],
      [2, "Entry short", 45293, "signal", 0, 0, 0, 0],
      [2, "Exit short", 45293.1, "SL", 0, 0, 0, -5],
    ]);
    expect(countTradesInListSheet(sheet)).toBe(2);
  });

  it("counts mixed PT-BR and EN exit rows", () => {
    const sheet = makeSheet([
      [1, "Entrada long", 45292, "signal", 0, 0, 0, 0],
      [1, "Saída long", 45292.1, "TP1", 0, 0, 0, 10],
      [2, "Entry short", 45293, "signal", 0, 0, 0, 0],
      [2, "Exit short", 45293.1, "SL", 0, 0, 0, -5],
    ]);
    expect(countTradesInListSheet(sheet)).toBe(2);
  });

  it("returns 0 for empty sheet", () => {
    const sheet = makeSheet([["Header1", "Header2"]]);
    expect(countTradesInListSheet(sheet)).toBe(0);
  });
});

describe("parsePropertiesSheet", () => {
  it("parses all params from properties sheet", () => {
    const sheet = makeSheet([
      ["Property", "Value"],
      ["Risk per Trade (USD)", 10],
      ["ATR Mult", 4.5],
      ["Time Stop (bars if TP1 not hit, 0=off)", 20],
      ["TP1 R", 0.5],
      ["TP2 R", 4.0],
      ["Cooldown Bars", 3],
    ]);
    const result = parsePropertiesSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.riskTradeUsd).toBe(10);
    expect(result!.atrMult).toBe(4.5);
    expect(result!.maxBarsToTp1).toBe(20);
    expect(result!.rr1).toBe(0.5);
    expect(result!.rr2).toBe(4.0);
    expect(result!.cooldownBars).toBe(3);
  });

  it("returns null for null sheet", () => {
    expect(parsePropertiesSheet(null as unknown as XLSX.WorkSheet)).toBeNull();
  });

  it("returns NaN for missing values", () => {
    const sheet = makeSheet([["Property", "Value"], ["Other", 42]]);
    const result = parsePropertiesSheet(sheet);
    expect(result).not.toBeNull();
    expect(Number.isNaN(result!.riskTradeUsd)).toBe(true);
    expect(Number.isNaN(result!.atrMult)).toBe(true);
  });
});

describe("findLatestXlsx", () => {
  it("returns the most recent xlsx file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-xlsx-"));
    try {
      // Create two xlsx files with different mtimes
      const file1 = path.join(dir, "old.xlsx");
      const file2 = path.join(dir, "new.xlsx");
      fs.writeFileSync(file1, "old");
      // Ensure different mtime
      const past = new Date(Date.now() - 10000);
      fs.utimesSync(file1, past, past);
      fs.writeFileSync(file2, "new");

      const result = findLatestXlsx(dir);
      expect(result).toBe(file2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("throws when dir does not exist", () => {
    expect(() => findLatestXlsx("/nonexistent/dir/xyz")).toThrow("Results directory not found");
  });

  it("throws when no xlsx files found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-xlsx-"));
    try {
      fs.writeFileSync(path.join(dir, "test.txt"), "not xlsx");
      expect(() => findLatestXlsx(dir)).toThrow("No .xlsx files found in");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("analyzeTradeListSheet", () => {
  // Helper to create a realistic trade list sheet
  function makeTradeListSheet(trades: Array<{
    num: number;
    direction: "long" | "short";
    entrySerial: number;
    exitSerial: number;
    exitSignal: string;
    pnl: number;
  }>): XLSX.WorkSheet {
    const rows: unknown[][] = [
      ["#", "Tipo", "Data/hora", "Sinal", "Preço", "Contratos", "Lucro", "PnL"],
    ];
    for (const t of trades) {
      rows.push([t.num, `Entrada ${t.direction}`, t.entrySerial, "signal", 100, 1, 0, 0]);
      rows.push([t.num, `Saída ${t.direction}`, t.exitSerial, t.exitSignal, 100, 1, t.pnl, t.pnl]);
    }
    return makeSheet(rows);
  }

  // Helper for English trade list sheets
  function makeEnTradeListSheet(trades: Array<{
    num: number;
    direction: "long" | "short";
    entrySerial: number;
    exitSerial: number;
    exitSignal: string;
    pnl: number;
  }>): XLSX.WorkSheet {
    const rows: unknown[][] = [
      ["#", "Type", "Date/time", "Signal", "Price", "Contracts", "Profit", "PnL"],
    ];
    for (const t of trades) {
      rows.push([t.num, `Entry ${t.direction}`, t.entrySerial, "signal", 100, 1, 0, 0]);
      rows.push([t.num, `Exit ${t.direction}`, t.exitSerial, t.exitSignal, 100, 1, t.pnl, t.pnl]);
    }
    return makeSheet(rows);
  }

  it("returns null for sheet with no exit rows", () => {
    const sheet = makeSheet([
      ["#", "Tipo", "Data", "Sinal"],
      [1, "Entrada long", 45292, "signal"],
    ]);
    expect(analyzeTradeListSheet(sheet)).toBeNull();
  });

  it("computes byDirection correctly", () => {
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "SL", pnl: -5 },
      { num: 3, direction: "short", entrySerial: 45294, exitSerial: 45294.01, exitSignal: "TP1", pnl: 8 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.byDirection.long.count).toBe(2);
    expect(result!.byDirection.short.count).toBe(1);
    expect(result!.totalExitRows).toBe(3);
  });

  it("computes byExitType correctly", () => {
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "TP1", pnl: 15 },
      { num: 3, direction: "long", entrySerial: 45294, exitSerial: 45294.01, exitSignal: "SL", pnl: -8 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    const tp1 = result!.byExitType.find((e) => e.signal === "TP1");
    expect(tp1).toBeDefined();
    expect(tp1!.count).toBe(2);
    expect(tp1!.pnl).toBeCloseTo(25, 1);
  });

  it("computes byDayOfWeek correctly", () => {
    // 45292 = 2024-01-01 (Monday)
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "TP1", pnl: 15 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    // 45292.01 exit is Mon, 45293.01 exit is Tue
    expect(result!.byDayOfWeek).toBeDefined();
    expect(Object.keys(result!.byDayOfWeek).length).toBeGreaterThan(0);
  });

  it("computes best and worst trades", () => {
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 25 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "SL", pnl: -30 },
      { num: 3, direction: "long", entrySerial: 45294, exitSerial: 45294.01, exitSignal: "TP1", pnl: 20 },
      { num: 4, direction: "long", entrySerial: 45295, exitSerial: 45295.01, exitSignal: "SL", pnl: -25 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.best3TradesPnl[0]).toBe(25);
    expect(result!.worst3TradesPnl[0]).toBe(-30);
  });

  it("includes filterSimulations in result", () => {
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "SL", pnl: -5 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.filterSimulations).toBeDefined();
    expect(result!.filterSimulations.totalTrades).toBe(2);
  });

  it("includes bySession in result", () => {
    const sheet = makeTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "SL", pnl: -5 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.bySession).toBeDefined();
    expect(result!.bySession).toHaveProperty("Asia");
    expect(result!.bySession).toHaveProperty("London");
    expect(result!.bySession).toHaveProperty("NY");
    expect(result!.bySession).toHaveProperty("Off-peak");
  });

  it("parses English 'Entry/Exit' trade list correctly", () => {
    const sheet = makeEnTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 10 },
      { num: 2, direction: "long", entrySerial: 45293, exitSerial: 45293.01, exitSignal: "SL", pnl: -5 },
      { num: 3, direction: "short", entrySerial: 45294, exitSerial: 45294.01, exitSignal: "TP1", pnl: 8 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.totalExitRows).toBe(3);
    expect(result!.byDirection.long.count).toBe(2);
    expect(result!.byDirection.short.count).toBe(1);
  });

  it("builds tradeMap from English Entry/Exit rows", () => {
    const sheet = makeEnTradeListSheet([
      { num: 1, direction: "long", entrySerial: 45292, exitSerial: 45292.01, exitSignal: "TP1", pnl: 15 },
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.totalExitRows).toBe(1);
    expect(result!.best3TradesPnl[0]).toBe(15);
  });

  it("handles PnL as string (e.g. '$10.50') via parseFloat fallback", () => {
    const sheet = makeSheet([
      ["#", "Tipo", "Data/hora", "Sinal", "Preço", "Contratos", "Lucro", "PnL"],
      [1, "Entrada long", 45292, "signal", 100, 1, 0, 0],
      [1, "Saída long", 45292.01, "TP1", 100, 1, "$10.50", "$10.50"],
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.best3TradesPnl[0]).toBeCloseTo(10.5, 1);
  });

  it("handles unknown direction (neither long nor short)", () => {
    const sheet = makeSheet([
      ["#", "Tipo", "Data/hora", "Sinal", "Preço", "Contratos", "Lucro", "PnL"],
      [1, "Entrada", 45292, "signal", 100, 1, 0, 0],
      [1, "Saída", 45292.01, "TP1", 100, 1, 5, 5],
    ]);
    const result = analyzeTradeListSheet(sheet);
    expect(result).not.toBeNull();
    expect(result!.byDirection.unknown).toBeDefined();
    expect(result!.byDirection.unknown.count).toBe(1);
  });
});

describe("countPineInputs", () => {
  it("counts unique parameter assignments", () => {
    const pine = `
//@version=6
strategy("Test", overlay=true)
riskTradeUsd = 10.0
slAtrMult = 1.5
rrTarget = 3.0
maxBarsInTrade = 60
useDayFilter = true
shortOnly = false
`;
    expect(countPineInputs(pine)).toBe(6);
  });

  it("excludes commented lines", () => {
    const pine = `
riskTradeUsd = 10.0
// slAtrMult = 1.5
rrTarget = 3.0
`;
    expect(countPineInputs(pine)).toBe(2);
  });

  it("excludes var and varip declarations", () => {
    const pine = `
riskTradeUsd = 10.0
var myState = 0
varip myPersist = false
slAtrMult = 1.5
`;
    expect(countPineInputs(pine)).toBe(2);
  });

  it("counts input.float() style parameters", () => {
    const pine = `
atrMult = input.float(4.5, "ATR Multiplier")
rr1 = input.float(0.5, "TP1 R")
useRsi = input.bool(false, "Use RSI")
`;
    expect(countPineInputs(pine)).toBe(3);
  });

  it("deduplicates same parameter name", () => {
    const pine = `
riskTradeUsd = 10.0
riskTradeUsd = 15.0
`;
    expect(countPineInputs(pine)).toBe(1);
  });

  it("returns 0 for empty content", () => {
    expect(countPineInputs("")).toBe(0);
  });

  it("excludes multi-line strategy() declaration arguments", () => {
    const pine = `
//@version=6
strategy("BTC 15m MR",
  overlay              = true,
  initial_capital      = 1000,
  default_qty_type     = strategy.cash,
  default_qty_value    = 100,
  commission_type      = strategy.commission.percent,
  commission_value     = 0.045,
  slippage             = 2,
  process_orders_on_close = false,
  calc_on_every_tick   = false,
  max_bars_back        = 5000)

sigmaBand = 2.0
rsiThreshold = 35
atrMult = 1.5
var float riskTradeUsd = 10.0
var int cooldownBars = 4
`;
    expect(countPineInputs(pine)).toBe(3);
  });

  it("excludes multi-line indicator() declaration arguments", () => {
    const pine = `
//@version=6
indicator("Test",
  overlay = true,
  max_bars_back = 500)

myParam = 42
`;
    expect(countPineInputs(pine)).toBe(1);
  });
});

describe("getSessionForHour", () => {
  it("maps Asia hours correctly", () => {
    expect(getSessionForHour(23)).toBe("Asia");
    expect(getSessionForHour(0)).toBe("Asia");
    expect(getSessionForHour(3)).toBe("Asia");
    expect(getSessionForHour(7)).toBe("Asia");
  });

  it("maps London hours correctly", () => {
    expect(getSessionForHour(8)).toBe("London");
    expect(getSessionForHour(10)).toBe("London");
    expect(getSessionForHour(12)).toBe("London");
  });

  it("maps NY hours correctly", () => {
    expect(getSessionForHour(13)).toBe("NY");
    expect(getSessionForHour(16)).toBe("NY");
    expect(getSessionForHour(19)).toBe("NY");
  });

  it("maps Off-peak hours correctly", () => {
    expect(getSessionForHour(20)).toBe("Off-peak");
    expect(getSessionForHour(21)).toBe("Off-peak");
    expect(getSessionForHour(22)).toBe("Off-peak");
  });
});

describe("computeSessionBreakdown", () => {
  it("groups trades by session and computes stats", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    // Trade at 3 UTC (Asia) - winner
    tradeMap["1"] = { entrySerial: 45292 + 3 / 24, exitSerial: 45292 + 3.5 / 24, pnl: 10 };
    // Trade at 10 UTC (London) - loser
    tradeMap["2"] = { entrySerial: 45292 + 10 / 24, exitSerial: 45292 + 10.5 / 24, pnl: -5 };
    // Trade at 15 UTC (NY) - winner
    tradeMap["3"] = { entrySerial: 45292 + 15 / 24, exitSerial: 45292 + 15.5 / 24, pnl: 8 };
    // Trade at 21 UTC (Off-peak) - loser
    tradeMap["4"] = { entrySerial: 45292 + 21 / 24, exitSerial: 45292 + 21.5 / 24, pnl: -3 };

    const result = computeSessionBreakdown(tradeMap);
    expect(result.Asia.count).toBe(1);
    expect(result.Asia.pnl).toBe(10);
    expect(result.Asia.winRate).toBe(100);
    expect(result.London.count).toBe(1);
    expect(result.London.pnl).toBe(-5);
    expect(result.NY.count).toBe(1);
    expect(result.NY.pnl).toBe(8);
    expect(result["Off-peak"].count).toBe(1);
    expect(result["Off-peak"].pnl).toBe(-3);
  });

  it("handles empty trade map", () => {
    const result = computeSessionBreakdown({});
    expect(result.Asia.count).toBe(0);
    expect(result.London.count).toBe(0);
    expect(result.NY.count).toBe(0);
    expect(result["Off-peak"].count).toBe(0);
  });

  it("caps profitFactor at 99.99 when grossLoss is 0", () => {
    const tradeMap: Record<string, TradeMapEntry> = {
      "1": { entrySerial: 45292 + 3 / 24, exitSerial: 45292 + 3.5 / 24, pnl: 10 },
      "2": { entrySerial: 45292 + 4 / 24, exitSerial: 45292 + 4.5 / 24, pnl: 20 },
    };
    const result = computeSessionBreakdown(tradeMap);
    expect(result.Asia.profitFactor).toBe(99.99);
  });
});

describe("computeWalkForward — PF fields", () => {
  it("computes trainPF, testPF, pfRatio, and overfitFlag", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    // 14 train trades (70% of 20): mix of winners/losers
    // 6 test trades: worse performance
    for (let i = 0; i < 20; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i,
        exitSerial: 45292 + i + 0.01,
        pnl: i < 14
          ? (i % 3 === 0 ? -5 : 10) // train: more winners
          : (i % 2 === 0 ? -8 : 2),  // test: worse
      };
    }
    const result = computeWalkForward(tradeMap);
    expect(result).not.toBeNull();
    expect(result!.trainPF).not.toBeNull();
    expect(result!.testPF).not.toBeNull();
    expect(result!.pfRatio).not.toBeNull();
    expect(typeof result!.overfitFlag).toBe("boolean");
  });

  it("sets overfitFlag true when pfRatio < 0.6", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    // Train: very profitable
    for (let i = 0; i < 14; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i,
        exitSerial: 45292 + i + 0.01,
        pnl: i % 5 === 0 ? -2 : 20,
      };
    }
    // Test: barely profitable
    for (let i = 14; i < 20; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i,
        exitSerial: 45292 + i + 0.01,
        pnl: i % 2 === 0 ? -10 : 3,
      };
    }
    const result = computeWalkForward(tradeMap);
    expect(result).not.toBeNull();
    expect(result!.trainPF).toBeGreaterThan(1);
    // testPF should be much lower than trainPF
    expect(result!.pfRatio).not.toBeNull();
    if (result!.pfRatio !== null) {
      expect(result!.pfRatio).toBeLessThan(0.6);
      expect(result!.overfitFlag).toBe(true);
    }
  });

  it("caps PF at 99.99 when grossLoss is 0", () => {
    const tradeMap: Record<string, TradeMapEntry> = {};
    // All winners
    for (let i = 0; i < 20; i++) {
      tradeMap[String(i)] = {
        entrySerial: 45292 + i,
        exitSerial: 45292 + i + 0.01,
        pnl: 10,
      };
    }
    const result = computeWalkForward(tradeMap);
    expect(result).not.toBeNull();
    expect(result!.trainPF).toBe(99.99);
    expect(result!.testPF).toBe(99.99);
  });
});

describe("parsePineParams (file-reading wrapper)", () => {
  it("returns params from a valid pine file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-parse-"));
    const filePath = path.join(tmpDir, "test.pine");
    fs.writeFileSync(filePath, `//@version=5
strategy("Test")
atrMult = input.float(4.5, "ATR Multiplier")
plot(close)
`);
    const params = parsePineParams(filePath);
    expect(params).not.toBeNull();
    expect(params!.atrMult).toBe(4.5);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns null when file does not exist", () => {
    const params = parsePineParams("/nonexistent/path/strategy.pine");
    expect(params).toBeNull();
  });
});
