import fs from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { CandleCache } from "./data/candle-cache.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "./engine/engine.js";
import { computeMetrics } from "./analysis/metrics-calculator.js";
import { analyzeTradeList } from "./analysis/trade-analysis.js";
import { computeMinWarmupBars } from "./engine/compute-min-warmup-bars.js";
import { isMainModule } from "@breaker/kit";
import type { Strategy, Metrics, TradeAnalysis } from "./index.js";
import type { CandleClientOptions } from "./data/fetch-candles.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StrategyResult {
  name: string;
  file: string;
  label: string;
  metrics: Metrics;
  analysis: TradeAnalysis | null;
  criteria: CriteriaCheck;
  paramCount: number;
}

interface CriteriaCheck {
  passAll: boolean;
  minTrades: boolean;
  minPF: boolean;
  maxDD: boolean;
  minWR: boolean;
  minAvgR: boolean;
  wfOverfit: boolean;
  failCount: number;
}

interface Criteria {
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR: number;
  minAvgR: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers (visual-width aware)
// ---------------------------------------------------------------------------

const A = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  ylw: "\x1b[33m",
  mag: "\x1b[35m",
  cyn: "\x1b[36m",
  wht: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGrn: "\x1b[42m",
  bgYlw: "\x1b[43m",
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s: string): number {
  return stripAnsi(s).length;
}

/** Pad right to `w` visible characters (ANSI-aware). */
function padR(s: string, w: number): string {
  const gap = w - visLen(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Pad left to `w` visible characters (ANSI-aware). */
function padL(s: string, w: number): string {
  const gap = w - visLen(s);
  return gap > 0 ? " ".repeat(gap) + s : s;
}

function ok(s: string): string { return `${A.grn}${s}${A.r}`; }
function fail(s: string): string { return `${A.red}${s}${A.r}`; }
function dim(s: string): string { return `${A.d}${s}${A.r}`; }
function bold(s: string): string { return `${A.b}${s}${A.r}`; }
function crit(pass: boolean, s: string): string { return pass ? ok(s) : fail(s); }
function badge(pass: boolean): string {
  return pass
    ? `${A.bgGrn}${A.b}${A.wht} PASS ${A.r}`
    : `${A.bgRed}${A.b}${A.wht} FAIL ${A.r}`;
}

// ---------------------------------------------------------------------------
// Strategy discovery
// ---------------------------------------------------------------------------

function discoverStrategies(stratDir: string): { file: string; label: string }[] {
  const results: { file: string; label: string }[] = [];
  if (!fs.existsSync(stratDir)) return results;

  const deployedDir = path.join(stratDir, "deployed");
  if (fs.existsSync(deployedDir)) {
    for (const f of fs.readdirSync(deployedDir)) {
      if (f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts")) {
        results.push({ file: path.join(deployedDir, f), label: "deployed" });
      }
    }
  }

  for (const f of fs.readdirSync(stratDir)) {
    const full = path.join(stratDir, f);
    if (fs.statSync(full).isDirectory()) continue;
    if (!f.endsWith(".ts") || f === "index.ts" || f.endsWith(".test.ts")) continue;
    results.push({ file: full, label: "variant" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Criteria check
// ---------------------------------------------------------------------------

function checkCriteria(m: Metrics, a: TradeAnalysis | null, cr: Criteria): CriteriaCheck {
  const minTrades = (m.numTrades ?? 0) >= cr.minTrades;
  const minPF = (m.profitFactor ?? 0) >= cr.minPF;
  const maxDD = Math.abs(m.maxDrawdownPct ?? 0) <= cr.maxDD;
  const minWR = (m.winRate ?? 0) >= cr.minWR;
  const minAvgR = (m.avgR ?? 0) >= cr.minAvgR;
  const wfOverfit = !(a?.walkForward?.overfitFlag === true);
  const checks = [minTrades, minPF, maxDD, minWR, minAvgR, wfOverfit];
  return {
    passAll: checks.every(Boolean),
    minTrades, minPF, maxDD, minWR, minAvgR, wfOverfit,
    failCount: checks.filter(c => !c).length,
  };
}

// ---------------------------------------------------------------------------
// Output: ranking table
// ---------------------------------------------------------------------------

function printRanking(sorted: StrategyResult[], cr: Criteria): void {
  const W = { rank: 4, name: 42, type: 10, trades: 6, pf: 6, wr: 5, dd: 5, avgR: 5, pnl: 9, wf: 3 };

  // Header
  const hdr =
    ` ${A.b}${"#".padEnd(W.rank)}${"Strategy".padEnd(W.name)}${"Type".padEnd(W.type)}` +
    `${"Trd".padStart(W.trades)} ${"PF".padStart(W.pf)} ${"WR%".padStart(W.wr)} ` +
    `${"DD%".padStart(W.dd)} ${"AvgR".padStart(W.avgR)} ${"PnL".padStart(W.pnl)} ` +
    `${"WF".padStart(W.wf)}${A.r}`;

  const totalW = W.rank + W.name + W.type + W.trades + W.pf + W.wr + W.dd + W.avgR + W.pnl + W.wf + 10;
  const rule = dim("─".repeat(totalW));

  console.log(` ${rule}`);
  console.log(hdr);
  console.log(` ${rule}`);

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const m = r.metrics;
    const ch = r.criteria;

    const rank = String(i + 1).padEnd(W.rank);
    const nameRaw = r.name.length > W.name ? r.name.slice(0, W.name - 1) + "…" : r.name;
    const name = nameRaw.padEnd(W.name);
    const type = dim(r.label.padEnd(W.type));
    const trades = padL(crit(ch.minTrades, String(m.numTrades ?? 0)), W.trades);
    const pf = padL(crit(ch.minPF, (m.profitFactor ?? 0).toFixed(2)), W.pf);
    const wr = padL(crit(ch.minWR, (m.winRate ?? 0).toFixed(0)), W.wr);
    const dd = padL(crit(ch.maxDD, Math.abs(m.maxDrawdownPct ?? 0).toFixed(0)), W.dd);
    const avgR = padL(crit(ch.minAvgR, (m.avgR ?? 0).toFixed(2)), W.avgR);
    const pnlVal = (m.totalPnl ?? 0);
    const pnl = padL(pnlVal >= 0 ? ok("$" + pnlVal.toFixed(0)) : fail("$" + pnlVal.toFixed(0)), W.pnl);
    const wf = padL(r.analysis?.walkForward?.overfitFlag ? fail("✗") : ok("✓"), W.wf);
    const pass = badge(ch.passAll);

    console.log(` ${rank}${name}${type}${trades} ${pf} ${wr} ${dd} ${avgR} ${pnl} ${wf}  ${pass}`);
  }

  console.log(` ${rule}`);
}

// ---------------------------------------------------------------------------
// Output: strategy detail card
// ---------------------------------------------------------------------------

function printCard(r: StrategyResult, rank: number, cr: Criteria): void {
  const m = r.metrics;
  const a = r.analysis;
  const ch = r.criteria;
  const wf = a?.walkForward;

  const labelColor = r.label === "deployed" ? A.cyn : A.mag;
  const labelTag = `${labelColor}${A.b}${r.label.toUpperCase()}${A.r}`;

  // Header line
  console.log(`  ${A.b}${A.cyn}#${rank}${A.r}  ${bold(r.name)}  ${labelTag}  ${badge(ch.passAll)}`);
  console.log(`      ${dim(r.file)}`);
  console.log("");

  // Metric cell: "Label    value  goal" with proper widths
  const cell = (label: string, value: string, goal: string): string => {
    return `${label.padEnd(10)} ${padL(value, 8)}  ${goal ? dim(goal) : ""}`;
  };

  const COL_VIS_W = 30; // fixed visible width for left column (before gap)

  const rows: [string, string][] = [
    [cell("Trades", crit(ch.minTrades, String(m.numTrades ?? 0)), `≥${cr.minTrades}`),
     cell("Max DD", crit(ch.maxDD, Math.abs(m.maxDrawdownPct ?? 0).toFixed(1) + "%"), `≤${cr.maxDD}%`)],
    [cell("PF", crit(ch.minPF, (m.profitFactor ?? 0).toFixed(2)), `≥${cr.minPF}`),
     cell("Avg R", crit(ch.minAvgR, (m.avgR ?? 0).toFixed(2)), `≥${cr.minAvgR}`)],
    [cell("Win Rate", crit(ch.minWR, (m.winRate ?? 0).toFixed(1) + "%"), `≥${cr.minWR}%`),
     cell("PnL", (m.totalPnl ?? 0) >= 0 ? ok("$" + (m.totalPnl ?? 0).toFixed(0)) : fail("$" + (m.totalPnl ?? 0).toFixed(0)), "")],
  ];

  for (const [left, right] of rows) {
    console.log(`      ${padR(left, COL_VIS_W)}    ${right}`);
  }
  console.log("");

  // Secondary stats line
  const exp = m.expectancy ?? 0;
  const avgWin = m.avgWinR ?? 0;
  const avgLoss = m.avgLossR ?? 0;
  const maxLoss = m.maxLossR ?? 0;
  const stats = [
    `${dim("Expectancy")} ${exp >= 0 ? ok(exp.toFixed(3) + "R") : fail(exp.toFixed(3) + "R")}`,
    `${dim("Avg Win")} ${ok(avgWin.toFixed(2) + "R")}`,
    `${dim("Avg Loss")} ${fail(avgLoss.toFixed(2) + "R")}`,
    `${dim("Max Loss")} ${fail(maxLoss.toFixed(2) + "R")}`,
  ];
  console.log(`      ${stats.join("  ")}`);

  // Params
  console.log(`      ${dim("Params")} ${r.paramCount}${r.paramCount > 8 ? fail(" (>8 free vars)") : ""}`);

  // Direction breakdown
  const longStats = a?.byDirection?.["Long"];
  const shortStats = a?.byDirection?.["Short"];
  if (longStats || shortStats) {
    const parts: string[] = [];
    if (longStats) parts.push(`${ok("Long")} ${longStats.count} (WR ${longStats.winRate.toFixed(0)}%)`);
    if (shortStats) parts.push(`${fail("Short")} ${shortStats.count} (WR ${shortStats.winRate.toFixed(0)}%)`);
    console.log(`      ${dim("Direction")} ${parts.join("  │  ")}`);
  }

  // Walk-forward
  if (wf) {
    const trainPF = wf.trainPF?.toFixed(2) ?? "?";
    const testPF = wf.testPF?.toFixed(2) ?? "?";
    const ratio = wf.pfRatio?.toFixed(2) ?? "?";
    const ofitStr = wf.overfitFlag ? fail("OVERFIT") : ok("OK");
    console.log(`      ${dim("Walk-Fwd")}  Train PF=${trainPF}  Test PF=${testPF}  Ratio=${ratio}  ${ofitStr}`);
  } else {
    console.log(`      ${dim("Walk-Fwd")}  ${dim("N/A")}`);
  }

  // Failing criteria
  if (!ch.passAll) {
    const failing: string[] = [];
    if (!ch.minTrades) failing.push(`trades ${m.numTrades ?? 0} < ${cr.minTrades}`);
    if (!ch.minPF) failing.push(`PF ${(m.profitFactor ?? 0).toFixed(2)} < ${cr.minPF}`);
    if (!ch.maxDD) failing.push(`DD ${Math.abs(m.maxDrawdownPct ?? 0).toFixed(1)}% > ${cr.maxDD}%`);
    if (!ch.minWR) failing.push(`WR ${(m.winRate ?? 0).toFixed(1)}% < ${cr.minWR}%`);
    if (!ch.minAvgR) failing.push(`avgR ${(m.avgR ?? 0).toFixed(2)} < ${cr.minAvgR}`);
    if (!ch.wfOverfit) failing.push("walk-forward overfit");
    console.log(`      ${A.ylw}✗ ${failing.join(", ")}${A.r}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Output: full report
// ---------------------------------------------------------------------------

function printReport(results: StrategyResult[], cr: Criteria, period: string, asset: string, category: string): void {
  const sorted = [...results].sort((a, b) => {
    if (a.criteria.passAll !== b.criteria.passAll) return a.criteria.passAll ? -1 : 1;
    if (a.criteria.failCount !== b.criteria.failCount) return a.criteria.failCount - b.criteria.failCount;
    return (b.metrics.profitFactor ?? 0) - (a.metrics.profitFactor ?? 0);
  });

  const passing = sorted.filter(r => r.criteria.passAll).length;
  const total = sorted.length;
  const deployed = sorted.filter(r => r.label === "deployed").length;
  const variants = sorted.filter(r => r.label === "variant").length;

  // ── Header ──
  console.log("");
  const title = `Strategy Comparison — ${asset} ${category}`;
  const boxW = Math.max(title.length + 6, 60);
  console.log(`${A.b}${A.cyn} ╔${"═".repeat(boxW)}╗${A.r}`);
  console.log(`${A.b}${A.cyn} ║  ${title.padEnd(boxW - 2)}║${A.r}`);
  console.log(`${A.b}${A.cyn} ╚${"═".repeat(boxW)}╝${A.r}`);
  console.log("");
  console.log(` ${dim("Period")}      ${period}`);
  console.log(` ${dim("Strategies")}  ${total} found (${deployed} deployed, ${variants} variants)`);
  console.log(` ${dim("Criteria")}    PF≥${cr.minPF}  DD≤${cr.maxDD}%  Trades≥${cr.minTrades}  WR≥${cr.minWR}%  AvgR≥${cr.minAvgR}  WF=no-overfit`);
  console.log("");

  // ── Ranking ──
  console.log(bold(" RANKING"));
  printRanking(sorted, cr);
  console.log("");

  // ── Details ──
  console.log(bold(" DETAILS"));
  console.log("");
  for (let i = 0; i < sorted.length; i++) {
    printCard(sorted[i], i + 1, cr);
    if (i < sorted.length - 1) {
      console.log(`  ${dim("─".repeat(60))}`);
      console.log("");
    }
  }

  // ── Verdict ──
  console.log(`${A.b}${A.cyn} ${"─".repeat(3)} VERDICT ${"─".repeat(50)}${A.r}`);
  console.log("");
  if (passing > 0) {
    console.log(` ${A.bgGrn}${A.b}${A.wht} ${passing}/${total} PASS ${A.r}`);
    const best = sorted[0];
    console.log(` ${bold("Best:")} ${best.name} — PF=${(best.metrics.profitFactor ?? 0).toFixed(2)}, ${best.metrics.numTrades} trades, DD=${Math.abs(best.metrics.maxDrawdownPct ?? 0).toFixed(1)}%`);
  } else {
    console.log(` ${A.bgYlw}${A.b} 0/${total} PASS ${A.r}  ${dim("Nenhuma estrategia atende todos os criterios")}`);
    const closest = sorted[0];
    if (closest) {
      console.log(` ${bold("Mais proxima:")} ${closest.name} — ${closest.criteria.failCount} criterio(s) falhando`);
      const m = closest.metrics;
      const needed: string[] = [];
      if (!closest.criteria.minPF) needed.push(`PF: ${(m.profitFactor ?? 0).toFixed(2)} → precisa ${cr.minPF} (+${(cr.minPF - (m.profitFactor ?? 0)).toFixed(2)})`);
      if (!closest.criteria.maxDD) needed.push(`DD: ${Math.abs(m.maxDrawdownPct ?? 0).toFixed(1)}% → precisa ≤${cr.maxDD}%`);
      if (!closest.criteria.minTrades) needed.push(`Trades: ${m.numTrades ?? 0} → precisa ${cr.minTrades}`);
      if (!closest.criteria.minAvgR) needed.push(`AvgR: ${(m.avgR ?? 0).toFixed(2)} → precisa ${cr.minAvgR}`);
      if (!closest.criteria.minWR) needed.push(`WR: ${(m.winRate ?? 0).toFixed(1)}% → precisa ${cr.minWR}%`);
      if (!closest.criteria.wfOverfit) needed.push("Walk-forward com overfit detectado");
      for (const n of needed) {
        console.log(`          ${A.ylw}${n}${A.r}`);
      }
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export async function main(): Promise<void> {
  const cli = cac("compare-strategies");

  cli.option("--category <cat>", "Strategy category: breakout|mean-reversion|pullback (default: breakout)");
  cli.option("--start <date>", "Start date YYYY-MM-DD");
  cli.option("--end <date>", "End date YYYY-MM-DD (default: today)");
  cli.option("--days <n>", "Days to backtest (default: 180)");
  cli.option("--source <source>", "Data source: binance|hyperliquid (default: binance)");
  cli.option("--no-limits", "Disable trade limits");
  cli.help();

  const { args, options } = cli.parse();

  const asset = (args[0] ?? "BTC").toUpperCase();
  const category = options.category ?? "breakout";
  const source = (options.source ?? "binance") as "binance" | "hyperliquid";
  const coin = asset;
  const interval = "15m" as const;
  const noLimits = options.limits === false;

  const startDate: string | undefined = options.start;
  const endDate: string | undefined = options.end;
  let startTime: number;
  let endTime: number;

  if (startDate) {
    startTime = new Date(startDate + "T00:00:00Z").getTime();
    endTime = endDate ? new Date(endDate + "T23:59:59Z").getTime() : Date.now();
  } else {
    const days = Number(options.days ?? 180);
    endTime = Date.now();
    startTime = endTime - days * 86_400_000;
  }

  const periodStr = `${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`;

  // Load criteria from breaker-config.json
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(scriptDir, "../../..");
  const configPath = path.join(repoRoot, "packages/refiner/breaker-config.json");
  let criteria: Criteria = { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: 0, minAvgR: 0.15 };

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const profile = config.strategyProfiles?.[category];
    const assetClass = config.assetClasses?.[config.assets?.[asset]?.class];
    criteria = {
      minTrades: profile?.minTrades ?? assetClass?.minTrades ?? config.criteria?.minTrades ?? 50,
      minPF: profile?.minPF ?? assetClass?.minPF ?? config.criteria?.minPF ?? 1.3,
      maxDD: profile?.maxDD ?? assetClass?.maxDD ?? config.criteria?.maxDD ?? 10,
      minWR: profile?.minWR ?? assetClass?.minWR ?? config.criteria?.minWR ?? 0,
      minAvgR: profile?.minAvgR ?? assetClass?.minAvgR ?? config.criteria?.minAvgR ?? 0.15,
    };
  }

  // Discover strategies
  const stratDir = path.join(repoRoot, "packages/backtest/src/strategies", asset.toLowerCase(), category);
  const discovered = discoverStrategies(stratDir);

  if (discovered.length === 0) {
    console.error(`No strategies found in ${stratDir}`);
    process.exit(1);
  }

  console.log(`${A.d}Comparing ${discovered.length} ${asset} ${category} strategies...${A.r}`);

  // Sync candles once
  const cacheDir = path.join(repoRoot, "packages/backtest/.cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const dbPath = path.join(cacheDir, "candles.db");
  const cache = new CandleCache(dbPath);
  const clientOpts: CandleClientOptions = { source };

  const WARMUP_DAYS = 730;
  const dataStartTime = startTime - WARMUP_DAYS * 86_400_000;

  console.log(`${A.d}Syncing candles...${A.r}`);
  await cache.sync(coin, interval, dataStartTime, endTime, clientOpts);
  for (const tf of ["1h", "1d"] as const) {
    await cache.sync(coin, tf, dataStartTime, endTime, clientOpts);
  }

  const candles = cache.getCandles(coin, interval, dataStartTime, endTime, source);
  cache.close();

  if (candles.length === 0) {
    console.error("No candles available.");
    process.exit(1);
  }

  // Run each strategy
  const results: StrategyResult[] = [];

  for (const { file, label } of discovered) {
    const distPath = file.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
    const absDistPath = path.resolve(distPath);

    if (!fs.existsSync(absDistPath)) {
      console.log(`${A.ylw}  SKIP ${path.basename(file)} (not built)${A.r}`);
      continue;
    }

    try {
      const mod = await import(absDistPath) as Record<string, unknown>;
      const factoryKey = Object.keys(mod).find(k => typeof mod[k] === "function" && k.startsWith("create"));
      if (!factoryKey) {
        console.log(`${A.ylw}  SKIP ${path.basename(file)} (no create* factory)${A.r}`);
        continue;
      }

      const factory = mod[factoryKey] as (overrides?: Record<string, number>) => Strategy;
      const strategy = factory({});

      const warmupBars = computeMinWarmupBars(strategy, interval);
      const effectiveWarmup = Math.max(
        warmupBars,
        candles.findIndex(cc => cc.t >= startTime),
      );

      const config = {
        ...DEFAULT_BACKTEST_CONFIG,
        warmupBars: effectiveWarmup,
        ...(noLimits ? {
          cooldownBars: 0,
          maxDailyLossR: Number.MAX_SAFE_INTEGER,
          maxTradesPerDay: Number.MAX_SAFE_INTEGER,
          maxGlobalTradesDay: Number.MAX_SAFE_INTEGER,
        } : {}),
      };

      console.log(`${A.d}  Running ${strategy.name ?? path.basename(file, ".ts")}...${A.r}`);
      const result = runBacktest(candles, strategy, config, interval);
      const metrics = computeMetrics(result.trades, result.maxDrawdownPct);
      const analysis = analyzeTradeList(result.trades);

      // Count optimizable params
      const paramCount = Object.values(strategy.params).filter(
        (p) => typeof p === "object" && p !== null && "optimizable" in p && p.optimizable,
      ).length;

      results.push({
        name: strategy.name ?? path.basename(file, ".ts"),
        file: path.basename(file),
        label,
        metrics,
        analysis,
        criteria: checkCriteria(metrics, analysis, criteria),
        paramCount,
      });
    } catch (err) {
      console.log(`${A.red}  ERROR ${path.basename(file)}: ${(err as Error).message.split("\n")[0]}${A.r}`);
    }
  }

  if (results.length === 0) {
    console.error("No strategies could be evaluated.");
    process.exit(1);
  }

  printReport(results, criteria, periodStr, asset, category);
}
