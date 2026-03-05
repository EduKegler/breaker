import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildModuleContext, extractFixedRules, MODULE_CRITERIA } from "./build-module-context.js";

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

Some candidates here.

---

## 4. Module 2: Mean Reversion

### 4.1 Fixed rules (BREAKER cannot change)

1. **Max free variables:** 6
2. **Band-based entry:** mandatory.

### 4.2 Strategy candidates
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
});
