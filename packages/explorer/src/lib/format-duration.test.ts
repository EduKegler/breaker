import { describe, it, expect } from "vitest";
import { formatDuration } from "./format-duration.js";

describe("formatDuration", () => {
  it("returns '—' for null", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("returns '<1m' for durations under 60s", () => {
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(0)).toBe("<1m");
  });

  it("formats minutes only", () => {
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(2 * 3600_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("formats hours without minutes when exact", () => {
    expect(formatDuration(3 * 3600_000)).toBe("3h");
  });

  it("formats days and hours", () => {
    expect(formatDuration(1 * 86400_000 + 4 * 3600_000)).toBe("1d 4h");
  });

  it("formats days without hours when exact", () => {
    expect(formatDuration(2 * 86400_000)).toBe("2d");
  });

  it("formats days with hours and drops minutes", () => {
    expect(formatDuration(1 * 86400_000 + 2 * 3600_000 + 30 * 60_000)).toBe("1d 2h");
  });
});
