import { createHash } from "node:crypto";

/**
 * Compute a content hash from strategy source code.
 * Uses SHA-256 truncated to 8 hex chars.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8).toUpperCase();
}

/**
 * Verify that a file's content matches a previously computed hash.
 * Returns null if valid, or an error description string if mismatch.
 */
export function validateContentHash(content: string, expectedHash: string): string | null {
  const actual = computeContentHash(content);
  if (actual !== expectedHash) {
    return `INTEGRITY_MISMATCH: expected hash ${expectedHash}, got ${actual}`;
  }
  return null;
}
