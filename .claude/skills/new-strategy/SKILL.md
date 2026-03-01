---
name: new-strategy
description: Scaffold a new trading strategy with all boilerplate. Use when the user says "new strategy", "nova estrategia", "cria estrategia", "scaffold strategy", "add strategy", "adiciona estrategia", or wants to create a new strategy from scratch.
argument-hint: "[strategy-name]"
disable-model-invocation: true
allowed-tools: "Bash, Read, Glob, Grep, Edit, Write"
---

# Scaffold New Strategy

Create all boilerplate for a new trading strategy across the monorepo.

## Templates (read these first)

Before generating code, **read these reference files** to match existing patterns exactly:

- `packages/backtest/src/strategies/donchian-adx.ts` — strategy implementation template
- `packages/backtest/src/strategies/donchian-adx.test.ts` — test template
- `packages/backtest/src/index.ts` — barrel exports
- `packages/refiner/src/lib/strategy-registry.ts` — refiner registry
- `packages/exchange/src/daemon.ts` (lines 42-53) — daemon switch case

## Steps

### 1. Get strategy name

From `$ARGUMENTS`, extract the strategy name in kebab-case (e.g. `bollinger-squeeze`).

If not provided, ask the user for:
- Strategy name (kebab-case)
- Brief description (entry/exit logic)

Derive:
- `kebabName` = e.g. `bollinger-squeeze`
- `PascalName` = e.g. `BollingerSqueeze`
- `camelName` = e.g. `bollingerSqueeze`
- `factoryName` = `create{PascalName}` (e.g. `createBollingerSqueeze`)

### 2. Create strategy file

**File**: `packages/backtest/src/strategies/{kebabName}.ts`

Follow the pattern from `donchian-adx.ts`:

```typescript
import type { Candle } from "../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../types/strategy.js";
// ... indicator imports

interface {PascalName}Params {
  // Each param with StrategyParam type
  param1: StrategyParam;
}

const DEFAULT_PARAMS: {PascalName}Params = {
  param1: { value: 14, min: 5, max: 30, step: 1, optimizable: true, description: "..." },
};

export function {factoryName}(
  paramOverrides?: Partial<Record<keyof {PascalName}Params, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof {PascalName}Params];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator caches
  // let indicatorCache: ... = null;

  return {
    name: "COIN TF Category — Strategy Name",  // User fills this in
    params,
    requiredTimeframes: [],  // e.g. ["1h", "1d"]
    requiredWarmup: { source: 50 },  // minimum candles per timeframe

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      // Compute indicator caches
    },

    onCandle(ctx: StrategyContext): Signal | null {
      // Entry logic — return Signal or null
      return null;
    },

    getExitLevel(ctx: StrategyContext): number | undefined {
      // Trailing exit level (optional)
      return undefined;
    },

    shouldExit(ctx: StrategyContext): boolean {
      // Additional exit conditions (timeout, etc.)
      return false;
    },
  };
}
```

**Key requirements**:
- Interface `{PascalName}Params` with `StrategyParam` for each parameter
- `DEFAULT_PARAMS` with min/max/step/optimizable/description
- Factory function with `paramOverrides` support
- Indicator caches in closure scope (populated by `init()`)
- `requiredWarmup` must be set correctly (candles needed before valid signals)
- Signals must include: `direction`, `entryPrice`, `stopLoss`, `takeProfits[]`, `comment`

### 3. Create test file

**File**: `packages/backtest/src/strategies/{kebabName}.test.ts`

Follow the pattern from `donchian-adx.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { {factoryName} } from "./{kebabName}.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Candle } from "../types/candle.js";

// Candle generators: makeCandle, generate15mCandles, generate1hCandles, generate1dCandles
// (copy from donchian-adx.test.ts)

describe("{factoryName}", () => {
  it("should return null during warmup", () => { ... });
  it("should create strategy with default params", () => { ... });
  it("should accept param overrides", () => { ... });
  // Add strategy-specific signal tests
});
```

### 4. Add barrel export

**Edit**: `packages/backtest/src/index.ts`

Add in the `// Strategies` section:
```typescript
export { {factoryName} } from "./strategies/{kebabName}.js";
```

### 5. Add daemon switch case

**Edit**: `packages/exchange/src/daemon.ts`

In the `createStrategy()` switch (around line 43), add:
```typescript
case "{kebabName}":
  return {factoryName}();
```

Also add the import at the top of the file.

### 6. Add refiner registry entry

**Edit**: `packages/refiner/src/lib/strategy-registry.ts`

Add import and registry entry:
```typescript
import { {factoryName} } from "@breaker/backtest";
// In REGISTRY:
{factoryName},
```

### 7. Build and test

```bash
cd /Users/edu/Projects/trading && pnpm build && pnpm test
```

If tests fail, fix the issues before completing.

### 8. Summary

Report what was created:
- Strategy file: `packages/backtest/src/strategies/{kebabName}.ts`
- Test file: `packages/backtest/src/strategies/{kebabName}.test.ts`
- Updated: `index.ts` (export), `daemon.ts` (switch), `strategy-registry.ts` (registry)
- Remind the user to implement the actual entry/exit logic in the strategy file
