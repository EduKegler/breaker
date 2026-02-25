#!/usr/bin/env node
/**
 * parse-results.ts
 *
 * Reads the most recent XLSX from results/, extracts TradingView backtest metrics,
 * checks acceptance criteria and prints JSON for breaker-loop.sh to consume.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

import { loadConfig, resolveAssetCriteria } from "../lib/config.js";
import {
  findMetricInSheet,
  debugSheet,
  excelSerialToDate,
} from "../lib/xlsx-utils.js";
import type {
  PineParams,
  XlsxParams,
  TradeAnalysis,
  FilterSimulations,
  WalkForward,
  HourConsistency,
  HourSim,
  DaySim,
  TradeMapEntry,
  HourBucket,
  DayBucket,
  DirectionBucket,
  ExitTypeBucket,
  ParseResultsOutput,
  SessionName,
  SessionStats,
} from "../types/parse-results.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../../playwright/results");
const PINE_FILE =
  process.env.PINE_FILE ||
  path.resolve(
    __dirname,
    "../../assets",
    process.env.ASSET || "BTC",
    "strategy.pine",
  );
const CONFIG_FILE =
  process.env.CONFIG_FILE ||
  path.resolve(__dirname, "../../breaker-config.json");
const DEBUG = process.argv.includes("--debug");

function loadCriteriaFromConfig(): Record<string, number | undefined> {
  try {
    const config = loadConfig(CONFIG_FILE);
    const asset = process.env.ASSET || "BTC";
    const resolved = resolveAssetCriteria(config, asset);
    // Extract only numeric criteria fields (ignore coreParameters, designChecklist, etc.)
    const { coreParameters: _cp, designChecklist: _dc, ...numericCriteria } = resolved;
    return numericCriteria;
  } catch {
    process.stderr.write(
      `WARNING: could not read ${CONFIG_FILE}. Using defaults.\n`,
    );
    return {};
  }
}

const CRITERIA = loadCriteriaFromConfig();
const MIN_TRADES = CRITERIA.minTrades ?? 150;
const MIN_PF = CRITERIA.minPF ?? 1.25;
const MAX_DD = CRITERIA.maxDD ?? 12;
const MIN_WR = CRITERIA.minWR ?? 20;
const MIN_AVG_R = CRITERIA.minAvgR ?? 0.15;
const MIN_TRADES_FOR_FILTER = CRITERIA.minTradesForFilter ?? 6;

const AFTER_S = ((): number | null => {
  const arg = process.argv.find((a) => a.startsWith("--after="));
  if (!arg) return null;
  const parsed = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
})();

const EXPLICIT_FILE = ((): string | null => {
  const arg = process.argv.find((a) => a.startsWith("--file="));
  return arg ? arg.slice("--file=".length) : null;
})();

export function findLatestXlsx(dir: string): string {
  if (!fs.existsSync(dir)) {
    throw new Error(`Results directory not found: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".xlsx"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    throw new Error(`No .xlsx files found in: ${dir}`);
  }
  if (files.length > 1) {
    process.stderr.write(
      `WARNING: ${files.length} .xlsx files found in ${dir} — there should be only 1. Preventive cleanup may have failed.\n`,
    );
    for (const f of files)
      process.stderr.write(
        `  - ${f.name} (mtime: ${new Date(f.mtime).toISOString()})\n`,
      );
  }
  return path.join(dir, files[0].name);
}

export function parseOverviewSheet(sheet: XLSX.WorkSheet): {
  totalPnl: number | null;
  maxDrawdownPct: number | null;
} {
  if (DEBUG) debugSheet(sheet, "Overview/Summary");

  const totalPnl =
    findMetricInSheet(sheet, "lucro líquido", {
      exact: true,
      colOffset: 1,
    }) ??
    findMetricInSheet(sheet, "lucro liquido", {
      exact: true,
      colOffset: 1,
    }) ??
    findMetricInSheet(sheet, "net profit", { exact: true, colOffset: 1 }) ??
    null;

  const maxDrawdownPct =
    findMetricInSheet(
      sheet,
      "máximo drawdown do patrimônio (intrabarra)",
      { exact: true, colOffset: 2 },
    ) ??
    findMetricInSheet(
      sheet,
      "maximo drawdown do patrimonio (intrabarra)",
      { exact: true, colOffset: 2 },
    ) ??
    findMetricInSheet(
      sheet,
      "máximo drawdown do patrimônio (fechamento a fechamento)",
      { exact: true, colOffset: 2 },
    ) ??
    findMetricInSheet(sheet, "max drawdown") ??
    null;

  return { totalPnl, maxDrawdownPct };
}

export function parseRiskAdjustedSheet(sheet: XLSX.WorkSheet): {
  profitFactor: number | null;
} {
  if (DEBUG) debugSheet(sheet, "Risk-adjusted performance");

  const profitFactor =
    findMetricInSheet(sheet, "fator de lucro", {
      exact: true,
      colOffset: 1,
    }) ??
    findMetricInSheet(sheet, "profit factor", {
      exact: true,
      colOffset: 1,
    }) ??
    null;

  return { profitFactor };
}

export function parseTradesAnalysisSheet(sheet: XLSX.WorkSheet): {
  numTrades: number | null;
  winRate: number | null;
} {
  if (DEBUG) debugSheet(sheet, "Trades");

  const numTrades =
    findMetricInSheet(sheet, "total de negociações", {
      exact: true,
      skipZero: true,
    }) ??
    findMetricInSheet(sheet, "total de negociacoes", {
      exact: true,
      skipZero: true,
    }) ??
    findMetricInSheet(sheet, "total de operações", {
      exact: true,
      skipZero: true,
    }) ??
    findMetricInSheet(sheet, "total closed trades", {
      exact: true,
      skipZero: true,
    }) ??
    findMetricInSheet(sheet, "total trades", {
      exact: true,
      skipZero: true,
    }) ??
    null;

  const winRate =
    findMetricInSheet(sheet, "porcentagem rentável", {
      exact: true,
      colOffset: 2,
    }) ??
    findMetricInSheet(sheet, "porcentagem rentavel", {
      exact: true,
      colOffset: 2,
    }) ??
    findMetricInSheet(sheet, "percent profitable", {
      exact: true,
      colOffset: 2,
    }) ??
    findMetricInSheet(sheet, "% rentáveis") ??
    findMetricInSheet(sheet, "win rate") ??
    null;

  return { numTrades, winRate };
}

export function countTradesInListSheet(sheet: XLSX.WorkSheet): number {
  if (DEBUG) debugSheet(sheet, "Trade list");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  });
  return rows.filter(
    (r) => typeof r[1] === "string" && (r[1].toLowerCase().startsWith("sa") || r[1].toLowerCase().startsWith("ex")),
  ).length;
}

/**
 * Walk-forward split: divides trades into train (first SPLIT_RATIO%) and test (rest).
 */
export function computeWalkForward(
  tradeMap: Record<string, TradeMapEntry>,
  splitRatio = 0.7,
): WalkForward | null {
  const MIN_TRAIN_TRADES = 3;
  const MIN_TEST_TRADES = 2;

  const completed = Object.values(tradeMap)
    .filter(
      (t) =>
        typeof t.entrySerial === "number" &&
        typeof t.exitSerial === "number",
    )
    .sort((a, b) => a.entrySerial! - b.entrySerial!);

  if (completed.length < 10) return null;

  const splitIdx = Math.floor(completed.length * splitRatio);
  const train = completed.slice(0, splitIdx);
  const test = completed.slice(splitIdx);

  const buildByHour = (
    trades: TradeMapEntry[],
  ): Record<number, HourBucket> => {
    const map: Record<number, HourBucket> = {};
    for (const t of trades) {
      const h = excelSerialToDate(t.entrySerial!)?.getUTCHours();
      if (h == null) continue;
      if (!map[h]) map[h] = { count: 0, pnl: 0 };
      map[h].count++;
      map[h].pnl += t.pnl || 0;
    }
    return map;
  };

  const trainH = buildByHour(train);
  const testH = buildByHour(test);

  const hourConsistency: HourConsistency[] = Object.keys(trainH)
    .filter((h) => trainH[+h].count >= MIN_TRAIN_TRADES)
    .map((h) => {
      const tr = trainH[+h];
      const ts = testH[+h] ?? { count: 0, pnl: 0 };
      const consistent =
        ts.count >= MIN_TEST_TRADES
          ? tr.pnl < 0 === ts.pnl < 0
          : null;
      return {
        hour: +h,
        trainPnl: +tr.pnl.toFixed(2),
        trainCount: tr.count,
        testPnl: +ts.pnl.toFixed(2),
        testCount: ts.count,
        consistent,
      };
    })
    .sort((a, b) => a.hour - b.hour);

  // Compute PF for train and test sets
  const computeSetPF = (trades: TradeMapEntry[]): number | null => {
    let grossWin = 0;
    let grossLoss = 0;
    for (const t of trades) {
      const pnl = t.pnl ?? 0;
      if (pnl > 0) grossWin += pnl;
      else grossLoss += Math.abs(pnl);
    }
    if (grossWin === 0 && grossLoss === 0) return null;
    if (grossLoss === 0) return 99.99;
    return +Math.min(grossWin / grossLoss, 99.99).toFixed(2);
  };

  const trainPF = computeSetPF(train);
  const testPF = computeSetPF(test);
  const pfRatio = trainPF !== null && trainPF > 0 && testPF !== null
    ? +(testPF / trainPF).toFixed(2)
    : null;
  const overfitFlag = pfRatio !== null && pfRatio < 0.6;

  return {
    trainTrades: train.length,
    testTrades: test.length,
    splitRatio,
    hourConsistency,
    trainPF,
    testPF,
    pfRatio,
    overfitFlag,
  };
}

/**
 * Computes filter impact simulations from historical trades.
 */
export function computeFilterSimulations(
  totalTrades: number,
  byHour: Record<number, HourBucket>,
  byDow: Record<string, DayBucket>,
  byExitType: Record<string, ExitTypeBucket>,
  totalPnl: number,
): FilterSimulations {
  const r2 = (n: number): number => +n.toFixed(2);

  const hourSims: HourSim[] = Object.entries(byHour)
    .filter(([, v]) => v.count >= MIN_TRADES_FOR_FILTER)
    .map(([h, v]) => ({
      hour: +h,
      tradesRemoved: v.count,
      pnlDelta: r2(-v.pnl),
      pnlAfter: r2(totalPnl - v.pnl),
      tradesAfter: totalTrades - v.count,
    }))
    .sort((a, b) => b.pnlDelta - a.pnlDelta);

  const daySims: DaySim[] = Object.entries(byDow)
    .filter(([, v]) => v.count >= MIN_TRADES_FOR_FILTER)
    .map(([day, v]) => ({
      day,
      tradesRemoved: v.count,
      pnlDelta: r2(-v.pnl),
      pnlAfter: r2(totalPnl - v.pnl),
      tradesAfter: totalTrades - v.count,
    }))
    .sort((a, b) => b.pnlDelta - a.pnlDelta);

  const slEntries = Object.entries(byExitType).filter(([sig]) =>
    sig.toUpperCase().includes("SL"),
  );
  const slCount = slEntries.reduce((s, [, v]) => s + v.count, 0);
  const slPnl = slEntries.reduce((s, [, v]) => s + v.pnl, 0);

  return {
    totalPnl: r2(totalPnl),
    totalTrades,
    byHour: hourSims,
    byDay: daySims,
    removeAllSL: {
      tradesRemoved: slCount,
      pnlDelta: r2(-slPnl),
      pnlAfter: r2(totalPnl - slPnl),
      tradesAfter: totalTrades - slCount,
    },
  };
}

/**
 * Counts unique Pine Script input parameters (active, non-commented assignments).
 * Excludes var/varip state variables and strategy()/indicator() declaration arguments.
 */
export function countPineInputs(content: string): number {
  const names = new Set<string>();
  const paramRe = /^\s*(\w+)\s*=\s*(?:input\.(?:float|int|bool)\()?\s*(?:[0-9.]+|true|false)\b/;
  let inDeclaration = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) continue;
    // Skip multi-line strategy()/indicator() declarations
    if (/^(?:strategy|indicator)\s*\(/.test(trimmed)) {
      if (!trimmed.includes(")")) inDeclaration = true;
      continue;
    }
    if (inDeclaration) {
      if (trimmed.includes(")")) inDeclaration = false;
      continue;
    }
    if (trimmed.startsWith("var ") || trimmed.startsWith("varip ")) continue;
    const m = line.match(paramRe);
    if (m) names.add(m[1]);
  }
  return names.size;
}

/**
 * Maps a UTC hour to a trading session.
 * Asia: 23-08 UTC, London: 08-13, NY: 13-20, Off-peak: 20-23
 */
export function getSessionForHour(hour: number): SessionName {
  if (hour >= 23 || hour < 8) return "Asia";
  if (hour >= 8 && hour < 13) return "London";
  if (hour >= 13 && hour < 20) return "NY";
  return "Off-peak";
}

/**
 * Groups trades by entry session and computes stats per session.
 */
export function computeSessionBreakdown(
  tradeMap: Record<string, TradeMapEntry>,
): Record<SessionName, SessionStats> {
  const buckets: Record<SessionName, { count: number; pnl: number; wins: number; grossWin: number; grossLoss: number }> = {
    Asia: { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 },
    London: { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 },
    NY: { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 },
    "Off-peak": { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 },
  };

  for (const t of Object.values(tradeMap)) {
    if (typeof t.entrySerial !== "number" || typeof t.exitSerial !== "number") continue;
    const entryDate = excelSerialToDate(t.entrySerial);
    if (!entryDate) continue;
    const session = getSessionForHour(entryDate.getUTCHours());
    const pnl = t.pnl ?? 0;
    buckets[session].count++;
    buckets[session].pnl += pnl;
    if (pnl > 0) {
      buckets[session].wins++;
      buckets[session].grossWin += pnl;
    } else {
      buckets[session].grossLoss += Math.abs(pnl);
    }
  }

  const r2 = (n: number): number => +n.toFixed(2);
  const result = {} as Record<SessionName, SessionStats>;
  for (const [session, b] of Object.entries(buckets) as [SessionName, typeof buckets[SessionName]][]) {
    const winRate = b.count > 0 ? +((b.wins / b.count) * 100).toFixed(1) : 0;
    const pf = b.grossLoss > 0 ? Math.min(+(b.grossWin / b.grossLoss).toFixed(2), 99.99) : (b.grossWin > 0 ? 99.99 : 0);
    result[session] = { count: b.count, pnl: r2(b.pnl), winRate, profitFactor: pf };
  }
  return result;
}

/**
 * Pre-processes the trade list sheet into structured statistics.
 */
export function analyzeTradeListSheet(sheet: XLSX.WorkSheet): TradeAnalysis | null {
  if (DEBUG) debugSheet(sheet, "Trade list — analysis");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  });

  const exitRows = rows.filter(
    (r) => typeof r[1] === "string" && (r[1].toLowerCase().startsWith("sa") || r[1].toLowerCase().startsWith("ex")),
  );

  if (!exitRows.length) return null;

  const byDirection: Record<string, DirectionBucket> = {};
  const byDow: Record<string, DayBucket> = {};
  const byExitType: Record<string, ExitTypeBucket> = {};
  const pnls: number[] = [];

  const tradeMap: Record<string, TradeMapEntry> = {};
  for (const r of rows) {
    if (typeof r[0] !== "number") continue;
    const tradeNum = String(r[0]);
    const tipo = String(r[1] ?? "").toLowerCase();
    if (!tradeMap[tradeNum]) tradeMap[tradeNum] = {};
    if (tipo.includes("entrada") || tipo.includes("entry")) {
      tradeMap[tradeNum].entrySerial = r[2] as number;
    } else if (tipo.startsWith("sa") || tipo.startsWith("ex")) {
      tradeMap[tradeNum].exitSerial = r[2] as number;
      tradeMap[tradeNum].pnl =
        typeof r[7] === "number"
          ? r[7]
          : parseFloat(String(r[7]).replace(/[^0-9.\-]/g, "")) || 0;
    }
  }

  // byEntryHour: group by UTC hour of ENTRY (consistent with Pine filter)
  const byEntryHour: Record<number, HourBucket> = {};
  for (const t of Object.values(tradeMap)) {
    if (typeof t.entrySerial !== "number") continue;
    if (typeof t.exitSerial !== "number") continue;
    const entryDate = excelSerialToDate(t.entrySerial);
    if (!entryDate) continue;
    const hour = entryDate.getUTCHours();
    if (!byEntryHour[hour]) byEntryHour[hour] = { count: 0, pnl: 0 };
    byEntryHour[hour].count++;
    byEntryHour[hour].pnl += t.pnl || 0;
  }

  // Duration in 15m bars
  const winnerBars: number[] = [];
  const loserBars: number[] = [];
  for (const t of Object.values(tradeMap)) {
    if (
      typeof t.entrySerial !== "number" ||
      typeof t.exitSerial !== "number"
    )
      continue;
    const bars = Math.round((t.exitSerial - t.entrySerial) * 96);
    if (bars <= 0) continue;
    if ((t.pnl ?? 0) > 0) winnerBars.push(bars);
    else loserBars.push(bars);
  }
  const avgBars = (arr: number[]): number | null =>
    arr.length
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
      : null;

  for (const r of exitRows) {
    const typeStr = String(r[1] ?? "").toLowerCase();
    const direction = typeStr.includes("long")
      ? "long"
      : typeStr.includes("short")
        ? "short"
        : "unknown";
    const pnl =
      typeof r[7] === "number"
        ? r[7]
        : parseFloat(String(r[7]).replace(/[^0-9.\-]/g, "")) || 0;
    const signal = String(r[3] ?? "unknown").trim();
    const date = excelSerialToDate(r[2] as number);

    // By direction
    if (!byDirection[direction])
      byDirection[direction] = { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 };
    byDirection[direction].count++;
    byDirection[direction].pnl += pnl;
    if (pnl > 0) {
      byDirection[direction].wins++;
      byDirection[direction].grossWin += pnl;
    } else {
      byDirection[direction].grossLoss += Math.abs(pnl);
    }

    // By exit type
    if (!byExitType[signal])
      byExitType[signal] = { count: 0, pnl: 0, wins: 0 };
    byExitType[signal].count++;
    byExitType[signal].pnl += pnl;
    if (pnl > 0) byExitType[signal].wins++;

    // By DOW
    if (date) {
      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
        date.getUTCDay()
      ];
      if (!byDow[dow]) byDow[dow] = { count: 0, pnl: 0 };
      byDow[dow].count++;
      byDow[dow].pnl += pnl;
    }

    pnls.push(pnl);
  }

  const totalPnlSum = pnls.reduce((a, b) => a + b, 0);
  const filterSimulations = computeFilterSimulations(
    exitRows.length,
    byEntryHour,
    byDow,
    byExitType,
    totalPnlSum,
  );

  const walkForward = computeWalkForward(tradeMap);
  const bySession = computeSessionBreakdown(tradeMap);

  const sorted = [...pnls].sort((a, b) => a - b);
  const worstPnls = sorted.slice(0, 3).map((v) => +v.toFixed(2));
  const bestPnls = sorted
    .slice(-3)
    .reverse()
    .map((v) => +v.toFixed(2));

  const hourSummary = Object.entries(byEntryHour)
    .filter(([, v]) => v.count >= 2)
    .map(([h, v]) => ({ hour: +h, count: v.count, pnl: +v.pnl.toFixed(2) }))
    .sort((a, b) => b.pnl - a.pnl);

  const directionSummary: Record<
    string,
    { count: number; pnl: number; winRate: number; profitFactor: number; avgTrade: number }
  > = {};
  for (const [dir, v] of Object.entries(byDirection)) {
    const pf = v.grossLoss > 0
      ? +Math.min(v.grossWin / v.grossLoss, 99.99).toFixed(2)
      : (v.grossWin > 0 ? 999 : 0);
    directionSummary[dir] = {
      count: v.count,
      pnl: +v.pnl.toFixed(2),
      winRate: v.count > 0 ? +((v.wins / v.count) * 100).toFixed(1) : 0,
      profitFactor: pf,
      avgTrade: v.count > 0 ? +(v.pnl / v.count).toFixed(2) : 0,
    };
  }

  const exitTypeSummary = Object.entries(byExitType)
    .map(([sig, v]) => ({
      signal: sig,
      count: v.count,
      pnl: +v.pnl.toFixed(2),
      winRate: v.count > 0 ? +((v.wins / v.count) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const dowSummary: Record<string, { count: number; pnl: number }> = {};
  for (const [dow, v] of Object.entries(byDow)) {
    dowSummary[dow] = { count: v.count, pnl: +v.pnl.toFixed(2) };
  }

  return {
    totalExitRows: exitRows.length,
    byDirection: directionSummary,
    byExitType: exitTypeSummary,
    avgBarsWinners: avgBars(winnerBars),
    avgBarsLosers: avgBars(loserBars),
    byDayOfWeek: dowSummary,
    bestHoursUTC: hourSummary.slice(0, 4),
    worstHoursUTC: hourSummary.slice(-4).reverse(),
    best3TradesPnl: bestPnls,
    worst3TradesPnl: worstPnls,
    filterSimulations,
    walkForward,
    bySession,
  };
}

/**
 * Extracts key params from the .pine file via regex on inputs.
 */
export function parsePineParams(pineFilePath: string): PineParams | null {
  let content: string;
  try {
    content = fs.readFileSync(pineFilePath, "utf8");
  } catch (e) {
    process.stderr.write(
      `WARNING: could not read ${pineFilePath} for stale detection: ${(e as Error).message}\n`,
    );
    return null;
  }

  return parsePineParamsFromContent(content);
}

/**
 * Pure function: extracts Pine params from source content string.
 */
export function parsePineParamsFromContent(content: string): PineParams {
  // Strip comment-only lines to avoid matching values inside comments
  const activeContent = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  const numericPatterns: Record<string, RegExp> = {
    // Common
    riskTradeUsd: /riskTradeUsd\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    cooldownBars: /cooldownBars\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    // Legacy Donchian
    atrMult: /atrMult\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    maxBarsToTp1: /maxBarsToTp1\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    rr1: /rr1\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    rr2: /rr2\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    // Session ORB + Squeeze
    slAtrMult: /slAtrMult\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    rrTarget: /rrTarget\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    maxBarsInTrade: /maxBarsInTrade\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    adxMin: /adxMin\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    bbLen: /bbLen\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    bbMult: /bbMult\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    kcLen: /kcLen\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    kcMult: /kcMult\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    emaLen: /emaLen\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    adxLen: /adxLen\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    atrLen: /atrLen\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    minStopPct: /minStopPct\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    maxNotionalUsd: /maxNotionalUsd\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    maxEntriesPerDay: /maxEntriesPerDay\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
    dailyLossUsd: /dailyLossUsd\s*=\s*(?:input\.(?:float|int)\()?([0-9.]+)/,
  };

  const boolPatterns: Record<string, RegExp> = {
    shortOnly: /shortOnly\s*=\s*(?:input\.bool\()?(true|false)/,
    useDailyTrend: /useDailyTrend\s*=\s*(?:input\.bool\()?(true|false)/,
    useVwap: /useVwap\s*=\s*(?:input\.bool\()?(true|false)/,
    useAtrGate: /useAtrGate\s*=\s*(?:input\.bool\()?(true|false)/,
    useVolume: /useVolume\s*=\s*(?:input\.bool\()?(true|false)/,
    useRsi: /useRsi\s*=\s*(?:input\.bool\()?(true|false)/,
    useSuper: /useSuper\s*=\s*(?:input\.bool\()?(true|false)/,
    useSessionFilter: /useSessionFilter\s*=\s*(?:input\.bool\()?(true|false)/,
    useDayFilter: /useDayFilter\s*=\s*(?:input\.bool\()?(true|false)/,
    useBreakEvenAfterTp1:
      /useBreakEvenAfterTp1\s*=\s*(?:input\.bool\()?(true|false)/,
  };

  const params: Record<string, number> = {};
  for (const [key, re] of Object.entries(numericPatterns)) {
    const m = activeContent.match(re);
    if (m) params[key] = parseFloat(m[1].trim());
  }

  const filters: Record<string, boolean> = {};
  for (const [key, re] of Object.entries(boolPatterns)) {
    const m = activeContent.match(re);
    if (m) filters[key] = m[1] === "true";
  }

  const blockedHours: number[] = [];
  const hourMatches = activeContent.match(/(?:badHour|utcHour)\s*==\s*(\d+)/g);
  if (hourMatches) {
    for (const m of hourMatches) {
      const numMatch = m.match(/(\d+)$/);
      if (!numMatch) continue;
      const h = parseInt(numMatch[1], 10);
      if (!blockedHours.includes(h)) blockedHours.push(h);
    }
    blockedHours.sort((a, b) => a - b);
  }

  const blockedDays: string[] = [];
  const dayMatches = activeContent.match(/badDay\s*==\s*dayofweek\.(\w+)/g);
  if (dayMatches) {
    for (const m of dayMatches) {
      const dayMatch = m.match(/dayofweek\.(\w+)/);
      if (!dayMatch) continue;
      const day = dayMatch[1];
      const dayShort: Record<string, string> = {
        sunday: "Sun",
        monday: "Mon",
        tuesday: "Tue",
        wednesday: "Wed",
        thursday: "Thu",
        friday: "Fri",
        saturday: "Sat",
      };
      const short = dayShort[day] ?? day;
      if (!blockedDays.includes(short)) blockedDays.push(short);
    }
  }

  return { ...params, filters, blockedHours, blockedDays } as PineParams;
}

/**
 * Extracts key params from the XLSX Properties sheet.
 */
export function parsePropertiesSheet(sheet: XLSX.WorkSheet): XlsxParams | null {
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  });

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row[0] && row[1] !== "")
      map[String(row[0])] = String(row[1]);
  }

  return {
    riskTradeUsd: parseFloat(map["Risk per Trade (USD)"] ?? "NaN"),
    atrMult: parseFloat(map["ATR Mult"] ?? "NaN"),
    maxBarsToTp1: parseFloat(
      map["Time Stop (bars if TP1 not hit, 0=off)"] ?? "NaN",
    ),
    rr1: parseFloat(map["TP1 R"] ?? "NaN"),
    rr2: parseFloat(map["TP2 R"] ?? "NaN"),
    cooldownBars: parseFloat(map["Cooldown Bars"] ?? "NaN"),
  };
}

/**
 * Compares .pine params with XLSX Propriedades params.
 * Returns true if any key param diverges (XLSX is stale).
 */
export function detectStaleness(
  pineParams: PineParams | null,
  xlsxParams: XlsxParams | null,
): boolean {
  if (!pineParams || !xlsxParams) return false;
  const TOL = 0.001;
  for (const key of Object.keys(pineParams) as (keyof PineParams)[]) {
    if (key === "filters" || key === "blockedHours" || key === "blockedDays")
      continue;
    const pv = pineParams[key] as number | undefined;
    const xv = (xlsxParams as unknown as Record<string, number>)[key];
    // Skip comparison when either value is missing (e.g. plain constants → no xlsx export)
    const pvOk = Number.isFinite(pv);
    const xvOk = Number.isFinite(xv);
    if (!pvOk || !xvOk) continue;
    if (Math.abs(pv! - xv) > TOL) return true;
  }
  return false;
}

function main(): void {
  const filepath = EXPLICIT_FILE
    ? path.resolve(EXPLICIT_FILE)
    : findLatestXlsx(RESULTS_DIR);

  if (AFTER_S !== null) {
    const xlsxMtimeS = Math.floor(fs.statSync(filepath).mtimeMs / 1000);
    if (xlsxMtimeS < AFTER_S) {
      throw new Error(
        `XLSX was not updated this iteration — backtest may have failed before exporting.\n` +
          `  File:              ${path.basename(filepath)}\n` +
          `  Modified at:       ${new Date(xlsxMtimeS * 1000).toISOString()}\n` +
          `  Backtest start:    ${new Date(AFTER_S * 1000).toISOString()}`,
      );
    }
  }

  if (DEBUG) {
    process.stderr.write(`File: ${filepath}\n`);
  }

  const workbook = XLSX.readFile(filepath);
  const sheetNames = workbook.SheetNames;

  if (DEBUG) {
    process.stderr.write(`Sheets: ${JSON.stringify(sheetNames)}\n`);
  }

  const overviewSheet = workbook.Sheets[sheetNames[0]];
  const analysisSheet = sheetNames[1]
    ? workbook.Sheets[sheetNames[1]]
    : null;
  const riskAdjSheet = sheetNames[2]
    ? workbook.Sheets[sheetNames[2]]
    : null;
  const listSheet = sheetNames[3]
    ? workbook.Sheets[sheetNames[3]]
    : null;
  const propsSheet = sheetNames[4]
    ? workbook.Sheets[sheetNames[4]]
    : null;

  const pineParams = parsePineParams(PINE_FILE);
  const xlsxParams = propsSheet ? parsePropertiesSheet(propsSheet) : null;
  const xlsxStale = detectStaleness(pineParams, xlsxParams);

  if (xlsxStale && DEBUG) {
    process.stderr.write(
      `STALE — Pine params: ${JSON.stringify(pineParams)}\n`,
    );
    process.stderr.write(
      `        XLSX params: ${JSON.stringify(xlsxParams)}\n`,
    );
  }

  const { totalPnl } = parseOverviewSheet(overviewSheet);
  let { maxDrawdownPct } = parseOverviewSheet(overviewSheet);

  let numTrades: number | null = null;
  let winRate: number | null = null;

  if (analysisSheet) {
    const analysis = parseTradesAnalysisSheet(analysisSheet);
    numTrades = analysis.numTrades;
    winRate = analysis.winRate;
  }

  let profitFactor: number | null = null;
  if (riskAdjSheet) {
    ({ profitFactor } = parseRiskAdjustedSheet(riskAdjSheet));
  }

  let tradeAnalysis: TradeAnalysis | null = null;
  if (listSheet) {
    const count = countTradesInListSheet(listSheet);
    if ((numTrades === null || numTrades === 0) && count > 0)
      numTrades = count;
    tradeAnalysis = analyzeTradeListSheet(listSheet);
  }

  // Normalize percentages
  if (maxDrawdownPct !== null && Math.abs(maxDrawdownPct) > 0 && Math.abs(maxDrawdownPct) < 1) {
    maxDrawdownPct = maxDrawdownPct * 100;
  }
  if (winRate !== null && winRate > 0 && winRate < 1) {
    winRate = winRate * 100;
  }

  const riskPerTrade = pineParams?.riskTradeUsd ?? 10;
  const avgR =
    totalPnl !== null && numTrades !== null && numTrades > 0 && riskPerTrade > 0
      ? +(totalPnl / (numTrades * riskPerTrade)).toFixed(3)
      : null;

  const pnlPositive = totalPnl !== null && totalPnl > 0;
  const tradesOk = numTrades !== null && numTrades >= MIN_TRADES;
  const pfOk = profitFactor !== null && profitFactor > MIN_PF;
  const ddOk = maxDrawdownPct !== null && maxDrawdownPct < MAX_DD;
  const wrOk = MIN_WR <= 0 || (winRate !== null && winRate >= MIN_WR);
  const avgROk = MIN_AVG_R <= 0 || (avgR !== null && avgR >= MIN_AVG_R);
  const passed = pnlPositive && tradesOk && pfOk && ddOk && wrOk && avgROk;

  const result: ParseResultsOutput = {
    passed,
    xlsxStale,
    filepath: path.relative(process.cwd(), filepath),
    thresholds: {
      minTrades: MIN_TRADES,
      minPF: MIN_PF,
      maxDD: MAX_DD,
      minWR: MIN_WR,
      minAvgR: MIN_AVG_R,
    },
    metrics: {
      totalPnl: totalPnl ?? null,
      numTrades: numTrades ?? null,
      profitFactor: profitFactor ?? null,
      maxDrawdownPct: maxDrawdownPct ?? null,
      winRate: winRate ?? null,
      avgR: avgR,
    },
    criteria: {
      pnlPositive,
      tradesOk,
      pfOk,
      ddOk,
      wrOk,
      avgROk,
    },
    pineParams: pineParams ?? null,
    xlsxParams: xlsxParams ?? null,
    tradeAnalysis: tradeAnalysis ?? null,
  };

  console.log(JSON.stringify(result, null, 2));
}

// Only run main() when executed directly, not when imported for tests
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("parse-results.js");

if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
