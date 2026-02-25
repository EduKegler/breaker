#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { chromium } from "playwright";
import type { Page } from "playwright";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "../../playwright");
const AUTH_FILE = process.env.AUTH_FILE || path.join(RUNNER_DIR, ".auth/tradingview.json");
const HEADLESS =
  String(process.env.HEADLESS || "false").toLowerCase() === "true";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);
const FULLSCREEN =
  String(process.env.FULLSCREEN || "true").toLowerCase() === "true";

function launchArgs(): string[] {
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

async function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}

async function ensureDirFor(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: launchArgs(),
  });
  const context = await browser.newContext({
    viewport:
      HEADLESS || !FULLSCREEN ? { width: 1440, height: 900 } : null,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  try {
    await page.goto("https://www.tradingview.com/chart/", {
      waitUntil: "domcontentloaded",
    });
    await setFullscreen(page);
    console.log(
      "Log into your TradingView account in this window.",
    );
    console.log(
      "Once you're logged in and see a chart, return to the terminal.",
    );
    await waitForEnter(
      "Press ENTER to save the session...",
    );

    await ensureDirFor(AUTH_FILE);
    await context.storageState({ path: AUTH_FILE });
    console.log(`Session saved at: ${AUTH_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Login failed:", error);
  process.exit(1);
});
