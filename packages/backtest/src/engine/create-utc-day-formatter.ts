export function createUtcDayFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
  });
}
