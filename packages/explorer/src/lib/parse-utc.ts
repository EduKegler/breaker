/** SQLite datetime('now') returns UTC without 'Z' — append it so JS parses as UTC */
export function parseUtc(dt: string): Date {
  return new Date(dt.endsWith("Z") ? dt : dt + "Z");
}
