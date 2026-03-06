/**
 * Rewrite `value:` fields in a strategy source's DEFAULT_PARAMS to match param overrides.
 * This ensures the .ts file is self-contained — running it without external overrides
 * produces the same results as with the overrides applied at runtime.
 *
 * For each key in `overrides`, matches the pattern `keyName: { value: X` and replaces X.
 * Returns which params were applied and which were stale (key not found in source).
 */
export function bakeParamDefaults(
  source: string,
  overrides: Record<string, number>,
): { source: string; applied: string[]; stale: string[] } {
  let result = source;
  const applied: string[] = [];
  const stale: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    const regex = new RegExp(`(${key}:\\s*\\{\\s*value:\\s*)([\\d.]+)`);
    if (regex.test(result)) {
      result = result.replace(regex, `$1${value}`);
      applied.push(key);
    } else {
      stale.push(key);
    }
  }

  return { source: result, applied, stale };
}
