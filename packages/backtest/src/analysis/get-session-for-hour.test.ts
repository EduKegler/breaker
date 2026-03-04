import { describe, it, expect } from "vitest";
import { getSessionForTimestamp } from "./get-session-for-hour.js";

function ts(iso: string): number {
  return new Date(iso).getTime();
}

describe("getSessionForTimestamp", () => {
  describe("winter (standard time — no DST)", () => {
    // Jan 15 2024: London=GMT (UTC+0), NY=EST (UTC-5)
    // Boundaries: Asia 0-7, London 8-12, NY 13-20, Off-peak 21-23
    it("classifies Asia (00:00–07:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T00:00:00Z"))).toBe("Asia");
      expect(getSessionForTimestamp(ts("2024-01-15T03:00:00Z"))).toBe("Asia");
      expect(getSessionForTimestamp(ts("2024-01-15T07:59:00Z"))).toBe("Asia");
    });

    it("classifies London (08:00–12:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T08:00:00Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-01-15T10:30:00Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-01-15T12:59:00Z"))).toBe("London");
    });

    it("classifies NY (13:00–20:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T13:00:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-01-15T14:00:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-01-15T20:59:00Z"))).toBe("NY");
    });

    it("classifies Off-peak (21:00–23:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T21:00:00Z"))).toBe("Off-peak");
      expect(getSessionForTimestamp(ts("2024-01-15T23:30:00Z"))).toBe("Off-peak");
    });
  });

  describe("summer (both London BST + NY EDT)", () => {
    // Jul 15 2024: London=BST (UTC+1), NY=EDT (UTC-4)
    // londonShift=1, nyShift=1
    // Boundaries: Asia 0-6, London 7-11, NY 12-19, Off-peak 20-23
    it("classifies Asia (00:00–06:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T00:00:00Z"))).toBe("Asia");
      expect(getSessionForTimestamp(ts("2024-07-15T06:59:00Z"))).toBe("Asia");
    });

    it("classifies London (07:00–11:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T07:00:00Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-07-15T10:00:00Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-07-15T11:59:00Z"))).toBe("London");
    });

    it("classifies NY (12:00–19:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T12:00:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-07-15T15:00:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-07-15T19:59:00Z"))).toBe("NY");
    });

    it("classifies Off-peak (20:00–23:59 UTC)", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T20:00:00Z"))).toBe("Off-peak");
      expect(getSessionForTimestamp(ts("2024-07-15T23:59:00Z"))).toBe("Off-peak");
    });
  });

  describe("transition: US EDT but UK still GMT (mid-March)", () => {
    // Mar 12 2024: US switched to EDT (Mar 10), UK still GMT (switches Mar 31)
    // londonShift=0, nyShift=1
    // Boundaries: Asia 0-7, London 8-11, NY 12-19, Off-peak 20-23
    it("classifies Asia up to 07:59 UTC", () => {
      expect(getSessionForTimestamp(ts("2024-03-12T07:59:00Z"))).toBe("Asia");
    });

    it("classifies London 08:00–11:59 UTC", () => {
      expect(getSessionForTimestamp(ts("2024-03-12T08:00:00Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-03-12T11:59:00Z"))).toBe("London");
    });

    it("classifies NY 12:00–19:59 UTC", () => {
      expect(getSessionForTimestamp(ts("2024-03-12T12:00:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-03-12T12:30:00Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-03-12T19:59:00Z"))).toBe("NY");
    });

    it("classifies Off-peak from 20:00 UTC", () => {
      expect(getSessionForTimestamp(ts("2024-03-12T20:00:00Z"))).toBe("Off-peak");
    });
  });

  describe("boundary precision", () => {
    it("summer: 06:59 UTC = Asia, 07:00 UTC = London", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T06:59:59Z"))).toBe("Asia");
      expect(getSessionForTimestamp(ts("2024-07-15T07:00:00Z"))).toBe("London");
    });

    it("summer: 11:59 UTC = London, 12:00 UTC = NY", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T11:59:59Z"))).toBe("London");
      expect(getSessionForTimestamp(ts("2024-07-15T12:00:00Z"))).toBe("NY");
    });

    it("summer: 19:59 UTC = NY, 20:00 UTC = Off-peak", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T19:59:59Z"))).toBe("NY");
      expect(getSessionForTimestamp(ts("2024-07-15T20:00:00Z"))).toBe("Off-peak");
    });
  });

  describe("edge cases", () => {
    it("midnight UTC in winter = Asia", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T00:00:00Z"))).toBe("Asia");
    });

    it("23:59 UTC in winter = Off-peak", () => {
      expect(getSessionForTimestamp(ts("2024-01-15T23:59:00Z"))).toBe("Off-peak");
    });

    it("23:59 UTC in summer = Off-peak", () => {
      expect(getSessionForTimestamp(ts("2024-07-15T23:59:00Z"))).toBe("Off-peak");
    });
  });
});
