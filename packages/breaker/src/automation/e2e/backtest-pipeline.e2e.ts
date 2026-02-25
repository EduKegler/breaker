/**
 * E2E smoke test for the TradingView backtest pipeline.
 *
 * Validates: chart open → Pine paste/compile → token detect/date range → XLSX export+parse
 *
 * Requires valid auth at .auth/tradingview.json. Skips gracefully if auth is missing/expired.
 * Run: pnpm test:e2e
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Page, Browser, BrowserContext } from "playwright";
import XLSX from "xlsx";

import { SELECTORS, LOCALE_VARIANTS, locateWithVariants, waitForToastVariants } from "../selectors.js";
import { setEditorCode, dismissBanners, dismissBacktestWarning, injectToken, generateToken, setDateRange } from "../run-backtest.js";
import { retryStep, screenshotOnFailure } from "../retry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, "../../..");
const AUTH_FILE = path.join(ROOT, ".auth/tradingview.json");
const SMOKE_PINE = path.join(import.meta.dirname, "smoke-strategy.pine");
const RESULTS_DIR = path.join(ROOT, "playwright/results/e2e-smoke");
const TV_CHART_URL = "https://br.tradingview.com/chart/ovLwxUsu/";

// ---------------------------------------------------------------------------
// Auth pre-check
// ---------------------------------------------------------------------------
function checkAuth(): { valid: boolean; reason: string } {
  if (!fs.existsSync(AUTH_FILE)) {
    return { valid: false, reason: `Auth file not found: ${AUTH_FILE}. Run: pnpm login` };
  }

  const stat = fs.statSync(AUTH_FILE);
  const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  if (ageDays > 30) {
    return { valid: false, reason: `Auth file is ${Math.round(ageDays)} days old (max 30). Run: pnpm login` };
  }

  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    const cookies: Array<{ expires?: number }> = data.cookies ?? [];
    if (!cookies.length) {
      return { valid: false, reason: "Auth file has no cookies. Run: pnpm login" };
    }
    const now = Date.now() / 1000;
    const valid = cookies.filter((c) => (c.expires ?? 0) > now).length;
    const ratio = valid / cookies.length;
    if (ratio < 0.5) {
      return { valid: false, reason: `Only ${Math.round(ratio * 100)}% cookies still valid. Run: pnpm login` };
    }
  } catch {
    return { valid: false, reason: "Could not parse auth file. Run: pnpm login" };
  }

  return { valid: true, reason: "OK" };
}

const auth = checkAuth();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe.skipIf(!auth.valid)("E2E: TradingView backtest pipeline", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let token: string;
  let codeWithToken: string;

  if (!auth.valid) {
    console.warn(`[e2e] SKIPPED — ${auth.reason}`);
  }

  beforeAll(async () => {
    await fsp.mkdir(RESULTS_DIR, { recursive: true });

    const pineCode = await fsp.readFile(SMOKE_PINE, "utf8");
    token = generateToken();
    codeWithToken = injectToken(pineCode, token);

    browser = await chromium.launch({ headless: true, args: ["--start-maximized"] });
    context = await browser.newContext({
      acceptDownloads: true,
      storageState: AUTH_FILE,
      viewport: null,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    page.setDefaultTimeout(60_000);
  });

  afterAll(async () => {
    await browser?.close();
  });

  afterEach(async (ctx) => {
    if (ctx.task.result?.state === "fail") {
      const ss = await screenshotOnFailure(page, ctx.task.name.slice(0, 30), RESULTS_DIR);
      if (ss) console.log(`[e2e] Screenshot saved: ${ss}`);
    }
  });

  // -------------------------------------------------------------------------
  // 1. Open chart + detect editor
  // -------------------------------------------------------------------------
  it("opens chart and detects Pine editor", async () => {
    await page.goto(TV_CHART_URL, { waitUntil: "domcontentloaded" });

    // Should NOT redirect to login
    expect(page.url()).not.toContain("/accounts/signin");

    const editorReady = page.locator(SELECTORS.addScriptToChart);
    const alreadyOpen = await editorReady
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!alreadyOpen) {
      await page.locator(SELECTORS.pineDialogButton).click();
      await editorReady.waitFor({ state: "visible", timeout: 20_000 });
    }

    expect(await editorReady.isVisible()).toBe(true);

    // Dismiss any banners
    await dismissBanners(page);
  });

  // -------------------------------------------------------------------------
  // 2. Paste Pine, save, compile
  // -------------------------------------------------------------------------
  it("pastes Pine code, saves, and compiles without errors", async () => {
    await setEditorCode(page, codeWithToken);

    // Save
    await retryStep(async () => {
      await page.locator(SELECTORS.saveButton).click();

      const modal = page.locator(SELECTORS.renameDialog);
      const modalAppeared = await modal
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false);

      if (modalAppeared) {
        await modal.locator(SELECTORS.renameInput).fill(`E2E Smoke [${token}]`);
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
      }
    }, { maxAttempts: 2, delayMs: 2000, label: "e2e-save" });

    // Add to chart
    await page.locator(SELECTORS.addScriptToChart).click();

    // Check no compilation errors
    const hasError = await page
      .locator(SELECTORS.compilationErrorWidget)
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    expect(hasError).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Wait for token in strategy title + set date range
  // -------------------------------------------------------------------------
  it("detects integrity token and sets date range", async () => {
    const dropdownBtn = page.locator(SELECTORS.strategyTitle).first();
    await dropdownBtn.waitFor({ state: "visible", timeout: 20_000 });

    // Wait for token
    await page.waitForFunction(
      (tok: string) => {
        const el = document.querySelector("[data-strategy-title]");
        if (!el) return false;
        return (
          (el.getAttribute("data-strategy-title") ?? "").includes(tok) ||
          (el.textContent ?? "").includes(tok)
        );
      },
      token,
      { timeout: 60_000, polling: 500 },
    );

    // Set custom 6-month date range via setDateRange()
    await page.waitForTimeout(3000);

    // Compute a 6-month window ending today
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const customRange = `custom:${fmt(start)}:${fmt(end)}`;

    await setDateRange(page, customRange);

    await page.waitForTimeout(1000);
  });

  // -------------------------------------------------------------------------
  // 4. Export XLSX + parse metrics
  // -------------------------------------------------------------------------
  it("exports XLSX and parses valid metrics", async () => {
    await dismissBanners(page);

    const dropdownBtn = page.locator(SELECTORS.strategyTitle).first();

    await retryStep(async () => {
      // Dismiss backtesting warning on each retry — it may reappear or
      // may only become visible after the date range recompilation settles
      await dismissBacktestWarning(page);
      await dropdownBtn.click();

      const downloadItem = await locateWithVariants(
        page,
        "menuitem",
        LOCALE_VARIANTS.downloadXlsx,
        { timeout: 10_000 },
      );

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        downloadItem.click(),
      ]);

      const destFile = path.join(RESULTS_DIR, `e2e-smoke-${token}.xlsx`);
      await download.saveAs(destFile);

      // Validate XLSX
      expect(fs.existsSync(destFile)).toBe(true);

      const workbook = XLSX.readFile(destFile);
      const sheetNames = workbook.SheetNames;

      // TradingView exports at least 4 sheets: Overview, Trades Analysis, Risk-adjusted, Trade List
      expect(sheetNames.length).toBeGreaterThanOrEqual(4);

      // Parse overview sheet for PnL
      const overviewSheet = workbook.Sheets[sheetNames[0]];
      expect(overviewSheet).toBeDefined();

      // Parse trades analysis for numTrades
      const tradesSheet = workbook.Sheets[sheetNames[1]];
      expect(tradesSheet).toBeDefined();

      // Verify the XLSX contains actual data (not empty)
      const overviewRows = XLSX.utils.sheet_to_json(overviewSheet, { header: 1 });
      expect(overviewRows.length).toBeGreaterThan(1);

      const tradesRows = XLSX.utils.sheet_to_json(tradesSheet, { header: 1 });
      expect(tradesRows.length).toBeGreaterThan(1);
    }, { maxAttempts: 2, delayMs: 3000, label: "e2e-export" });
  });
});
