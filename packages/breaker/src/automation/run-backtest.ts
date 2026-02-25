#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { chromium } from "playwright";
import type { Page, Browser, BrowserContext } from "playwright";
import { SELECTORS, LOCALE_VARIANTS, locateWithVariants, waitForToastVariants, getPresetVariants, CUSTOM_DATE_RANGE } from "./selectors.js";
import { retryStep, screenshotOnFailure } from "./retry.js";

dotenv.config();

const TV_CHART_URL =
  process.env.TV_CHART_URL ||
  "https://br.tradingview.com/chart/ovLwxUsu/";
const STRATEGY_FILE =
  process.env.STRATEGY_FILE || "assets/btc/breakout/squeeze.pine";
const AUTH_FILE = process.env.AUTH_FILE || ".auth/tradingview.json";
const SAVE_SCRIPT_NAME = process.env.SAVE_SCRIPT_NAME || "";
const HEADLESS =
  String(process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);
const FULLSCREEN =
  String(process.env.FULLSCREEN || "true").toLowerCase() === "true";
const DATE_RANGE = process.env.DATE_RANGE || "last365";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export async function runStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  log(`START ${label}`);
  try {
    const result = await fn();
    log(`END ${label} | status=OK | duration_ms=${Date.now() - start}`);
    return result;
  } catch (error) {
    log(`END ${label} | status=ERROR | duration_ms=${Date.now() - start}`);
    throw error;
  }
}

export function launchArgs(): string[] {
  if (HEADLESS || !FULLSCREEN) return [];
  return ["--start-maximized", "--start-fullscreen"];
}

async function setFullscreen(page: Page): Promise<void> {
  if (HEADLESS || !FULLSCREEN) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "fullscreen" },
    });
  } catch {
    // fallback via launch args
  }
}

export function parseStrategyTitle(code: string): string | null {
  const m = code.match(/strategy\s*\(\s*["']([^"']+)["']/);
  return m?.[1] ?? null;
}

export function buildSaveName(code: string): string {
  if (SAVE_SCRIPT_NAME.trim())
    return SAVE_SCRIPT_NAME.trim().slice(0, 120);
  const parsed = parseStrategyTitle(code);
  if (parsed) return `${parsed} - AUTO`.slice(0, 120);
  return `pine-auto-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

export function generateToken(): string {
  // If CONTENT_TOKEN env is set, use it (content-hash based integrity)
  if (process.env.CONTENT_TOKEN) {
    return process.env.CONTENT_TOKEN;
  }
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function injectToken(code: string, token: string): string {
  return code.replace(
    /^(strategy\s*\(\s*["'])([^"']+)(["'])/m,
    (_, open: string, title: string, close: string) =>
      `${open}${title} [${token}]${close}`,
  );
}

export interface ParsedDateRange {
  type: "preset" | "custom";
  preset?: string;
  startDate?: string;
  endDate?: string;
}

export function parseDateRange(raw: string): ParsedDateRange {
  if (raw.startsWith("custom:")) {
    const parts = raw.split(":");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
      throw new Error(`Invalid custom date range: "${raw}". Expected custom:YYYY-MM-DD:YYYY-MM-DD`);
    }
    return { type: "custom", startDate: parts[1], endDate: parts[2] };
  }
  const validPresets = ["last7", "last30", "last90", "last365", "all"];
  if (!validPresets.includes(raw)) {
    throw new Error(`Invalid date range: "${raw}". Valid: ${validPresets.join(", ")}, custom:YYYY-MM-DD:YYYY-MM-DD`);
  }
  return { type: "preset", preset: raw };
}

/**
 * Set the date range in TradingView's backtest panel.
 * Handles both preset ranges (last7/30/90/365/all) and custom date ranges.
 */
export async function setDateRange(page: Page, dateRange: string): Promise<void> {
  const parsed = parseDateRange(dateRange);
  log(`Setting date range: ${dateRange} (type=${parsed.type})...`);

  // Open the date range dropdown
  const dateRangeBtn = page
    .locator(SELECTORS.dateRangeButton)
    .filter({ hasText: /\d{1,2}\s.*\d{4}\s*—/ })
    .first();
  await dateRangeBtn.waitFor({ state: "visible", timeout: 20000 });
  await dateRangeBtn.click();

  if (parsed.type === "preset") {
    const variants = getPresetVariants(parsed.preset!);
    const dateRangeItem = await locateWithVariants(
      page,
      "menuitemcheckbox",
      variants,
      { timeout: 10000 },
    );
    await dateRangeItem.click();
  } else {
    // Custom date range: click the "Custom date range…" menu item
    const customItem = await locateWithVariants(
      page,
      "menuitemcheckbox",
      LOCALE_VARIANTS.customDateRange,
      { timeout: 10000 },
    );
    await customItem.click();

    // Wait for the custom date range modal (data-name="custom-date-range-dialog")
    const modal = page.locator(CUSTOM_DATE_RANGE.modalContainer);
    await modal.waitFor({ state: "visible", timeout: 10000 });

    // Fill start date — first input inside the startDatePicker container
    const startInput = modal
      .locator(CUSTOM_DATE_RANGE.startDateContainer)
      .locator(CUSTOM_DATE_RANGE.dateInput)
      .first();
    await startInput.click({ clickCount: 3 });
    await startInput.fill(parsed.startDate!);
    await startInput.press("Tab");

    // Fill end date — second date input in the modal (not inside startDatePicker)
    const allInputs = modal.locator(CUSTOM_DATE_RANGE.dateInput);
    const endInput = allInputs.nth(1);
    await endInput.click({ clickCount: 3 });
    await endInput.fill(parsed.endDate!);
    await endInput.press("Tab");

    // Wait for submit button to become enabled, then click
    const submitBtn = modal.locator(CUSTOM_DATE_RANGE.submitButton);
    await submitBtn.waitFor({ state: "visible", timeout: 5000 });
    // Wait until aria-disabled is removed (button enables after valid dates)
    await page.waitForFunction(
      (sel: string) => {
        const btn = document.querySelector(sel);
        return btn && btn.getAttribute("aria-disabled") !== "true";
      },
      `${CUSTOM_DATE_RANGE.modalContainer} ${CUSTOM_DATE_RANGE.submitButton}`,
      { timeout: 5000, polling: 250 },
    );
    await submitBtn.click();
  }

  // Wait for report updated toast
  await waitForToastVariants(
    page,
    LOCALE_VARIANTS.reportUpdatedToast,
    { timeout: 30000 },
  );
  log("Toast confirmed: report updated successfully.");
}

interface CompilationError {
  message: string;
  line: number | null;
  column: number | null;
  snippet?: string;
}

export async function readCompilationErrorsFromDom(
  page: Page,
): Promise<CompilationError[]> {
  const errorSelector = SELECTORS.errorMarkerMessage;
  return page
    .evaluate((sel: string) => {
      const errors: Array<{
        message: string;
        line: number | null;
        column: number | null;
      }> = [];
      for (const msgEl of document.querySelectorAll(sel)) {
        const text =
          msgEl.querySelector("div")?.textContent?.trim() ?? "";
        const loc = (
          msgEl.getAttribute("aria-label") ?? ""
        ).match(/(\d+):(\d+)/);
        if (text) {
          errors.push({
            message: text,
            line: loc ? parseInt(loc[1], 10) : null,
            column: loc ? parseInt(loc[2], 10) : null,
          });
        }
      }
      return errors;
    }, errorSelector)
    .catch((err) => {
      console.error(
        `[run-backtest] DOM evaluation failed: ${(err as Error).message}`,
      );
      return [
        {
          message: `DOM evaluation failed: ${(err as Error).message}`,
          line: null,
          column: null,
        },
      ];
    });
}

export async function assertNoCompilationErrors(
  page: Page,
  strategyCode: string,
  errorFilePath: string,
): Promise<void> {
  const errors = await readCompilationErrorsFromDom(page);
  if (!errors.length) return;

  const lines = strategyCode.split("\n");
  const enriched = errors.map((e) => ({
    ...e,
    snippet: lines
      .slice(Math.max(0, (e.line ?? 1) - 4), (e.line ?? 1) + 2)
      .join("\n"),
  }));

  const payload = {
    timestamp: new Date().toISOString(),
    strategyFile: STRATEGY_FILE,
    errors: enriched,
  };

  await fs.writeFile(
    errorFilePath,
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  log(`Errors written to: ${errorFilePath}`);
  throw new Error(
    `Script has ${errors.length} compilation error(s). See ${path.basename(errorFilePath)}`,
  );
}

export async function setEditorCode(page: Page, code: string): Promise<void> {
  await page.evaluate(
    (text: string) => navigator.clipboard.writeText(text),
    code,
  );
  const editor = page.locator(SELECTORS.monacoEditor).first();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+V" : "Control+V",
  );
}

/**
 * Dismiss the deep-backtesting warning overlay that blocks pointer events.
 *
 * Strategy:
 * 1. Try clicking visible buttons/close elements inside the container
 * 2. If the overlay persists after click, force-remove it from the DOM
 *
 * The overlay often has no proper close button — it's an informational banner
 * that TradingView sometimes places over the strategy dropdown. Removing it
 * from the DOM is safe because it's cosmetic (doesn't affect backtest data).
 */
export async function dismissBacktestWarning(page: Page): Promise<boolean> {
  const selector = '[class*="backtestingWarningContainer"]';
  const container = page.locator(selector);
  if (!(await container.isVisible({ timeout: 1000 }).catch(() => false))) {
    return false;
  }

  // Attempt 1: click the close button (has class "close-button-*" and text "Fechar"/"Close")
  const closeBtn = container.locator('button[class*="close-button"]').first();
  if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeBtn.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Check if overlay is actually gone
    if (!(await container.isVisible({ timeout: 300 }).catch(() => false))) {
      log("Dismissed deep backtesting warning (click).");
      return true;
    }
  }

  // Attempt 2: overlay persists after click — remove from DOM
  const removed = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.remove(); return true; }
    return false;
  }, selector);

  if (removed) {
    log("Dismissed deep backtesting warning (DOM removal).");
    await page.waitForTimeout(300);
    return true;
  }

  return false;
}

/**
 * Dismiss TradingView banners/overlays/popups that may block clicks.
 * NOTE: selectors must be specific — generic [aria-label="Close"] closes the Pine editor.
 */
export async function dismissBanners(page: Page): Promise<number> {
  const dismissSelectors = [
    '[data-name="popup-close"]',
    '[class*="cookie"] button[class*="close"]',
    '[class*="consent"] button[class*="accept"]',
    '[class*="banner"] button[class*="close"]',
    '[class*="toast"] button[class*="close"]',
    '[data-name="floating-toolbar-close"]',
  ];
  let dismissed = 0;
  for (const sel of dismissSelectors) {
    try {
      const els = page.locator(sel);
      const count = await els.count();
      for (let i = 0; i < count; i++) {
        const el = els.nth(i);
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.click({ timeout: 1000 }).catch(() => {});
          dismissed++;
        }
      }
    } catch { /* ignore */ }
  }
  // Also handle the backtesting warning overlay
  if (await dismissBacktestWarning(page)) dismissed++;
  if (dismissed > 0) {
    log(`Closed ${dismissed} banner(s)/overlay(s).`);
    await page.waitForTimeout(500);
  } else {
    log("No banner/overlay detected.");
  }
  return dismissed;
}

async function main(): Promise<void> {
  const runStart = Date.now();
  const strategyPath = path.resolve(process.cwd(), STRATEGY_FILE);
  const authPath = path.resolve(process.cwd(), AUTH_FILE);

  const strategyCode = await fs.readFile(strategyPath, "utf8");
  const saveName = buildSaveName(strategyCode);
  const token = generateToken();
  const codeWithToken = injectToken(strategyCode, token);
  log(`Token for this run: ${token}`);

  const browser: Browser = await chromium.launch({
    headless: HEADLESS,
    args: launchArgs(),
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    storageState: authPath,
    viewport:
      HEADLESS || !FULLSCREEN ? { width: 1720, height: 1000 } : null,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page: Page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  let xlsxPath: string | undefined;
  try {
    await runStep("[1/6] Open chart", async () => {
      await page.goto(TV_CHART_URL, { waitUntil: "domcontentloaded" });
      await setFullscreen(page);
      const editorReady = page.locator(SELECTORS.addScriptToChart);
      const alreadyOpen = await editorReady
        .waitFor({ state: "visible", timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!alreadyOpen) {
        log("Editor not found, opening via Pine button...");
        await page.locator(SELECTORS.pineDialogButton).click();
        await editorReady.waitFor({ state: "visible" });
      }
    });

    await runStep("[1.5/6] Close banners/overlays", async () => {
      await dismissBanners(page);
    });

    await runStep(
      "[2/6] Close previous backtest panel (if present)",
      async () => {
        const backtestPanel = page.locator(SELECTORS.backtestPanel);
        const panelVisible = await backtestPanel
          .waitFor({ state: "visible", timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (!panelVisible) {
          log("Backtest panel not detected, proceeding.");
          return;
        }
        log("Backtest panel detected. Closing via tab...");
        await page.locator(SELECTORS.backtestTab).click();
        await page
          .locator(SELECTORS.backtestPanelHidden)
          .waitFor({ state: "attached", timeout: 5000 });
        log("Backtest panel closed successfully.");
      },
    );

    await runStep("[3/6] Paste .pine into editor", async () => {
      await setEditorCode(page, codeWithToken);
    });

    await retryStep(async () => {
      await runStep("[4/6] Save script", async () => {
        await page.locator(SELECTORS.saveButton).click();
        const modal = page.locator(SELECTORS.renameDialog);
        const modalAppeared = await modal
          .waitFor({ state: "visible", timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        if (modalAppeared) {
          await modal.locator(SELECTORS.renameInput).fill(saveName);
          await modal.locator(SELECTORS.saveBtn).click();
          const confirmDialog = page.locator(SELECTORS.confirmDialog);
          const appeared = await confirmDialog
            .waitFor({ state: "visible", timeout: 4000 })
            .then(() => true)
            .catch(() => false);
          if (appeared) {
            await confirmDialog.locator(SELECTORS.yesBtn).click();
          }
          await modal.waitFor({ state: "hidden" });
        } else {
          const confirmDialog = page.locator(SELECTORS.confirmDialog);
          const confirmAppeared = await confirmDialog
            .waitFor({ state: "visible", timeout: 3000 })
            .then(() => true)
            .catch(() => false);
          if (confirmAppeared) {
            await confirmDialog.locator(SELECTORS.yesBtn).click();
            await confirmDialog.waitFor({ state: "hidden" });
          }
          log(
            "Rename modal did not appear — silent save or already confirmed.",
          );
        }
      });
    }, { maxAttempts: 2, delayMs: 2000, label: "save-script" });

    await retryStep(async () => {
      await runStep("[5/6] Add to chart", async () => {
        const errorFilePath = path.resolve(
          process.cwd(),
          "error-last-run.json",
        );
        await page.locator(SELECTORS.addScriptToChart).click();
        const hasError = await page
          .locator(SELECTORS.compilationErrorWidget)
          .waitFor({ state: "visible", timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        if (hasError) {
          await assertNoCompilationErrors(
            page,
            codeWithToken,
            errorFilePath,
          );
        }
      });
    }, { maxAttempts: 2, delayMs: 2000, label: "add-to-chart" });

    await runStep("[6/6-pre] Clean old results/", async () => {
      const resultsDir = path.resolve(process.cwd(), process.env.RESULTS_DIR || "results");
      try {
        const files = await fs.readdir(resultsDir);
        const stale = files.filter(
          (f) => f.endsWith(".xlsx") || f.endsWith(".csv"),
        );
        for (const f of stale) {
          await fs.unlink(path.join(resultsDir, f));
          log(`Removed: results/${f}`);
        }
        if (stale.length)
          log(
            `${stale.length} old file(s) removed from results/`,
          );
      } catch {
        // results/ may not exist yet
      }
    });

    xlsxPath = await retryStep(async () => {
      return await runStep("[6/6] Export XLSX", async () => {
        const dropdownBtn = page
          .locator(SELECTORS.strategyTitle)
          .first();
        await dropdownBtn.waitFor({ state: "visible" });

        log(
          `Waiting for token "${token}" to appear in strategy title...`,
        );
        await page.waitForFunction(
          (tok: string) => {
            const el = document.querySelector(
              "[data-strategy-title]",
            );
            if (!el) return false;
            return (
              (
                el.getAttribute("data-strategy-title") ?? ""
              ).includes(tok) ||
              (el.textContent ?? "").includes(tok)
            );
          },
          token,
          { timeout: 60000, polling: 500 },
        );
        log(`Token "${token}" confirmed.`);

        await page.waitForTimeout(3000);

        await setDateRange(page, DATE_RANGE);
        await page.waitForTimeout(1000);

        await dismissBacktestWarning(page);

        log("Exporting XLSX...");
        await dropdownBtn.click();

        const downloadItem = await locateWithVariants(
          page,
          "menuitem",
          LOCALE_VARIANTS.downloadXlsx,
          { timeout: 10000 },
        );

        const [download] = await Promise.all([
          page.waitForEvent("download"),
          downloadItem.click(),
        ]);

        const resultsDir = path.resolve(process.cwd(), process.env.RESULTS_DIR || "results");
        await fs.mkdir(resultsDir, { recursive: true });
        const timestamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, "-");
        const destFile = path.join(
          resultsDir,
          `${saveName} [${token}]-${timestamp}.xlsx`,
        );
        await download.saveAs(destFile);
        log(`XLSX saved at: ${destFile}`);
        return destFile;
      });
    }, { maxAttempts: 2, delayMs: 3000, label: "export-xlsx" });
  } catch (error) {
    log(`ERROR: ${(error as Error).message}`);
    const resultsDir = path.resolve(process.cwd(), process.env.RESULTS_DIR || "results");
    const ssPath = await screenshotOnFailure(page, "main", resultsDir);
    if (ssPath) log(`Error screenshot saved at: ${ssPath}`);
    throw error;
  } finally {
    log("Closing browser");
    await browser.close();
  }

  log(`Total time: ${Date.now() - runStart} ms`);
  console.log(`Script saved as: ${saveName}`);
  if (xlsxPath) console.log(`XLSX_RESULT_PATH:${xlsxPath}`);
}

// Only run main() when executed directly, not when imported for tests
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("run-backtest.js");

if (isMain) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
