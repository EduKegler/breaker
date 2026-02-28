import { describe, it, expect } from "vitest";
import { integrity } from "./integrity.js";

describe("integrity.computeHash", () => {
  it("returns an 8-char uppercase hex string", () => {
    const hash = integrity.computeHash("some content");
    expect(hash).toMatch(/^[0-9A-F]{8}$/);
  });

  it("returns different hashes for different content", () => {
    const h1 = integrity.computeHash("content A");
    const h2 = integrity.computeHash("content B");
    expect(h1).not.toBe(h2);
  });

  it("returns same hash for same content", () => {
    const h1 = integrity.computeHash("same content");
    const h2 = integrity.computeHash("same content");
    expect(h1).toBe(h2);
  });
});

describe("integrity.validateHash", () => {
  it("returns null when hash matches", () => {
    const hash = integrity.computeHash("some content");
    expect(integrity.validateHash("some content", hash)).toBeNull();
  });

  it("returns error when hash mismatches", () => {
    const result = integrity.validateHash("some content", "DEADBEEF");
    expect(result).toContain("INTEGRITY_MISMATCH");
    expect(result).toContain("DEADBEEF");
  });
});
