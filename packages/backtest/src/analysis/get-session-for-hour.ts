import type { SessionName } from "../types/metrics.js";

export function getSessionForHour(hour: number): SessionName {
  // Asia: 00-08 UTC, London: 08-13 UTC, NY: 13-21 UTC, Off-peak: 21-00 UTC
  if (hour >= 0 && hour < 8) return "Asia";
  if (hour >= 8 && hour < 13) return "London";
  if (hour >= 13 && hour < 21) return "NY";
  return "Off-peak";
}
