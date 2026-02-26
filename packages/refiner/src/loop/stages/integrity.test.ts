import { describe, it, expect } from "vitest";
import { computeContentHash, validateContentHash } from "./integrity.js";

describe("computeContentHash", () => {
  it("returns an 8-char uppercase hex string", () => {
    const hash = computeContentHash("some content");
    expect(hash).toMatch(/^[0-9A-F]{8}$/);
  });

  it("returns different hashes for different content", () => {
    const h1 = computeContentHash("content A");
    const h2 = computeContentHash("content B");
    expect(h1).not.toBe(h2);
  });

  it("returns same hash for same content", () => {
    const h1 = computeContentHash("same content");
    const h2 = computeContentHash("same content");
    expect(h1).toBe(h2);
  });
});

describe("validateContentHash", () => {
  it("returns null when hash matches", () => {
    const hash = computeContentHash("some content");
    expect(validateContentHash("some content", hash)).toBeNull();
  });

  it("returns error when hash mismatches", () => {
    const result = validateContentHash("some content", "DEADBEEF");
    expect(result).toContain("INTEGRITY_MISMATCH");
    expect(result).toContain("DEADBEEF");
  });
});
