import { createHash } from "node:crypto";
import type { PineParams, XlsxParams } from "../../types/parse-results.js";

/**
 * Compute a content token from Pine script content.
 * Uses SHA-256 truncated to 8 hex chars.
 */
export function computeContentToken(pineContent: string): string {
  return createHash("sha256").update(pineContent).digest("hex").slice(0, 8).toUpperCase();
}

/**
 * Validate that the XLSX filename contains the expected content token.
 */
export function validateTokenInFilename(token: string, xlsxFilename: string): boolean {
  return xlsxFilename.includes(`[${token}]`);
}

/**
 * Validate integrity between .pine content and backtest results.
 * Returns null if valid, or an error description string if mismatch detected.
 */
export function validateIntegrity(opts: {
  contentToken: string;
  xlsxFilename: string;
  pineParams: PineParams | null;
  xlsxParams: XlsxParams | null;
}): string | null {
  const { contentToken, xlsxFilename, pineParams, xlsxParams } = opts;

  // Check 1: Token in filename
  if (!validateTokenInFilename(contentToken, xlsxFilename)) {
    return `INTEGRITY_MISMATCH: token ${contentToken} not found in XLSX filename "${xlsxFilename}"`;
  }

  // Check 2: Numeric params match (complementary to token check)
  if (pineParams && xlsxParams) {
    const checks: [string, number | undefined, number | null | undefined][] = [
      ["atrMult", pineParams.atrMult, xlsxParams.atrMult],
      ["rr1", pineParams.rr1, xlsxParams.rr1],
      ["rr2", pineParams.rr2, xlsxParams.rr2],
    ];
    for (const [name, pineVal, xlsxVal] of checks) {
      if (pineVal !== undefined && xlsxVal != null && !isNaN(xlsxVal) && Math.abs(pineVal - xlsxVal) > 0.001) {
        return `INTEGRITY_MISMATCH: ${name} pine=${pineVal} xlsx=${xlsxVal}`;
      }
    }
  }

  return null;
}
