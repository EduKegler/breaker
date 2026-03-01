---
name: new-indicator
description: Scaffold a new technical indicator. Use when the user says "new indicator", "novo indicador", "cria indicador", "add indicator", "adiciona indicador", or wants to create a new indicator.
argument-hint: "[indicator-name]"
disable-model-invocation: true
allowed-tools: "Bash, Read, Glob, Grep, Edit, Write"
---

# Scaffold New Indicator

Create boilerplate for a new technical indicator in the backtest package.

## Templates (read these first)

Before generating code, **read these reference files** to match existing patterns:

- `packages/backtest/src/indicators/ema.ts` — simple indicator (returns `number[]`)
- `packages/backtest/src/indicators/donchian.ts` — composite indicator (returns interface with multiple arrays)
- `packages/backtest/src/indicators/ema.test.ts` — test for simple indicator
- `packages/backtest/src/indicators/donchian.test.ts` — test for composite indicator
- `packages/backtest/src/index.ts` — barrel exports

## Steps

### 1. Get indicator name

From `$ARGUMENTS`, extract the indicator name in kebab-case (e.g. `bollinger-bands`).

If not provided, ask the user for:
- Indicator name (kebab-case)
- Whether it returns a single array (`number[]`) or a composite result (interface with multiple arrays)

Derive:
- `kebabName` = e.g. `bollinger-bands`
- `camelName` = e.g. `bollingerBands`
- `PascalName` = e.g. `BollingerBands` (only if composite)

### 2. Create indicator file

**File**: `packages/backtest/src/indicators/{kebabName}.ts`

**For simple indicators** (returns `number[]`), follow `ema.ts`:

```typescript
/**
 * Calculate {IndicatorName}.
 * Returns an array of the same length as input.
 * First `period - 1` values are NaN (warmup).
 */
export function {camelName}(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  // Implementation
  return result;
}
```

**For composite indicators** (returns interface), follow `donchian.ts`:

```typescript
export interface {PascalName}Result {
  upper: number[];
  lower: number[];
  mid: number[];
}

/**
 * Calculate {IndicatorName}.
 * Returns arrays of the same length as input.
 * First `period - 1` values are NaN (warmup).
 */
export function {camelName}(candles: Candle[], period: number): {PascalName}Result {
  // Implementation
}
```

**Key requirements**:
- Pure function (no side effects, no state)
- Output arrays same length as input
- NaN for warmup period (first `period - 1` values)
- Accept `number[]` for simple indicators or `Candle[]` for those needing OHLC

### 3. Create test file

**File**: `packages/backtest/src/indicators/{kebabName}.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { {camelName} } from "./{kebabName}.js";

describe("{camelName}", () => {
  it("should return NaN for warmup period", () => {
    const result = {camelName}([...values], period);
    for (let i = 0; i < period - 1; i++) {
      expect(result[i]).toBeNaN();
    }
  });

  it("should return same length as input", () => {
    const result = {camelName}([...values], period);
    expect(result).toHaveLength(values.length);
  });

  it("should compute correct values", () => {
    // Known values from a trusted source (TradingView, Excel, etc.)
    const result = {camelName}([...values], period);
    expect(result[period]).toBeCloseTo(expected, 2);
  });
});
```

### 4. Add barrel export

**Edit**: `packages/backtest/src/index.ts`

Add in the `// Indicators` section:
```typescript
export { {camelName} } from "./indicators/{kebabName}.js";
```

If composite, also export the result type:
```typescript
export type { {PascalName}Result } from "./indicators/{kebabName}.js";
```

### 5. Build and test

```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/backtest build && pnpm --filter @breaker/backtest test
```

### 6. Summary

Report what was created:
- Indicator file: `packages/backtest/src/indicators/{kebabName}.ts`
- Test file: `packages/backtest/src/indicators/{kebabName}.test.ts`
- Updated: `index.ts` (export)
- Remind the user to verify against a trusted data source (TradingView, Excel)
