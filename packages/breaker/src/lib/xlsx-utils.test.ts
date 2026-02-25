import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";
import { findMetricInSheet, debugSheet, excelSerialToDate } from "./xlsx-utils.js";

function makeSheet(data: (string | number | null)[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(data);
}

describe("findMetricInSheet", () => {
  it("finds value with explicit colOffset", () => {
    const sheet = makeSheet([
      ["Profit Factor", "", 1.5],
    ]);
    const result = findMetricInSheet(sheet, "Profit Factor", { colOffset: 2 });
    expect(result).toBe(1.5);
  });

  it("with exact=true does not match partial labels", () => {
    const sheet = makeSheet([
      ["Total Trades", "", 42],
    ]);
    const result = findMetricInSheet(sheet, "Total", { exact: true });
    expect(result).toBeNull();
  });
});

describe("debugSheet", () => {
  it("writes to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sheet = makeSheet([["A", "B"], [1, 2]]);
    debugSheet(sheet, "test");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("limits output to 20 rows", () => {
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 30; i++) {
      rows.push([`row-${i}`, i]);
    }
    const sheet = makeSheet(rows);

    const calls: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      calls.push(String(chunk));
      return true;
    });

    debugSheet(sheet, "big-sheet");

    const output = calls.join("");
    // Rows 0-19 are printed, row 20+ should not appear
    expect(output).toContain("Row 0:");
    expect(output).toContain("Row 19:");
    expect(output).not.toContain("Row 20:");

    spy.mockRestore();
  });
});

describe("excelSerialToDate", () => {
  it("returns null for NaN and Infinity", () => {
    expect(excelSerialToDate(NaN)).toBeNull();
    expect(excelSerialToDate(Infinity)).toBeNull();
  });
});
