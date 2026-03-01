import { describe, it, expect } from "vitest";
import { backoffDelay } from "./backoff-delay.js";

describe("backoffDelay", () => {
  it("returns base delay for attempt 1", () => {
    expect(backoffDelay(1, 5000)).toBe(5000);
  });

  it("doubles delay for each attempt", () => {
    expect(backoffDelay(2, 5000)).toBe(10000);
    expect(backoffDelay(3, 5000)).toBe(20000);
  });

  it("caps at maxMs", () => {
    expect(backoffDelay(10, 5000, 60000)).toBe(60000);
  });

  it("uses defaults", () => {
    expect(backoffDelay(1)).toBe(5000);
  });
});
