import XLSX from "xlsx";

export interface FindMetricOptions {
  exact?: boolean;
  skipZero?: boolean;
  colOffset?: number | null;
}

/**
 * Finds a numeric metric value in a sheet by searching for a label.
 * Searches columns A..Z for a cell containing `label` (case-insensitive),
 * then grabs the numeric value in the same row to the right.
 */
export function findMetricInSheet(
  sheet: XLSX.WorkSheet,
  label: string,
  { exact = false, skipZero = false, colOffset = null }: FindMetricOptions = {},
): number | null {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:Z100");
  const needle = label.toLowerCase();

  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const text = String(cell.v ?? "").toLowerCase().trim();
      const matches = exact ? text === needle : text.includes(needle);
      if (!matches) continue;

      if (colOffset !== null) {
        const valCell = sheet[XLSX.utils.encode_cell({ r, c: c + colOffset })];
        if (!valCell) continue;
        if (typeof valCell.v === "number") {
          if (skipZero && valCell.v === 0) continue;
          return valCell.v;
        }
        const parsed = parseFloat(
          String(valCell.v ?? "").replace(/[^0-9.\-]/g, ""),
        );
        if (!isNaN(parsed) && !(skipZero && parsed === 0)) return parsed;
        continue;
      }

      // Search for numeric value in the next 3 columns
      for (let dc = 1; dc <= 3; dc++) {
        const valCell = sheet[XLSX.utils.encode_cell({ r, c: c + dc })];
        if (!valCell) continue;
        if (typeof valCell.v === "number") {
          if (skipZero && valCell.v === 0) continue;
          return valCell.v;
        }
        if (typeof valCell.v === "string") {
          const parsed = parseFloat(valCell.v.replace(/[^0-9.\-]/g, ""));
          if (!isNaN(parsed) && !(skipZero && parsed === 0)) return parsed;
        }
      }
    }
  }
  return null;
}

/**
 * Converts a sheet to an array of rows (first row = header).
 */
export function sheetToRows(
  sheet: XLSX.WorkSheet,
): Record<string, unknown>[] {
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/**
 * Prints sheet structure to stderr for debugging.
 */
export function debugSheet(sheet: XLSX.WorkSheet, name: string): void {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  });
  process.stderr.write(`\n=== DEBUG Sheet: "${name}" ===\n`);
  rows.slice(0, 20).forEach((row, i) => {
    process.stderr.write(`  Row ${i}: ${JSON.stringify(row)}\n`);
  });
  process.stderr.write(`  (total rows: ${rows.length})\n`);
}

/**
 * Converts an Excel serial date number to a JS Date (UTC).
 * TradingView exports dates as fractional days since 1900-01-01.
 */
export function excelSerialToDate(serial: number): Date | null {
  if (typeof serial !== "number" || !isFinite(serial)) return null;
  return new Date((serial - 25569) * 86400 * 1000);
}
