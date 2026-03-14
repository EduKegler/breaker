# Regime Stats Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify each trade's market regime ex-post (trending/ranging/unclear) and surface per-regime stats in backtest output, compare display, and optimizer prompt.

**Architecture:** New `computeRegimeStats(trades, candles)` function — separate from `analyzeTradeList` (same pattern as `computeRiskMetrics`). Classifies regime using ADX(14) and EMA(50) slope computed on a 20-bar lookback window before each trade's entry. Result stored as `byRegime: Record<string, RegimeStats> | null` in `TradeAnalysis`.

**Tech Stack:** TypeScript, existing `adx()` and `ema()` indicators from `@breaker/backtest/indicators`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/backtest/src/types/metrics.ts` | Modify | Add `RegimeStats` interface, add `byRegime` field to `TradeAnalysis` |
| `packages/backtest/src/analysis/regime-stats.ts` | Create | `computeRegimeStats()` + `classifyRegime()` |
| `packages/backtest/src/analysis/regime-stats.test.ts` | Create | Tests for regime classification |
| `packages/backtest/src/analysis/trade-analysis.ts` | Modify | Add `byRegime: null` to `emptyAnalysis()` |
| `packages/backtest/src/index.ts` | Modify | Export new function and types |
| `packages/backtest/src/run-backtest.ts` | Modify | Call `computeRegimeStats`, display table |
| `packages/backtest/src/compare-strategies.ts` | Modify | Display regime line in card |
| `packages/refiner/src/automation/build-optimize-prompt.ts` | Modify | Add regime section to optimizer prompt |

---

## Task 1: Types — `RegimeStats` + `byRegime` field

**Files:**
- Modify: `packages/backtest/src/types/metrics.ts`
- Modify: `packages/backtest/src/analysis/trade-analysis.ts`

- [ ] **Step 1: Add `RegimeStats` interface to metrics.ts**

Add after the `SessionStats` interface (line 151), before `TradeAnalysis`:

```typescript
export type RegimeName = "trending" | "ranging" | "unclear";

export interface RegimeStats {
  count: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  avgTrade: number;
}
```

- [ ] **Step 2: Add `byRegime` field to `TradeAnalysis`**

Add after `bySession` (line 167):

```typescript
  byRegime: Record<string, RegimeStats> | null;
```

- [ ] **Step 3: Add `byRegime: null` to `emptyAnalysis()` in trade-analysis.ts**

In `packages/backtest/src/analysis/trade-analysis.ts`, in `emptyAnalysis()`, add after `bySession: null`:

```typescript
    byRegime: null,
```

Also add to the return object in `analyzeTradeList()`, after `bySession`:

```typescript
    byRegime: null,
```

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm --filter @breaker/backtest typecheck`
Expected: no errors (byRegime is null everywhere, no callers break)

---

## Task 2: Core logic — `computeRegimeStats`

**Files:**
- Create: `packages/backtest/src/analysis/regime-stats.ts`

- [ ] **Step 1: Create regime-stats.ts with full implementation**

```typescript
import type { Candle } from "../types/candle.js";
import type { CompletedTrade } from "../types/order.js";
import type { RegimeName, RegimeStats } from "../types/metrics.js";
import { adx } from "../indicators/adx.js";
import { ema } from "../indicators/ema.js";

const ADX_PERIOD = 14;
const EMA_PERIOD = 50;
const LOOKBACK_BARS = 20;
const ADX_TRENDING_THRESHOLD = 25;
const ADX_RANGING_THRESHOLD = 20;

/**
 * Classify market regime for each trade using a lookback window before entry.
 * ADX(14) > 25 = trending, < 20 = ranging, 20-25 = unclear.
 * Requires candles array that matches the entryBarIndex values in trades.
 */
export function computeRegimeStats(
  trades: CompletedTrade[],
  candles: Candle[],
): Record<string, RegimeStats> | null {
  if (trades.length === 0 || candles.length === 0) return null;

  const buckets: Record<string, { count: number; pnl: number; wins: number; grossWin: number; grossLoss: number }> = {};

  // Pre-compute ADX and EMA on full candle series (O(n) once, not per trade)
  const adxResult = adx(candles, ADX_PERIOD);
  const closes = candles.map(c => c.c);
  const emaResult = ema(closes, EMA_PERIOD);

  for (const t of trades) {
    const regime = classifyRegime(t.entryBarIndex, adxResult.adx, emaResult);

    if (!buckets[regime]) {
      buckets[regime] = { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 };
    }
    const b = buckets[regime];
    b.count++;
    b.pnl += t.pnl;
    if (t.pnl > 0) {
      b.wins++;
      b.grossWin += t.pnl;
    } else {
      b.grossLoss += Math.abs(t.pnl);
    }
  }

  const result: Record<string, RegimeStats> = {};
  for (const [regime, b] of Object.entries(buckets)) {
    result[regime] = {
      count: b.count,
      pnl: b.pnl,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
      profitFactor: b.grossLoss > 0 ? b.grossWin / b.grossLoss : b.grossWin > 0 ? Infinity : 0,
      avgTrade: b.count > 0 ? b.pnl / b.count : 0,
    };
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Classify regime at a given bar index using mean ADX over a lookback window.
 * Uses pre-computed indicator arrays for O(1) per trade.
 */
export function classifyRegime(
  entryBarIndex: number,
  adxValues: number[],
  emaValues: number[],
): RegimeName {
  // Compute mean ADX over lookback window before entry
  const start = Math.max(0, entryBarIndex - LOOKBACK_BARS);
  const end = entryBarIndex;

  if (start >= end) return "unclear";

  let adxSum = 0;
  let adxCount = 0;
  for (let i = start; i < end; i++) {
    if (!isNaN(adxValues[i])) {
      adxSum += adxValues[i];
      adxCount++;
    }
  }

  if (adxCount === 0) return "unclear";

  const meanAdx = adxSum / adxCount;

  if (meanAdx > ADX_TRENDING_THRESHOLD) return "trending";
  if (meanAdx < ADX_RANGING_THRESHOLD) return "ranging";
  return "unclear";
}
```

- [ ] **Step 2: Verify file compiles**

Run: `pnpm --filter @breaker/backtest typecheck`
Expected: no errors

---

## Task 3: Tests — `regime-stats.test.ts`

**Files:**
- Create: `packages/backtest/src/analysis/regime-stats.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { computeRegimeStats, classifyRegime } from "./regime-stats.js";
import type { CompletedTrade } from "../types/order.js";
import type { Candle } from "../types/candle.js";

function makeCandle(close: number, high: number, low: number, t: number): Candle {
  return { t, o: close, h: high, l: low, c: close, v: 100, n: 0 };
}

function makeTrade(pnl: number, entryBarIndex: number): CompletedTrade {
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl > 0 ? 2 : -1,
    entryTimestamp: 1000 + entryBarIndex * 60000,
    exitTimestamp: 1000 + (entryBarIndex + 10) * 60000,
    entryBarIndex,
    exitBarIndex: entryBarIndex + 10,
    barsHeld: 10,
    exitType: pnl > 0 ? "tp1" : "sl",
    commission: 0.5,
    slippageCost: 0.1,
    fundingCost: 0,
    entryComment: "test",
    exitComment: "test",
  };
}

// Generate trending candles: steady uptrend with strong directional moves
function makeTrendingCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 2 + Math.sin(i * 0.1); // Strong upward drift
    const high = price + 1;
    const low = price - 0.5;
    candles.push(makeCandle(price, high, low, i * 60000));
  }
  return candles;
}

// Generate ranging candles: oscillating around a mean with no direction
function makeRangingCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  const mean = 100;
  for (let i = 0; i < count; i++) {
    const price = mean + Math.sin(i * 0.5) * 2; // Tight oscillation
    const high = price + 0.5;
    const low = price - 0.5;
    candles.push(makeCandle(price, high, low, i * 60000));
  }
  return candles;
}

describe("computeRegimeStats", () => {
  it("returns null for empty trades", () => {
    const candles = makeTrendingCandles(100);
    expect(computeRegimeStats([], candles)).toBeNull();
  });

  it("returns null for empty candles", () => {
    const trades = [makeTrade(5, 50)];
    expect(computeRegimeStats(trades, [])).toBeNull();
  });

  it("returns record with regime keys for valid input", () => {
    const candles = makeTrendingCandles(200);
    const trades = [makeTrade(5, 100), makeTrade(-3, 150)];
    const result = computeRegimeStats(trades, candles);
    expect(result).not.toBeNull();
    // Should have at least one regime key
    const keys = Object.keys(result!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(["trending", "ranging", "unclear"]).toContain(key);
    }
  });

  it("computes correct stats per regime bucket", () => {
    const candles = makeTrendingCandles(200);
    // All trades at same regime context
    const trades = [
      makeTrade(10, 100),
      makeTrade(-5, 110),
      makeTrade(8, 120),
    ];
    const result = computeRegimeStats(trades, candles)!;
    expect(result).not.toBeNull();

    // Sum all regime buckets — total should match
    const totalCount = Object.values(result).reduce((s, r) => s + r.count, 0);
    const totalPnl = Object.values(result).reduce((s, r) => s + r.pnl, 0);
    expect(totalCount).toBe(3);
    expect(totalPnl).toBeCloseTo(13); // 10 - 5 + 8
  });

  it("winRate and profitFactor compute correctly within a bucket", () => {
    const candles = makeTrendingCandles(200);
    const trades = [
      makeTrade(10, 100),
      makeTrade(-5, 105),
    ];
    const result = computeRegimeStats(trades, candles)!;

    // All trades should be in same regime (trending candles)
    const values = Object.values(result);
    expect(values.length).toBe(1);
    const bucket = values[0];
    expect(bucket.count).toBe(2);
    expect(bucket.winRate).toBeCloseTo(50); // 1/2
    expect(bucket.profitFactor).toBeCloseTo(2); // 10/5
    expect(bucket.avgTrade).toBeCloseTo(2.5); // 5/2
  });
});

describe("classifyRegime", () => {
  it("returns 'unclear' when entryBarIndex is 0 (no lookback)", () => {
    expect(classifyRegime(0, [25, 30], [100, 101])).toBe("unclear");
  });

  it("returns 'trending' when mean ADX > 25", () => {
    // 20 bars of ADX = 30 before entry at index 20
    const adxValues = new Array(25).fill(30);
    const emaValues = new Array(25).fill(100);
    expect(classifyRegime(20, adxValues, emaValues)).toBe("trending");
  });

  it("returns 'ranging' when mean ADX < 20", () => {
    const adxValues = new Array(25).fill(15);
    const emaValues = new Array(25).fill(100);
    expect(classifyRegime(20, adxValues, emaValues)).toBe("ranging");
  });

  it("returns 'unclear' when mean ADX is between 20 and 25", () => {
    const adxValues = new Array(25).fill(22);
    const emaValues = new Array(25).fill(100);
    expect(classifyRegime(20, adxValues, emaValues)).toBe("unclear");
  });

  it("skips NaN values in ADX lookback", () => {
    // First 10 are NaN (warmup), rest are 30 (trending)
    const adxValues = [...new Array(10).fill(NaN), ...new Array(15).fill(30)];
    const emaValues = new Array(25).fill(100);
    // Lookback 20 bars before index 20 → indices 0-19, only 10 valid values
    expect(classifyRegime(20, adxValues, emaValues)).toBe("trending");
  });

  it("returns 'unclear' when all ADX values are NaN", () => {
    const adxValues = new Array(25).fill(NaN);
    const emaValues = new Array(25).fill(100);
    expect(classifyRegime(20, adxValues, emaValues)).toBe("unclear");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter @breaker/backtest test -- src/analysis/regime-stats.test.ts`
Expected: all tests pass

---

## Task 4: Exports — `index.ts`

**Files:**
- Modify: `packages/backtest/src/index.ts`

- [ ] **Step 1: Add type exports**

In the type export block (around line 21), add after `RollingWalkForward`:

```typescript
  RegimeName,
  RegimeStats,
```

- [ ] **Step 2: Add function export**

In the Analysis export block (around line 68), add after the `computeRollingWalkForward` line:

```typescript
export { computeRegimeStats, classifyRegime } from "./analysis/regime-stats.js";
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `pnpm --filter @breaker/backtest typecheck && pnpm --filter @breaker/backtest test`
Expected: typecheck clean, all tests pass

---

## Task 5: Display — `run-backtest.ts`

**Files:**
- Modify: `packages/backtest/src/run-backtest.ts`

- [ ] **Step 1: Import `computeRegimeStats`**

Add to imports (around line 6):

```typescript
import { computeRegimeStats } from "./analysis/regime-stats.js";
```

- [ ] **Step 2: Call `computeRegimeStats` after `analyzeTradeList`**

After line 142 (`const analysis = analyzeTradeList(trades);`), add:

```typescript
  const byRegime = computeRegimeStats(trades, candles);
  analysis.byRegime = byRegime;
```

- [ ] **Step 3: Add regime display after session breakdown**

After the session breakdown block (after line 188 closing brace), add:

```typescript
  // Regime breakdown
  if (analysis.byRegime) {
    console.log("\n=== Regime Breakdown ===");
    const rHdr = "Regime".padEnd(12) + "Trades".padStart(8) + "PnL".padStart(10) +
      "WR%".padStart(7) + "PF".padStart(7) + "Avg".padStart(9);
    console.log(rHdr);
    console.log("─".repeat(53));
    for (const [name, r] of Object.entries(analysis.byRegime)) {
      if (r.count === 0) continue;
      const pf = r.profitFactor === Infinity ? "Inf" : r.profitFactor.toFixed(2);
      console.log(
        name.padEnd(12) +
        String(r.count).padStart(8) +
        `$${r.pnl.toFixed(2)}`.padStart(10) +
        r.winRate.toFixed(1).padStart(7) +
        pf.padStart(7) +
        `$${r.avgTrade.toFixed(2)}`.padStart(9),
      );
    }
  }
```

---

## Task 6: Display — `compare-strategies.ts`

**Files:**
- Modify: `packages/backtest/src/compare-strategies.ts`

- [ ] **Step 1: Import `computeRegimeStats`**

Add to imports (around line 8):

```typescript
import { computeRegimeStats } from "./analysis/regime-stats.js";
```

- [ ] **Step 2: Call `computeRegimeStats` in the strategy evaluation loop**

After line 559 (`const analysis = analyzeTradeList(result.trades);`), add:

```typescript
      analysis.byRegime = computeRegimeStats(result.trades, candles);
```

- [ ] **Step 3: Add regime line in `printCard`**

In `printCard()`, after the Rolling Walk-Forward block (after the `Rolling-WF` display), add:

```typescript
  // Regime breakdown
  if (a?.byRegime) {
    const parts: string[] = [];
    for (const [name, r] of Object.entries(a.byRegime)) {
      if (r.count === 0) continue;
      const pfStr = r.profitFactor === Infinity ? "Inf" : r.profitFactor.toFixed(2);
      parts.push(`${name}: ${r.count}t PF=${pfStr}`);
    }
    if (parts.length > 0) {
      console.log(`      ${dim("Regime")}    ${parts.join("  ")}`);
    }
  }
```

---

## Task 7: Prompt builder — `build-optimize-prompt.ts`

**Files:**
- Modify: `packages/refiner/src/automation/build-optimize-prompt.ts`

- [ ] **Step 1: Add `RegimeStats` to import from `@breaker/backtest`**

On the import line from `@breaker/backtest` (line 15), add `RegimeStats` to the type import.

- [ ] **Step 2: Add regime section in `buildTradeAnalysisSection`**

In `buildTradeAnalysisSection` (starts around line 1134), after the existing session block, add a regime block:

```typescript
  // Regime breakdown
  if (ta.byRegime) {
    const regimeLines = Object.entries(ta.byRegime)
      .filter(([, r]) => r.count > 0)
      .map(([name, r]) => {
        const pf = r.profitFactor === Infinity ? "Inf" : r.profitFactor.toFixed(2);
        return `  ${name.padEnd(12)}: ${String(r.count).padStart(3)}t | WR=${r.winRate.toFixed(1).padStart(5)}% | PF=${pf.padStart(5)} | avg=$${r.avgTrade.toFixed(2)}`;
      })
      .join("\n");
    if (regimeLines) {
      lines.push(`\nBy regime (ADX-based, ex-post classification):\n${regimeLines}`);
    }
  }
```

Find the appropriate `lines` array context inside `buildTradeAnalysisSection` and add before the function returns.

---

## Task 8: Build + Test all

- [ ] **Step 1: Build backtest**

Run: `pnpm --filter @breaker/backtest build`
Expected: clean build

- [ ] **Step 2: Build refiner**

Run: `pnpm --filter @breaker/refiner build`
Expected: clean build

- [ ] **Step 3: Typecheck all**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 4: Test all**

Run: `pnpm test`
Expected: all tests pass (backtest ~450+, refiner ~865)

- [ ] **Step 5: Smoke test — run-backtest with regime output**

Run: `node packages/backtest/dist/run-backtest.js BTC --days 240 --strategy short-range 2>&1 | grep -A 10 "Regime"`
Expected: Regime Breakdown table with trending/ranging/unclear rows

- [ ] **Step 6: Smoke test — compare-strategies with regime line**

Run: `node packages/backtest/dist/compare-strategies.js BTC --category breakout --days 240 2>&1 | grep -i "regime"`
Expected: Regime lines in strategy detail cards

---

## Task 9: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add packages/backtest/src/types/metrics.ts \
       packages/backtest/src/analysis/regime-stats.ts \
       packages/backtest/src/analysis/regime-stats.test.ts \
       packages/backtest/src/analysis/trade-analysis.ts \
       packages/backtest/src/index.ts \
       packages/backtest/src/run-backtest.ts \
       packages/backtest/src/compare-strategies.ts \
       packages/refiner/src/automation/build-optimize-prompt.ts
git commit -m "feat(backtest): add ex-post regime classification (trending/ranging/unclear)"
```
