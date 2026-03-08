import { describe, it, expect } from "vitest";
import { createUtcDayFormatter } from "./create-utc-day-formatter.js";

describe("createUtcDayFormatter", () => {
  it("returns an Intl.DateTimeFormat instance", () => {
    expect(createUtcDayFormatter()).toBeInstanceOf(Intl.DateTimeFormat);
  });

  it("formats dates in UTC", () => {
    const fmt = createUtcDayFormatter();
    // 2024-01-15 23:00 UTC — would be Jan 16 in UTC+1
    const date = new Date("2024-01-15T23:00:00Z");
    const result = fmt.format(date);
    expect(result).toContain("15");
    expect(result).toContain("1");
  });
});
