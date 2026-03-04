import type { SessionName } from "../types/metrics.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

function utcOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getFormatter(timeZone).formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

const LONDON_STD = 0; // GMT offset in minutes
const NY_STD = -300; // EST offset in minutes

export function getSessionForTimestamp(timestampMs: number): SessionName {
  const date = new Date(timestampMs);
  const utcHour = date.getUTCHours();

  const londonShift =
    (utcOffsetMinutes(date, "Europe/London") - LONDON_STD) / 60;
  const nyShift =
    (utcOffsetMinutes(date, "America/New_York") - NY_STD) / 60;

  const asiaEnd = 8 - londonShift;
  const londonEnd = 13 - nyShift;
  const nyEnd = 21 - nyShift;

  if (utcHour < asiaEnd) return "Asia";
  if (utcHour < londonEnd) return "London";
  if (utcHour < nyEnd) return "NY";
  return "Off-peak";
}
