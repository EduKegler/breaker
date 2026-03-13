import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import {
  buildModuleContext,
  extractFixedRules,
  extractCandidatesFromTable,
  extractComponentCatalog,
  extractVariableBudget,
  extractStartingPoint,
  getStartingComponents,
  getKbSection,
  MODULE_CRITERIA,
  CANDIDATE_SLUGS,
  candidateToSlug,
  computeStretchCriteria,
} from "./build-module-context.js";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

import fs from "node:fs";

const SAMPLE_KB = `
## 3. Module 1: Breakout

> **Signal TF:** 15m | **Regime TF:** 4H or Daily

### 3.1 Fixed rules (BREAKER cannot change)

1. **Max free variables:** 8
2. **HTF regime filter:** mandatory.
3. **Volume confirmation:** mandatory.

### 3.2 Strategy candidates

**Recommended first iteration (starting point, not mandatory):**

> Donchian(20) + EMA(200) Daily direction [FIXED] + Volume > 1.5x SMA(vol, 20) on breakout bar + ATR(14) 1H stop x 3.0 + Timeout 48 bars (12h) + TP at 2R.
> 5 free vars: (1) Donchian period, (2) vol multiplier, (3) ATR stop multiplier, (4) timeout bars, (5) TP R:R.

**Variable budget (8 max):**

| Component | Typical vars | Example |
|-----------|-------------|---------|
| Entry signal | 1-2 | Donchian period |
| Regime filter | 0-1 | EMA period |
| Volume confirmation (rule 3) | 1 | multiplier |
| ATR stop | 1 | multiplier |
| Timeout | 1 | bars |
| **Typical total** | **6-8** | Fix regime filter to stay in budget |

**Direction constraint candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Both | Trade both long and short | Default |
| Long only | Longs only, skip all short signals | Directional filter |
| Short only | Shorts only, skip all long signals | Directional filter |

**Entry signal candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Donchian Channel | New high/low breakout above/below N-period channel | Classic |
| BB squeeze release | BB contracts inside KC, then expands | Compression detector |
| Opening Range Breakout (ORB) | Define high/low of first N minutes | Session-based |

**Entry timing candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Breakout close | Enter at candle close beyond level | Faster entry |
| Retest entry | Wait for pullback to level | Fewer fakeouts |

**Regime filter candidates (pick one, then lock per RESTRUCTURE):**

| Approach | Timeframe | What it does | Tunable params |
|----------|-----------|-------------|----------------|
| EMA direction | Daily or 4H | Breakout aligns with trend | EMA period(s) |
| ADX threshold | 4H | Low ADX = consolidation | ADX period, threshold |

**Optional confirmation filter (max 1 -- volume is already mandatory via fixed rule 3):**

| Approach | How it works | Notes |
|----------|-------------|-------|
| RSI momentum | RSI(14) > 50 for longs | Confirms momentum |
| MACD alignment | MACD histogram positive/negative | Trend momentum |

**Exit candidates:**

| Approach | What it does | Typical range | Vars consumed |
|----------|-------------|---------------|---------------|
| Trailing channel (Donchian fast) | Exit on retracement | Period: 5-15 bars | 1 |
| ATR trailing stop | Stop follows price at N x ATR | N: 1.5-4.0 | 1 |
| Time-based timeout | Forced exit after N bars | N: 24-96 bars | 1 |
| Partial TP + trail | TP1 at R:R (partial close), TP2 or trail for remainder | TP1 25-50% at 0.5-2R, trail rest | 2-3 |

---

## 4. Module 2: Mean Reversion

### 4.1 Fixed rules (BREAKER cannot change)

1. **Max free variables:** 6
2. **Band-based entry:** mandatory.

### 4.2 Strategy candidates

**Recommended first iteration (starting point, not mandatory):**

> Keltner Channels(20, 2.0) on 15m + RSI(2) < 20 for longs / > 85 for shorts + ADX(14) < 25 on 1H as regime gate.
> 6 free vars: (1) KC period, (2) KC ATR multiplier, (3) RSI threshold long, (4) RSI threshold short, (5) ADX threshold, (6) timeout bars.

**Variable budget (6 max):**

| Component | Typical vars | Example |
|-----------|-------------|---------|
| Band/channel (extreme) | 1-2 | BB period + multiplier |
| Exhaustion confirmation | 1-2 | RSI threshold long + short |
| Regime filter | 1-2 | ADX period + threshold |
| Timeout | 1 | bars |
| Catastrophic stop (optional) | 0-1 | ATR multiplier |
| **Typical total** | **4-6** | At cap with all components |

**Band/channel candidates (defines "extreme"):**

| Approach | How it works | Typical range | Notes |
|----------|-------------|---------------|-------|
| Bollinger Bands | SMA(N) +/- K * std dev | N: 14-30 | Classic |
| Keltner Channels | EMA(N) +/- K * ATR | N: 14-30 | Smoother |

**Exhaustion confirmation candidates (pick max 1):**

| Approach | How it works | Typical range | Notes |
|----------|-------------|---------------|-------|
| RSI(2) | Ultra-short RSI | Period: 2 | Connors canonical |
| Williams %R | Close relative to range | Period: 2-5 | Faster than RSI |

**Regime filter candidates (pick one, then lock per RESTRUCTURE):**

| Approach | Timeframe | What it does | Tunable params | Notes |
|----------|-----------|-------------|----------------|-------|
| ADX threshold (low) | 1H | ADX < threshold = ranging | ADX period, threshold | Most cited |

**Exit candidates:**

| Approach | What it does | Typical range | Vars consumed | Notes |
|----------|-------------|---------------|---------------|-------|
| Channel midline | Exit at center of band | -- | 0 | Conservative |
| Opposite band | Exit at opposite extreme | -- | 0 | Aggressive |
| Timeout | Forced exit after N bars | N: 12-48 | 1 | Safety net |

---

## 6. Module 4: Trend Following

### 6.1 Fixed rules (BREAKER cannot change)

1. **Max free variables:** 6
2. **Regime filter:** mandatory (ADX-based).

### 6.2 Strategy candidates

**Variable budget (6 max):**

| Component | Typical vars | Example |
|-----------|-------------|---------|
| Trend signal (entry trigger) | 1-2 | SuperTrend params; MA crossover periods |
| Regime filter (ADX) | 1 | ADX threshold (period fixed at 14) |
| Stop loss (ATR-based) | 1 | ATR multiplier |
| Trailing exit | 0-1 | SuperTrend flip (0 vars); Chandelier (1-2 vars) |
| Timeout | 1 | days/bars |
| **Typical total** | **5-6** | Tight budget forces simplicity |

**Direction constraint candidates:**

| Approach | How it works | Notes |
|----------|-------------|-------|
| Both | Trade both long and short | Default |
| Long only | Longs only, skip all short signals | BTC structural drift |
| Short only | Shorts only, skip all long signals | Test separately |

**Entry signal candidates (pick one architecture, then lock per RESTRUCTURE):**

| Approach | How it works | Notes |
|----------|-------------|-------|
| SuperTrend flip | Price crosses SuperTrend line | Simplest entry |
| MA crossover | Fast MA crosses slow MA | Classic trend signal |
| Price channel breakout | New N-period high/low | Turtle-style |

**Regime filter candidates:**

| Approach | Timeframe | What it does | Tunable params |
|----------|-----------|-------------|----------------|
| ADX threshold | Daily | ADX > threshold = trending | ADX threshold |

**Trailing exit candidates:**

| Approach | What it does | Typical range | Vars consumed |
|----------|-------------|---------------|---------------|
| SuperTrend flip | Exit on opposite flip | -- | 0 |
| Chandelier Exit | ATR-based trailing stop | ATR mult: 2-4 | 1-2 |
`;

describe("extractFixedRules", () => {
  it("extracts M1 fixed rules from KB content", () => {
    const result = extractFixedRules(SAMPLE_KB, 3);
    expect(result).toContain("Max free variables:** 8");
    expect(result).toContain("HTF regime filter");
    expect(result).toContain("Volume confirmation");
    // Should NOT include strategy candidates
    expect(result).not.toContain("Strategy candidates");
  });

  it("extracts M2 fixed rules from KB content", () => {
    const result = extractFixedRules(SAMPLE_KB, 4);
    expect(result).toContain("Max free variables:** 6");
    expect(result).toContain("Band-based entry");
  });

  it("returns placeholder when section not found", () => {
    const result = extractFixedRules(SAMPLE_KB, 99);
    expect(result).toBe("(fixed rules not found in KB)");
  });

  it("returns placeholder for empty KB content", () => {
    const result = extractFixedRules("", 3);
    expect(result).toBe("(fixed rules not found in KB)");
  });
});

describe("buildModuleContext", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_KB);
  });

  it("maps breakout → M1", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.moduleId).toBe("M1");
    expect(ctx.moduleName).toBe("Breakout");
    expect(ctx.profile).toBe("breakout");
    expect(ctx.regimeTF).toBe("4H or Daily");
  });

  it("maps mean-reversion → M2", () => {
    const ctx = buildModuleContext(
      { strategy: "mean-reversion", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.moduleId).toBe("M2");
    expect(ctx.moduleName).toBe("Mean Reversion");
    expect(ctx.regimeTF).toBe("1H");
  });

  it("maps pullback → M3", () => {
    const ctx = buildModuleContext(
      { strategy: "pullback", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.moduleId).toBe("M3");
    expect(ctx.moduleName).toBe("Pullback");
    expect(ctx.regimeTF).toBe("4H");
  });

  it("maps trend-following → M4", () => {
    const ctx = buildModuleContext(
      { strategy: "trend-following", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.moduleId).toBe("M4");
    expect(ctx.moduleName).toBe("Trend Following");
    expect(ctx.regimeTF).toBe("Daily");
  });

  it("uses maxFreeVariables from criteria when available", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: { maxFreeVariables: 5 } },
      "/fake/kb.md",
    );
    expect(ctx.varCap).toBe(5);
  });

  it("falls back to default varCap when maxFreeVariables undefined", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.varCap).toBe(8); // M1 default

    const ctx2 = buildModuleContext(
      { strategy: "mean-reversion", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx2.varCap).toBe(6); // M2 default
  });

  it("uses signalTF from interval", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "1h", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.signalTF).toBe("1h");
  });

  it("extracts fixedRules from KB", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.fixedRules).toContain("Max free variables:** 8");
  });

  it("formats stoppingCriteria correctly", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.stoppingCriteria).toContain("Trades >= 50");
    expect(ctx.stoppingCriteria).toContain("PF >= 1.3");
    expect(ctx.stoppingCriteria).toContain("DD <= 10%");
    expect(ctx.stoppingCriteria).toContain("avgR >= 0.15");
    expect(ctx.stoppingCriteria).not.toContain("WR >=");
  });

  it("includes WR gate for M2 stopping criteria", () => {
    const ctx = buildModuleContext(
      { strategy: "mean-reversion", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.stoppingCriteria).toContain("WR >= 50%");
  });

  it("includes expectedTradesPerYear in M4 stopping criteria", () => {
    const ctx = buildModuleContext(
      { strategy: "trend-following", interval: "4H", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.stoppingCriteria).toContain("Expected trade frequency: 10-20 trades/year");
  });

  it("uses restructureLocks from paramHistory", () => {
    const ctx = buildModuleContext(
      {
        strategy: "breakout",
        interval: "15m",
        criteria: {},
        paramHistory: { restructureLocks: "band: Donchian, regime: EMA" },
      },
      "/fake/kb.md",
    );
    expect(ctx.restructureLocks).toBe("band: Donchian, regime: EMA");
  });

  it("defaults restructureLocks to empty string", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.restructureLocks).toBe("");
  });

  it("throws for unknown strategy profile", () => {
    expect(() =>
      buildModuleContext(
        { strategy: "unknown-strategy", interval: "15m", criteria: {} },
        "/fake/kb.md",
      ),
    ).toThrow(/Unknown strategy profile/);
  });

  it("handles KB file not found gracefully", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/nonexistent/kb.md",
    );
    expect(ctx.fixedRules).toBe("(fixed rules not found in KB)");
  });
});

describe("MODULE_CRITERIA", () => {
  it("has entries for all 4 modules", () => {
    expect(MODULE_CRITERIA).toHaveProperty("M1");
    expect(MODULE_CRITERIA).toHaveProperty("M2");
    expect(MODULE_CRITERIA).toHaveProperty("M3");
    expect(MODULE_CRITERIA).toHaveProperty("M4");
  });

  it("M2 has mandatory WR gate", () => {
    expect(MODULE_CRITERIA.M2.minWR).toBe(50);
  });

  it("M1 has no WR gate", () => {
    expect(MODULE_CRITERIA.M1.minWR).toBeNull();
  });

  it("M4 has expected trade frequency 10-20/year", () => {
    expect(MODULE_CRITERIA.M4.expectedTradesPerYear).toEqual({ min: 10, max: 20 });
  });

  it("all modules have expectedTradesPerYear defined", () => {
    for (const [id, mc] of Object.entries(MODULE_CRITERIA)) {
      expect(mc.expectedTradesPerYear).toBeDefined();
      expect(mc.expectedTradesPerYear!.min).toBeLessThan(mc.expectedTradesPerYear!.max);
    }
  });
});

describe("extractCandidatesFromTable", () => {
  it("extracts M1 entry signal candidates with slugs", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Entry signal candidates");
    expect(candidates).toHaveLength(3);
    expect(candidates[0].name).toBe("Donchian Channel");
    expect(candidates[0].slug).toBe("donchian");
    expect(candidates[1].name).toBe("BB squeeze release");
    expect(candidates[1].slug).toBe("squeeze");
    expect(candidates[2].name).toBe("Opening Range Breakout (ORB)");
    expect(candidates[2].slug).toBe("orb");
  });

  it("extracts M1 direction constraint candidates with slugs", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Direction constraint candidates");
    expect(candidates).toHaveLength(3);
    expect(candidates[0].name).toBe("Both");
    expect(candidates[0].slug).toBe("both");
    expect(candidates[1].name).toBe("Long only");
    expect(candidates[1].slug).toBe("long");
    expect(candidates[2].name).toBe("Short only");
    expect(candidates[2].slug).toBe("short");
  });

  it("extracts descriptions from second column", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Entry signal candidates");
    expect(candidates[0].description).toContain("New high/low breakout");
  });

  it("extracts M1 regime filter candidates", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Regime filter candidates");
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].name).toBe("EMA direction");
    expect(candidates[1].name).toBe("ADX threshold");
  });

  it("extracts M2 band/channel candidates", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Band/channel candidates");
    expect(candidates).toHaveLength(2);
    expect(candidates[0].name).toBe("Bollinger Bands");
    expect(candidates[1].name).toBe("Keltner Channels");
  });

  it("returns empty array for nonexistent header", () => {
    const candidates = extractCandidatesFromTable(SAMPLE_KB, "Nonexistent candidates");
    expect(candidates).toEqual([]);
  });

  it("returns empty array for empty KB", () => {
    const candidates = extractCandidatesFromTable("", "Entry signal candidates");
    expect(candidates).toEqual([]);
  });

  it("strips markdown links from descriptions", () => {
    const kb = `**Test candidates:**

| Approach | How it works |
|----------|-------------|
| Foo | Uses [some method](https://example.com) for trading |
`;
    const candidates = extractCandidatesFromTable(kb, "Test candidates");
    expect(candidates[0].description).toBe("Uses some method for trading");
  });
});

describe("extractComponentCatalog", () => {
  it("extracts all M1 slots including Direction", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const slotNames = catalog.slots.map((s) => s.slotName);
    expect(slotNames).toContain("Direction");
    expect(slotNames).toContain("Entry Signal");
    expect(slotNames).toContain("Entry Timing");
    expect(slotNames).toContain("Regime Filter");
    expect(slotNames).toContain("Exit");
  });

  it("extracts correct candidate count per M1 slot", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const dirSlot = catalog.slots.find((s) => s.slotName === "Direction");
    expect(dirSlot!.candidates).toHaveLength(3);

    const entrySlot = catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot!.candidates).toHaveLength(3);

    const timingSlot = catalog.slots.find((s) => s.slotName === "Entry Timing");
    expect(timingSlot!.candidates).toHaveLength(2);

    const exitSlot = catalog.slots.find((s) => s.slotName === "Exit");
    expect(exitSlot!.candidates).toHaveLength(4);
  });

  it("extracts all M2 slots", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M2");
    const slotNames = catalog.slots.map((s) => s.slotName);
    expect(slotNames).toContain("Band/Channel");
    expect(slotNames).toContain("Exhaustion");
    expect(slotNames).toContain("Exit");
  });

  it("returns empty catalog for unknown module", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M99");
    expect(catalog.slots).toEqual([]);
  });

  it("returns empty catalog for empty KB", () => {
    const catalog = extractComponentCatalog("", "M1");
    expect(catalog.slots).toEqual([]);
  });

  it("skips slots with no candidates in KB", () => {
    // M1 Confirmation slot requires "Optional confirmation filter" header
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const confSlot = catalog.slots.find((s) => s.slotName === "Confirmation");
    expect(confSlot!.candidates).toHaveLength(2);
  });

  it("marks M1 Entry Timing and Confirmation as optional, Direction as required", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const dirSlot = catalog.slots.find((s) => s.slotName === "Direction");
    const timingSlot = catalog.slots.find((s) => s.slotName === "Entry Timing");
    const confSlot = catalog.slots.find((s) => s.slotName === "Confirmation");
    const entrySlot = catalog.slots.find((s) => s.slotName === "Entry Signal");
    const exitSlot = catalog.slots.find((s) => s.slotName === "Exit");

    expect(dirSlot!.optional).toBeUndefined();
    expect(timingSlot!.optional).toBe(true);
    expect(confSlot!.optional).toBe(true);
    expect(entrySlot!.optional).toBeUndefined();
    expect(exitSlot!.optional).toBeUndefined();
  });

  it("M2 slots are all required (no optional)", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M2");
    for (const slot of catalog.slots) {
      expect(slot.optional).toBeUndefined();
    }
  });
});

describe("extractVariableBudget", () => {
  it("extracts variable budget from M1 section", () => {
    const budget = extractVariableBudget(SAMPLE_KB);
    expect(budget.get("entry signal")).toBe("1-2");
    expect(budget.get("regime filter")).toBe("0-1");
  });

  it("skips the 'Typical total' row", () => {
    const budget = extractVariableBudget(SAMPLE_KB);
    const keys = [...budget.keys()];
    expect(keys.some((k) => k.includes("typical total"))).toBe(false);
  });

  it("returns empty map when no budget table", () => {
    const budget = extractVariableBudget("no tables here");
    expect(budget.size).toBe(0);
  });
});

describe("extractComponentCatalog with variable budget", () => {
  it("attaches typicalVars to M1 Entry Signal slot", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const entrySlot = catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot!.typicalVars).toBe("1-2");
  });

  it("attaches typicalVars to M1 Regime Filter slot", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M1");
    const regimeSlot = catalog.slots.find((s) => s.slotName === "Regime Filter");
    expect(regimeSlot!.typicalVars).toBe("0-1");
  });
});

describe("extractComponentCatalog with M2 variable budget aliases", () => {
  it("attaches typicalVars to M2 Exit slot via 'timeout' alias", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M2");
    const exitSlot = catalog.slots.find((s) => s.slotName === "Exit");
    expect(exitSlot).toBeDefined();
    expect(exitSlot!.typicalVars).toBe("1");
  });

  it("attaches typicalVars to M2 Exhaustion slot via 'exhaustion confirmation' alias", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M2");
    const exhSlot = catalog.slots.find((s) => s.slotName === "Exhaustion");
    expect(exhSlot).toBeDefined();
    expect(exhSlot!.typicalVars).toBe("1-2");
  });
});

describe("extractComponentCatalog with M4 variable budget aliases", () => {
  it("attaches typicalVars to M4 Entry Signal via 'trend signal (entry trigger)' alias", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M4");
    const entrySlot = catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot).toBeDefined();
    expect(entrySlot!.typicalVars).toBe("1-2");
  });

  it("attaches typicalVars to M4 Trailing Exit via direct match", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M4");
    const trailSlot = catalog.slots.find((s) => s.slotName === "Trailing Exit");
    expect(trailSlot).toBeDefined();
    expect(trailSlot!.typicalVars).toBe("0-1");
  });

  it("extracts all M4 slots including Direction", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M4");
    const slotNames = catalog.slots.map((s) => s.slotName);
    expect(slotNames).toContain("Direction");
    expect(slotNames).toContain("Entry Signal");
    expect(slotNames).toContain("Regime Filter");
    expect(slotNames).toContain("Trailing Exit");
  });

  it("extracts M4 direction constraint candidates", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M4");
    const dirSlot = catalog.slots.find((s) => s.slotName === "Direction");
    expect(dirSlot).toBeDefined();
    expect(dirSlot?.candidates).toHaveLength(3);
    expect(dirSlot?.candidates[0].slug).toBe("both");
    expect(dirSlot?.candidates[1].slug).toBe("long");
    expect(dirSlot?.candidates[2].slug).toBe("short");
  });

  it("extracts M4 entry signal candidates", () => {
    const catalog = extractComponentCatalog(SAMPLE_KB, "M4");
    const entrySlot = catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot?.candidates).toHaveLength(3);
    expect(entrySlot?.candidates[0].name).toBe("SuperTrend flip");
  });
});

describe("buildModuleContext catalog integration", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_KB);
  });

  it("includes catalog in context for M1", () => {
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.catalog).toBeDefined();
    expect(ctx.catalog.slots.length).toBeGreaterThan(0);
    const entrySlot = ctx.catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot).toBeDefined();
    expect(entrySlot!.candidates[0].name).toBe("Donchian Channel");
  });

  it("includes catalog in context for M2", () => {
    const ctx = buildModuleContext(
      { strategy: "mean-reversion", interval: "15m", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.catalog.slots.length).toBeGreaterThan(0);
    const bandSlot = ctx.catalog.slots.find((s) => s.slotName === "Band/Channel");
    expect(bandSlot).toBeDefined();
  });

  it("includes catalog in context for M4 with correct typicalVars", () => {
    const ctx = buildModuleContext(
      { strategy: "trend-following", interval: "4h", criteria: {} },
      "/fake/kb.md",
    );
    expect(ctx.catalog.slots.length).toBeGreaterThan(0);
    const entrySlot = ctx.catalog.slots.find((s) => s.slotName === "Entry Signal");
    expect(entrySlot).toBeDefined();
    expect(entrySlot!.typicalVars).toBe("1-2");
    expect(entrySlot!.candidates[0].name).toBe("SuperTrend flip");
  });

  it("returns empty catalog when KB is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/nonexistent/kb.md",
    );
    expect(ctx.catalog.slots).toEqual([]);
  });
});

describe("extractStartingPoint", () => {
  it("extracts M1 starting point from KB", () => {
    const result = extractStartingPoint(SAMPLE_KB, 3);
    expect(result).toContain("Donchian(20)");
    expect(result).toContain("5 free vars");
  });

  it("extracts M2 starting point from KB", () => {
    const result = extractStartingPoint(SAMPLE_KB, 4);
    expect(result).toContain("Keltner Channels");
    expect(result).toContain("6 free vars");
  });

  it("returns empty string when section not found", () => {
    expect(extractStartingPoint(SAMPLE_KB, 99)).toBe("");
  });

  it("returns empty string when no starting point in section", () => {
    const kb = "## 3. Module 1: Breakout\n\n### 3.1 Fixed rules\n\nSome rules\n\n---";
    expect(extractStartingPoint(kb, 3)).toBe("");
  });
});

describe("getStartingComponents", () => {
  it("returns M1 breakout starting slugs", () => {
    const comps = getStartingComponents("M1");
    expect(comps["Direction"]).toBe("both");
    expect(comps["Entry Signal"]).toBe("donchian");
    expect(comps["Regime Filter"]).toBe("ema");
    expect(comps["Exit"]).toBe("timeout");
  });

  it("returns M2 mean-reversion starting slugs", () => {
    const comps = getStartingComponents("M2");
    expect(comps["Band/Channel"]).toBe("keltner");
    expect(comps["Exhaustion"]).toBe("rsi2");
  });

  it("returns a copy (not the original object)", () => {
    const comps = getStartingComponents("M1");
    comps["Entry Signal"] = "modified";
    expect(getStartingComponents("M1")["Entry Signal"]).toBe("donchian");
  });

  it("returns M3 pullback starting slugs (KB §5.2 aligned)", () => {
    const comps = getStartingComponents("M3");
    expect(comps["Trend Filter"]).toBe("ema");
    expect(comps["Pullback Zone"]).toBe("ema-support");
    expect(comps["Pullback Confirm"]).toBe("close-beyond");
    expect(comps["Exit"]).toBe("fixed-rr");
  });

  it("throws for unknown module", () => {
    expect(() => getStartingComponents("M99")).toThrow(/No starting components/);
  });
});

describe("computeStretchCriteria", () => {
  it("computes M1 stretch with 30% degradation", () => {
    const stretch = computeStretchCriteria("M1");
    // minPF=1.3, degradation=0.3 → stretch = 1.3/0.7 ≈ 1.86
    expect(stretch.stretchPF).toBeCloseTo(1.86, 1);
  });

  it("computes M2 stretch with 20% degradation (KB §10.1)", () => {
    const stretch = computeStretchCriteria("M2");
    // minPF=1.3, degradation=0.2 → stretch = 1.3/0.8 = 1.625
    expect(stretch.stretchPF).toBeCloseTo(1.63, 1);
    // M2 has no avgR gate
    expect(stretch.stretchAvgR).toBeNull();
  });

  it("computes M3 stretch with 25% degradation (KB §10.1)", () => {
    const stretch = computeStretchCriteria("M3");
    // minPF=1.4, degradation=0.25 → stretch = 1.4/0.75 ≈ 1.867
    expect(stretch.stretchPF).toBeCloseTo(1.87, 1);
    // M3 has minAvgR=0.15 → stretchAvgR = 0.15/0.75 = 0.2
    expect(stretch.stretchAvgR).toBeCloseTo(0.2, 1);
  });

  it("computes M4 stretch with 30% degradation", () => {
    const stretch = computeStretchCriteria("M4");
    // minPF=1.4, degradation=0.3 → stretch = 1.4/0.7 = 2.0
    expect(stretch.stretchPF).toBeCloseTo(2.0, 1);
  });
});

describe("candidateToSlug", () => {
  it("maps known candidates to short slugs", () => {
    expect(candidateToSlug("Donchian Channel")).toBe("donchian");
    expect(candidateToSlug("BB squeeze release")).toBe("squeeze");
    expect(candidateToSlug("SuperTrend flip")).toBe("supertrend");
    expect(candidateToSlug("Keltner Channels")).toBe("keltner");
  });

  it("maps direction constraint candidates to slugs", () => {
    expect(candidateToSlug("Both")).toBe("both");
    expect(candidateToSlug("Long only")).toBe("long");
    expect(candidateToSlug("Short only")).toBe("short");
  });

  it("maps partial-tp candidate to slug", () => {
    expect(candidateToSlug("Partial TP + trail")).toBe("partial-tp");
  });

  it("falls back to kebab-case for unknown names", () => {
    expect(candidateToSlug("My Custom Indicator")).toBe("my-custom-indicator");
  });
});

describe("CANDIDATE_SLUGS covers all KB candidates", () => {
  const kbPath = path.resolve(__dirname, "../../../../docs/knowledge-base.md");

  const moduleSlots = [
    { id: "M1", num: 3, headers: ["Direction constraint candidates", "Entry signal candidates", "Entry timing candidates", "Regime filter candidates", "Optional confirmation filter", "Exit candidates"] },
    { id: "M2", num: 4, headers: ["Band/channel candidates", "Exhaustion confirmation candidates", "Regime filter candidates", "Exit candidates"] },
    { id: "M3", num: 5, headers: ["Trend confirmation candidates", "Pullback zone candidates", "Pullback confirmation candidates", "Exit candidates"] },
    { id: "M4", num: 6, headers: ["Direction constraint candidates", "Entry signal candidates", "Regime filter candidates", "Trailing exit candidates"] },
  ];

  it("every KB candidate has a CANDIDATE_SLUGS entry (no kebab fallback)", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    if (!realFs.default.existsSync(kbPath)) return; // skip if KB not present

    const { extractModuleSection } = await import("./build-module-context.js");
    const kb = realFs.default.readFileSync(kbPath, "utf8");
    const failures: string[] = [];

    for (const mod of moduleSlots) {
      const section = extractModuleSection(kb, mod.num);
      if (!section) continue;
      for (const header of mod.headers) {
        const candidates = extractCandidatesFromTable(section, header);
        for (const c of candidates) {
          if (!CANDIDATE_SLUGS[c.name]) {
            failures.push(`${mod.id} | "${c.name}" — not in CANDIDATE_SLUGS`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("getKbSection", () => {
  it("maps breakout → section 3", () => {
    expect(getKbSection("breakout")).toBe(3);
  });

  it("maps mean-reversion → section 4", () => {
    expect(getKbSection("mean-reversion")).toBe(4);
  });

  it("maps pullback → section 5", () => {
    expect(getKbSection("pullback")).toBe(5);
  });

  it("maps trend-following → section 6", () => {
    expect(getKbSection("trend-following")).toBe(6);
  });

  it("throws for unknown strategy", () => {
    expect(() => getKbSection("unknown")).toThrow(/Unknown strategy profile/);
  });
});

describe("buildModuleContext with real KB", () => {
  // Regression: kbPath must point to monorepo root, not refiner package root.
  // The orchestrator's cfg.repoRoot is the refiner package root (packages/refiner),
  // so KB path must be resolved via path.resolve(cfg.repoRoot, "../../docs/knowledge-base.md").
  const monorepoRoot = path.resolve(__dirname, "../../../..");
  const kbPath = path.join(monorepoRoot, "docs/knowledge-base.md");

  it("loads non-empty catalog for M1 breakout from real KB", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    if (!realFs.existsSync(kbPath)) return; // skip in CI if KB absent

    const realKb = realFs.readFileSync(kbPath, "utf8") as string;
    vi.mocked(fs.readFileSync).mockReturnValue(realKb);

    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      kbPath,
    );

    expect(ctx.moduleId).toBe("M1");
    expect(ctx.catalog.slots.length).toBeGreaterThanOrEqual(3);

    const slotNames = ctx.catalog.slots.map((s) => s.slotName);
    expect(slotNames).toContain("Entry Signal");
    expect(slotNames).toContain("Regime Filter");
    expect(slotNames).toContain("Exit");
  });

  it("warns when KB path is wrong (e.g. refiner package root)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });

    const ctx = buildModuleContext(
      { strategy: "breakout", interval: "15m", criteria: {} },
      "/nonexistent/docs/knowledge-base.md",
    );

    expect(ctx.catalog.slots.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("KB not found"));

    warnSpy.mockRestore();
  });
});
