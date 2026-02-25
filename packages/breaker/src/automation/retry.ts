import type { Page } from "playwright";

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  label?: string;
}

/**
 * Retry a step with exponential backoff.
 * On failure, optionally takes a screenshot before rethrowing.
 */
export async function retryStep<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, backoffMultiplier = 2, label = "step" } = opts;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts) {
        const wait = delayMs * Math.pow(backoffMultiplier, attempt - 1);
        console.warn(
          `[retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${wait}ms...`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError!;
}

/**
 * Take a screenshot on failure for debugging.
 * Safe to call even if page is in a bad state.
 */
export async function screenshotOnFailure(
  page: Page,
  label: string,
  dir: string,
): Promise<string | null> {
  try {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `${dir}/error-${label}-${timestamp}.png`;
    await page.screenshot({ path: filename, fullPage: false });
    return filename;
  } catch {
    return null;
  }
}
