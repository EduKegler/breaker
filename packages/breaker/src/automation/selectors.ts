/**
 * Centralized CSS selectors for TradingView Playwright automation.
 * Avoids 19+ hardcoded selectors scattered in run-backtest.ts.
 */

export const SELECTORS = {
  // Pine editor
  addScriptToChart: '[data-qa-id="add-script-to-chart"]',
  pineDialogButton: '[data-name="pine-dialog-button"]',
  monacoEditor: ".monaco-editor",
  saveButton: '[data-qa-id="pine-script-save-button"]',
  renameDialog: '[data-name="rename-dialog"]',
  renameInput: '[data-qa-id="ui-lib-Input-input"]',
  saveBtn: '[data-qa-id="save-btn"]',
  confirmDialog: '[data-name="confirm-dialog"]',
  yesBtn: '[data-qa-id="yes-btn"]',

  // Backtest panel
  backtestPanel: ".bottom-widgetbar-content.backtesting",
  backtestTab: '[data-name="backtesting"]',
  backtestPanelHidden: ".bottom-widgetbar-content.backtesting.js-hidden",

  // Compilation errors
  compilationErrorWidget: ".zone-widget-container.peekview-widget",
  errorMarkerMessage: ".marker-widget .message[role='alert']",

  // Strategy & export
  strategyTitle: "[data-strategy-title]",
  dateRangeButton: 'button[aria-haspopup="menu"]',

  // Download
  downloadXlsx: '[aria-label="Baixar dados como XLSX"]',
} as const;

/**
 * Locale-dependent selectors that may differ between PT-BR and EN.
 * Each entry is an array of variant strings to try in order.
 */
export const LOCALE_VARIANTS = {
  last7days: [
    "Últimos 7 dias",
    "Last 7 days",
  ],
  last30days: [
    "Últimos 30 dias",
    "Last 30 days",
  ],
  last90days: [
    "Últimos 90 dias",
    "Last 90 days",
  ],
  last365days: [
    "Últimos 365 dias",
    "Last 365 days",
  ],
  allData: [
    "Todos",
    "All",
    "Desde o início",
    "From the beginning",
  ],
  customDateRange: [
    "Intervalo de datas personalizado…",
    "Intervalo de datas personalizado...",
    "Custom date range…",
    "Custom date range...",
    "Custom range…",
    "Custom range...",
  ],
  reportUpdatedToast: [
    "O relatório foi atualizado com sucesso",
    "Report has been updated successfully",
    "The report has been updated successfully",
  ],
  downloadXlsx: [
    "Baixar dados como XLSX",
    "Download data as XLSX",
  ],
} as const;

export type LocaleKey = keyof typeof LOCALE_VARIANTS;

const PRESET_MAP: Record<string, readonly string[]> = {
  last7: LOCALE_VARIANTS.last7days,
  last30: LOCALE_VARIANTS.last30days,
  last90: LOCALE_VARIANTS.last90days,
  last365: LOCALE_VARIANTS.last365days,
  all: LOCALE_VARIANTS.allData,
};

/**
 * Returns the locale variants for a preset date range key.
 * Throws if the key is not a known preset.
 */
export function getPresetVariants(preset: string): readonly string[] {
  const variants = PRESET_MAP[preset];
  if (!variants) {
    throw new Error(`Unknown date range preset: "${preset}". Valid: ${Object.keys(PRESET_MAP).join(", ")}`);
  }
  return variants;
}

/** Selectors for the custom date range modal (discovered via E2E snapshot) */
export const CUSTOM_DATE_RANGE = {
  modalContainer: '[data-name="custom-date-range-dialog"]',
  dateInput: 'input[data-qa-id="ui-lib-Input-input"]',
  startDateContainer: '[class*="startDatePicker"]',
  submitButton: '[data-name="submit-button"]',
  cancelButton: 'button[name="cancel"]',
} as const;

/**
 * Try each locale variant to find a matching element via aria-label.
 */
export async function locateWithVariants(
  page: import("playwright").Page,
  role: string,
  variants: readonly string[],
  options?: { timeout?: number },
): Promise<import("playwright").Locator> {
  const timeout = options?.timeout ?? 10_000;
  const perVariantTimeout = Math.max(Math.floor(timeout / (variants.length * 2)), 2000);

  for (const variant of variants) {
    // Try getByRole first (matches accessible name: text content, aria-label, etc.)
    const byRole = page.getByRole(role as any, { name: variant });
    const foundRole = await byRole
      .first()
      .waitFor({ state: "visible", timeout: perVariantTimeout })
      .then(() => true)
      .catch(() => false);
    if (foundRole) return byRole.first();

    // Fallback: aria-label selector
    const byLabel = page.locator(`[aria-label="${variant}"]`);
    const foundLabel = await byLabel
      .waitFor({ state: "visible", timeout: Math.min(perVariantTimeout, 2000) })
      .then(() => true)
      .catch(() => false);
    if (foundLabel) return byLabel;
  }

  throw new Error(
    `None of the locale variants found: ${variants.join(", ")} (role=${role}, timeout=${timeout}ms)`,
  );
}

/**
 * Wait for any of the toast text variants to appear.
 */
export async function waitForToastVariants(
  page: import("playwright").Page,
  variants: readonly string[],
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 30_000;
  const selector = variants.map((v) => `text=${v}`).join(", ");

  // Use page.waitForFunction to check for any variant
  await page.waitForFunction(
    (texts: string[]) => {
      return texts.some((t) => document.body.innerText.includes(t));
    },
    [...variants],
    { timeout, polling: 500 },
  );

  void selector; // used for documentation
}
