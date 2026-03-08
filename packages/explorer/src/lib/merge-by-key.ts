/**
 * Merges incoming items into a keyed record bucket, deduplicating by key and sorting.
 *
 * Returns the original `prev` reference when nothing new is added (stable identity).
 */
export function mergeByKey<T>(
  prev: Record<string, T[]>,
  bucket: string,
  incoming: T[],
  keyFn: (item: T) => string | number,
  sortFn: (a: T, b: T) => number,
): Record<string, T[]> {
  const existing = prev[bucket] ?? [];
  const keys = new Set(existing.map(keyFn));
  const fresh = incoming.filter((item) => !keys.has(keyFn(item)));
  if (fresh.length === 0) return prev;
  return { ...prev, [bucket]: [...existing, ...fresh].sort(sortFn) };
}
