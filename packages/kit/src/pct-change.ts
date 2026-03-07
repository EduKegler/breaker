export function pctChange(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100;
}
