# Sharpe & Sortino Ratio Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add annualized Sharpe and Sortino ratios to backtest Metrics, computed from the equity curve's daily returns.

**Architecture:** Sharpe and Sortino are computed from equity point daily returns, not from trades. A new `computeRiskMetrics(equityPoints)` function converts equity points into calendar-day returns, then computes both ratios. The results are merged into the `Metrics` object at each call site that has access to equity points. Call sites without equity points (e.g., deserialized checkpoints) get `null`.

**Tech Stack:** TypeScript, Vitest, pure math (no external stats library needed)

---

## Design Decisions

### Why a separate function instead of extending `computeMetrics`?

`computeMetrics` works with `CompletedTrade[]` — it has no access to equity points.
Sharpe/Sortino need `EquityPoint[]` to compute daily returns. These are fundamentally
different inputs. Adding equity points to `computeMetrics` would increase parameter sprawl
(already flagged as a concern in the code review). A separate function keeps
responsibilities clean: `computeMetrics` = trade-level aggregates, `computeRiskMetrics` = equity-curve-based risk.

### Why daily returns, not per-trade returns?

- Sharpe is conventionally computed from periodic (daily) returns, annualized by √252
- Per-trade returns would bias toward strategies with fewer, larger trades
- Daily returns capture the full equity curve including flat periods (no-trade days count)
- With 90-day backtests, we get ~90 data points — borderline but usable with a disclaimer

### Why both Sharpe AND Sortino?

The deep-research document says "Sharpe ou equivalente". For a $100 account where drawdown
is the primary kill risk, Sortino (which only penalizes downside volatility) is arguably
more informative. Both are cheap to compute from the same daily returns array. Sortino uses
downside deviation (std of negative returns only) as the denominator.

### Formulas

```
dailyReturns[i] = (equity[dayEnd_i] - equity[dayEnd_{i-1}]) / equity[dayEnd_{i-1}]

Sharpe  = mean(dailyReturns) / std(dailyReturns) × √252
Sortino = mean(dailyReturns) / downside_std(dailyReturns) × √252

downside_std = sqrt(mean(min(dailyReturns, 0)²))
```

If std = 0 (no variance, e.g., no trades): return null.
If fewer than 2 daily returns: return null.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/backtest/src/analysis/compute-risk-metrics.ts` | CREATE | `computeRiskMetrics()` — daily returns from equity points, Sharpe, Sortino |
| `packages/backtest/src/analysis/compute-risk-metrics.test.ts` | CREATE | TDD tests for risk metrics |
| `packages/backtest/src/types/metrics.ts` | MODIFY | Add `sharpeRatio`, `sortinoRatio` to `Metrics` |
| `packages/backtest/src/run-backtest.ts` | MODIFY | Compute + display Sharpe/Sortino |
| `packages/backtest/src/compare-strategies.ts` | MODIFY | Compute + display in ranking/detail card |
| `packages/backtest/src/index.ts` | MODIFY | Export new function |
| `packages/backtest/src/analysis/run-cost-scenarios.ts` | MODIFY | Compute risk metrics per scenario |
| `packages/refiner/src/loop/stages/run-engine-in-process.ts` | MODIFY | Compute + merge into metrics |
| `packages/refiner/src/loop/stages/run-engine-child.ts` | MODIFY | Compute + merge into metrics |
| `packages/refiner/src/loop/stages/scoring.ts` | MODIFY | Display Sharpe in breakdown |
| `packages/refiner/src/loop/stages/checkpoint.ts` | MODIFY | Add Zod fields + restore |
| `packages/refiner/src/loop/stages/scoring.test.ts` | MODIFY | Add null fields to fixtures |
| `packages/refiner/src/loop/stages/checkpoint.test.ts` | MODIFY | Add null fields to fixtures |
| `packages/refiner/src/loop/loop-state.test.ts` | MODIFY | Add null fields to fixtures |
| `packages/refiner/src/automation/build-optimize-prompt.test.ts` | MODIFY | Add null fields to fixtures |

---

## Task 1: Core risk metrics function + tests

**Files:**
- Create: `packages/backtest/src/analysis/compute-risk-metrics.ts`
- Create: `packages/backtest/src/analysis/compute-risk-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// compute-risk-metrics.test.ts
import { describe, it, expect } from "vitest";
import { computeRiskMetrics } from "./compute-risk-metrics.js";
import type { EquityPoint } from "../engine/equity-curve.js";

function makeEquityPoints(dailyEquities: number[]): EquityPoint[] {
  // One point per day at midnight, simulating end-of-day equity
  const points: EquityPoint[] = [];
  const baseTime = Date.UTC(2025, 0, 1); // 2025-01-01
  for (let i = 0; i < dailyEquities.length; i++) {
    const equity = dailyEquities[i];
    const peak = Math.max(...dailyEquities.slice(0, i + 1));
    points.push({
      timestamp: baseTime + i * 86_400_000,
      barIndex: i * 96, // 96 bars per day at 15m
      equity,
      drawdown: peak > 0 ? (equity - peak) / peak : 0,
    });
  }
  return points;
}

describe("computeRiskMetrics", () => {
  it("returns null for empty equity points", () => {
    const result = computeRiskMetrics([]);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("returns null for single day (no returns possible)", () => {
    const points = makeEquityPoints([1000]);
    const result = computeRiskMetrics(points);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("returns null when all returns are zero (no variance)", () => {
    const points = makeEquityPoints([1000, 1000, 1000, 1000, 1000]);
    const result = computeRiskMetrics(points);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("computes positive Sharpe for consistently winning equity", () => {
    // Equity grows 1% per day for 30 days: 1000, 1010, 1020.1, ...
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) equities.push(equities[i - 1] * 1.01);
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sharpeRatio!).toBeGreaterThan(0);
    // 1% daily with ~0 variance → very high Sharpe
    expect(result.sharpeRatio!).toBeGreaterThan(10);
  });

  it("computes negative Sharpe for consistently losing equity", () => {
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) equities.push(equities[i - 1] * 0.99);
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sharpeRatio!).toBeLessThan(0);
  });

  it("Sortino is higher than Sharpe when losses are rare", () => {
    // 29 days of +1%, 1 day of -2%
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) {
      const growth = i === 15 ? 0.98 : 1.01;
      equities.push(equities[i - 1] * growth);
    }
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sortinoRatio).not.toBeNull();
    // Sortino penalizes only downside, so it should be higher
    // when most vol comes from upside
    expect(result.sortinoRatio!).toBeGreaterThan(result.sharpeRatio!);
  });

  it("handles multiple equity points per day (uses last per day)", () => {
    // 2 days, 3 points each (simulating intraday equity)
    const baseTime = Date.UTC(2025, 0, 1);
    const points: EquityPoint[] = [
      // Day 1: equity moves during the day
      { timestamp: baseTime, barIndex: 0, equity: 1000, drawdown: 0 },
      { timestamp: baseTime + 4 * 3_600_000, barIndex: 16, equity: 1005, drawdown: 0 },
      { timestamp: baseTime + 8 * 3_600_000, barIndex: 32, equity: 1010, drawdown: 0 },
      // Day 2: equity drops
      { timestamp: baseTime + 86_400_000, barIndex: 96, equity: 1008, drawdown: -0.002 },
      { timestamp: baseTime + 86_400_000 + 4 * 3_600_000, barIndex: 112, equity: 995, drawdown: -0.015 },
      { timestamp: baseTime + 86_400_000 + 8 * 3_600_000, barIndex: 128, equity: 998, drawdown: -0.012 },
    ];
    const result = computeRiskMetrics(points);

    // Should use day-end equities: 1010 (day 1) and 998 (day 2)
    // Daily return: (998 - 1010) / 1010 ≈ -0.01188
    // Only 1 return → null (need ≥ 2 returns for std)
    expect(result.sharpeRatio).toBeNull();
  });

  it("uses 252 annualization factor", () => {
    // Construct equity with known mean/std of daily returns
    // If mean = 0.001 (0.1%/day) and std = 0.01 (1%/day):
    // Sharpe ≈ 0.001 / 0.01 × √252 ≈ 1.587
    const equities: number[] = [1000];
    // Alternate: +1.1% and -0.9% → mean ≈ 0.1%, std ≈ 1%
    for (let i = 1; i <= 60; i++) {
      const ret = i % 2 === 1 ? 1.011 : 0.991;
      equities.push(equities[i - 1] * ret);
    }
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    // Should be roughly 1.5-1.6 range (mean ~0.1%, std ~1%)
    expect(result.sharpeRatio!).toBeGreaterThan(1.0);
    expect(result.sharpeRatio!).toBeLessThan(2.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/backtest/src/analysis/compute-risk-metrics.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// compute-risk-metrics.ts
import type { EquityPoint } from "../engine/equity-curve.js";

export interface RiskMetrics {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
}

const ANNUALIZATION_FACTOR = Math.sqrt(252);

/**
 * Compute Sharpe and Sortino ratios from equity curve points.
 *
 * Groups equity points by calendar day (UTC), takes the last equity
 * value per day, then computes daily returns.
 *
 * Sharpe  = mean(dailyReturns) / std(dailyReturns) × √252
 * Sortino = mean(dailyReturns) / downside_std(dailyReturns) × √252
 */
export function computeRiskMetrics(equityPoints: EquityPoint[]): RiskMetrics {
  const nullResult: RiskMetrics = { sharpeRatio: null, sortinoRatio: null };

  if (equityPoints.length === 0) return nullResult;

  // Group by calendar day (UTC), keep last equity per day
  const dailyEquity = new Map<string, number>();
  for (const point of equityPoints) {
    const day = new Date(point.timestamp).toISOString().slice(0, 10);
    dailyEquity.set(day, point.equity);
  }

  const equities = [...dailyEquity.values()];
  if (equities.length < 2) return nullResult;

  // Compute daily returns
  const returns: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    if (equities[i - 1] === 0) continue;
    returns.push((equities[i] - equities[i - 1]) / equities[i - 1]);
  }

  if (returns.length < 2) return nullResult;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Standard deviation
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return nullResult;

  const sharpeRatio = (mean / std) * ANNUALIZATION_FACTOR;

  // Downside deviation (only negative returns)
  const downsideVariance = returns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / returns.length;
  const downsideStd = Math.sqrt(downsideVariance);

  const sortinoRatio = downsideStd > 0
    ? (mean / downsideStd) * ANNUALIZATION_FACTOR
    : null;

  return { sharpeRatio, sortinoRatio };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/backtest/src/analysis/compute-risk-metrics.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backtest/src/analysis/compute-risk-metrics.ts packages/backtest/src/analysis/compute-risk-metrics.test.ts
git commit -m "feat(backtest): add Sharpe and Sortino ratio computation from equity curve"
```

---

## Task 2: Extend Metrics type + propagate to call sites

**Files:**
- Modify: `packages/backtest/src/types/metrics.ts` — add 2 fields
- Modify: `packages/backtest/src/index.ts` — export new function
- Modify: `packages/backtest/src/run-backtest.ts` — compute + merge + display
- Modify: `packages/backtest/src/compare-strategies.ts` — compute + merge + display
- Modify: `packages/backtest/src/analysis/run-cost-scenarios.ts` — compute per scenario

- [ ] **Step 1: Add fields to Metrics**

In `packages/backtest/src/types/metrics.ts`, add after `totalCostPct`:

```typescript
  // Risk metrics (equity-curve based)
  sharpeRatio: number | null;
  sortinoRatio: number | null;
```

- [ ] **Step 2: Update `computeMetrics` to include null defaults**

In `packages/backtest/src/analysis/metrics-calculator.ts`, add to both the empty-trades return
and the main return object:

```typescript
  sharpeRatio: null,
  sortinoRatio: null,
```

These are always null from `computeMetrics` — they get merged from `computeRiskMetrics` at call sites.

- [ ] **Step 3: Export from barrel**

In `packages/backtest/src/index.ts`, add:

```typescript
export { computeRiskMetrics } from "./analysis/compute-risk-metrics.js";
export type { RiskMetrics } from "./analysis/compute-risk-metrics.js";
```

- [ ] **Step 4: Update `run-backtest.ts`**

Import `computeRiskMetrics` and after `computeMetrics`, merge:

```typescript
import { computeRiskMetrics } from "./analysis/compute-risk-metrics.js";

// After computeMetrics line:
const riskMetrics = computeRiskMetrics(result.equityPoints);
const metrics = { ...rawMetrics, ...riskMetrics };
```

Add display after the cost-aware line:

```typescript
console.log(`Sharpe: ${metrics.sharpeRatio?.toFixed(2) ?? "N/A"} | Sortino: ${metrics.sortinoRatio?.toFixed(2) ?? "N/A"}`);
```

- [ ] **Step 5: Update `compare-strategies.ts`**

Same pattern: import, compute, merge, display in detail card.

- [ ] **Step 6: Update `run-cost-scenarios.ts`**

Import `computeRiskMetrics`. After computing metrics in the scenario loop, merge:

```typescript
import { computeRiskMetrics } from "./compute-risk-metrics.js";

// Inside the for loop, after computeMetrics:
const riskMetrics = computeRiskMetrics(result.equityPoints);
const metrics = { ...rawMetrics, ...riskMetrics };
```

- [ ] **Step 7: Run backtest tests**

Run: `npx vitest run packages/backtest/src/analysis/`
Expected: all pass (existing tests use `computeMetrics` which now returns null for the 2 new fields — backward compat)

- [ ] **Step 8: Commit**

```bash
git add packages/backtest/src/
git commit -m "feat(backtest): integrate Sharpe/Sortino into Metrics and display in CLI"
```

---

## Task 3: Propagate to refiner

**Files:**
- Modify: `packages/refiner/src/loop/stages/run-engine-in-process.ts`
- Modify: `packages/refiner/src/loop/stages/run-engine-child.ts`
- Modify: `packages/refiner/src/loop/stages/scoring.ts` — display in breakdown
- Modify: `packages/refiner/src/loop/stages/checkpoint.ts` — Zod schema + restore
- Modify: `packages/refiner/src/loop/stages/scoring.test.ts` — add null fields
- Modify: `packages/refiner/src/loop/stages/checkpoint.test.ts` — add null fields
- Modify: `packages/refiner/src/loop/loop-state.test.ts` — add null fields
- Modify: `packages/refiner/src/automation/build-optimize-prompt.test.ts` — add null fields

- [ ] **Step 1: Update `run-engine-in-process.ts`**

After `computeMetrics`, compute risk metrics and merge:

```typescript
import { computeRiskMetrics } from "@breaker/backtest";

const rawMetrics = computeMetrics(result.trades, result.maxDrawdownPct, tradingDaysFromCandles(candles), backtestConfig.initialCapital);
const riskMetrics = computeRiskMetrics(result.equityPoints);
const metrics = { ...rawMetrics, ...riskMetrics };
```

- [ ] **Step 2: Update `run-engine-child.ts`**

Same pattern inside the try block.

- [ ] **Step 3: Update `scoring.ts` breakdown**

Add Sharpe to the `costAwareParts` array:

```typescript
metrics.sharpeRatio != null ? `Sharpe: ${metrics.sharpeRatio.toFixed(2)}` : null,
```

- [ ] **Step 4: Update `checkpoint.ts`**

Add to Zod schema:

```typescript
sharpeRatio: z.number().nullable().optional(),
sortinoRatio: z.number().nullable().optional(),
```

Add to metrics reconstruction:

```typescript
sharpeRatio: raw.sharpeRatio ?? null,
sortinoRatio: raw.sortinoRatio ?? null,
```

- [ ] **Step 5: Update test fixtures**

Add `sharpeRatio: null, sortinoRatio: null` to every `Metrics` literal in:
- `scoring.test.ts` (goodMetrics + ~7 inline literals)
- `checkpoint.test.ts` (sampleMetrics)
- `loop-state.test.ts` (makeMetrics)
- `build-optimize-prompt.test.ts` (~12 makeMetrics helpers)

- [ ] **Step 6: Build and test all**

```bash
pnpm build && pnpm test && pnpm typecheck
```

Expected: all pass, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/refiner/src/ packages/backtest/src/
git commit -m "feat(refiner): propagate Sharpe/Sortino to scoring breakdown and checkpoints"
```

---

## Task 4: Smoke test with real data

- [ ] **Step 1: Run BTC backtest and verify Sharpe output**

```bash
node packages/backtest/dist/run-backtest.js BTC --days 90 --strategy short-range
```

Check output includes: `Sharpe: X.XX | Sortino: X.XX`

- [ ] **Step 2: Run with stress test and verify per-scenario Sharpe**

```bash
node packages/backtest/dist/run-backtest.js BTC --days 90 --strategy short-range --stress
```

Verify stress test table (if Sharpe is shown per scenario) or at least that base metrics include it.

- [ ] **Step 3: Validate Sharpe sign matches PnL sign**

Positive PnL → positive Sharpe, negative PnL → negative Sharpe. Cross-check with at least 2 strategies.

- [ ] **Step 4: Validate Sortino ≥ Sharpe for strategies with asymmetric returns**

For a winning strategy (more upside than downside), Sortino should be ≥ Sharpe.
