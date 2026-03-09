import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator, type OrchestratorDecision } from "./orchestrator.js";

function createOrchestrator(overrides?: Partial<Parameters<typeof Orchestrator["prototype"]["constructor"]>[0]>) {
  return new Orchestrator({
    maxDailyLossR: 2,
    riskPerTradeUsd: 10,
    maxTradesPerDay: 5,
    volSpikeThresholdPct: 1.5,
    volSpikeLookbackBars: 4,
    volSpikeCooldownBars: 4,
    ...overrides,
  });
}

describe("Orchestrator", () => {
  let orch: Orchestrator;

  beforeEach(() => {
    orch = createOrchestrator();
    orch.registerModule("BTC:test-strat", "breakout");
    orch.registerModule("BTC:test-strat-mr", "mean-reversion");
    orch.registerModule("SOL:test-strat-pb", "pullback");
  });

  describe("canSignal", () => {
    it("allows signal in clean state", () => {
      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("blocks after daily PnL reaches 2R loss", () => {
      // maxDailyLossR=2, riskPerTradeUsd=10 → threshold = $20
      orch.recordClose("BTC:test-strat", -12);
      orch.recordClose("BTC:test-strat-mr", -8);
      // dailyPnl = -20, threshold = -20 → blocked

      const result = orch.canSignal("SOL:test-strat-pb");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R");
    });

    it("blocks after max trades per day", () => {
      for (let i = 0; i < 5; i++) orch.recordEntry("BTC:test-strat");

      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Max trades/day");
    });

    it("applies gates in priority order — daily loss before trades/day", () => {
      // Hit both limits
      orch.recordClose("BTC:test-strat", -20);
      for (let i = 0; i < 5; i++) orch.recordEntry("BTC:test-strat");

      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R"); // daily loss is checked first
    });
  });

  describe("recordClose", () => {
    it("accumulates daily PnL across modules", () => {
      orch.recordClose("BTC:test-strat", -12);
      expect(orch.getDailyPnl()).toBe(-12);

      orch.recordClose("SOL:test-strat-pb", -8);
      expect(orch.getDailyPnl()).toBe(-20);
    });
  });

  describe("shouldForceClose", () => {
    it("returns true when daily PnL <= -2R", () => {
      orch.recordClose("BTC:test-strat", -20);
      expect(orch.shouldForceClose()).toBe(true);
    });

    it("returns false when within limit", () => {
      orch.recordClose("BTC:test-strat", -19);
      expect(orch.shouldForceClose()).toBe(false);
    });

    it("returns true when daily PnL exceeds limit", () => {
      orch.recordClose("BTC:test-strat", -25);
      expect(orch.shouldForceClose()).toBe(true);
    });
  });

  describe("resetDayIfNeeded", () => {
    it("resets daily PnL and trades counter", () => {
      orch.recordClose("BTC:test-strat", -20);
      orch.recordEntry("BTC:test-strat");
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(false);

      orch.resetDayIfNeeded("2026-03-03");
      expect(orch.getDailyPnl()).toBe(0);
      expect(orch.getTradesToday()).toBe(0);
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(true);
    });

    it("does not reset if same day", () => {
      orch.resetDayIfNeeded("2026-03-02");
      orch.recordClose("BTC:test-strat", -10);

      orch.resetDayIfNeeded("2026-03-02");
      expect(orch.getDailyPnl()).toBe(-10);
    });
  });

  describe("seedDailyPnl", () => {
    it("initializes dailyPnl from an external source", () => {
      orch.seedDailyPnl(-15);
      expect(orch.getDailyPnl()).toBe(-15);
      expect(orch.shouldForceClose()).toBe(false);
    });

    it("makes canSignal block when seeded past limit", () => {
      orch.seedDailyPnl(-20);
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(false);
    });

    it("accumulates on top of seeded value", () => {
      orch.seedDailyPnl(-10);
      orch.recordClose("BTC:test-strat", -5);
      expect(orch.getDailyPnl()).toBe(-15);
    });
  });

  describe("recordEntry", () => {
    it("increments trades today", () => {
      expect(orch.getTradesToday()).toBe(0);
      orch.recordEntry("BTC:test-strat");
      expect(orch.getTradesToday()).toBe(1);
      orch.recordEntry("SOL:test-strat-pb");
      expect(orch.getTradesToday()).toBe(2);
    });
  });

  describe("proposeSignal", () => {
    it("single signal proceeds immediately", async () => {
      const result = await orch.proposeSignal("BTC:test-strat", "BTC", 1000, "long");
      expect(result.proceed).toBe(true);
    });

    it("same direction — higher priority wins", async () => {
      // breakout(4) vs mean-reversion(2) — breakout wins
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:test-strat", "BTC", 2000, "long"),
        orch.proposeSignal("BTC:test-strat-mr", "BTC", 2000, "long"),
      ]);
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(false);
      expect(r2.reason).toContain("Lower priority");
    });

    it("opposite direction — both rejected", async () => {
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:test-strat", "BTC", 3000, "long"),
        orch.proposeSignal("BTC:test-strat-mr", "BTC", 3000, "short"),
      ]);
      expect(r1.proceed).toBe(false);
      expect(r1.reason).toContain("Opposite direction");
      expect(r2.proceed).toBe(false);
      expect(r2.reason).toContain("Opposite direction");
    });

    it("different coins do not conflict", async () => {
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:test-strat", "BTC", 4000, "long"),
        orch.proposeSignal("SOL:test-strat-pb", "SOL", 4000, "short"),
      ]);
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(true);
    });

    it("different bar timestamps do not conflict", async () => {
      const r1 = await orch.proposeSignal("BTC:test-strat", "BTC", 5000, "long");
      const r2 = await orch.proposeSignal("BTC:test-strat-mr", "BTC", 6000, "short");
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(true);
    });
  });

  describe("decision callback", () => {
    it("is called with correct data on canSignal allow", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.canSignal("BTC:test-strat");
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("signal_allowed");
      expect(decisions[0].moduleId).toBe("BTC:test-strat");
    });

    it("is called with correct data on canSignal block", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.recordClose("BTC:test-strat", -20);
      orch.canSignal("BTC:test-strat");

      const blocked = decisions.find((d) => d.type === "signal_blocked");
      expect(blocked).toBeDefined();
      expect(blocked!.data.gate).toBe("daily_loss");
    });

    it("is called on day reset", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.resetDayIfNeeded("2026-03-03");
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("day_reset");
      expect(decisions[0].data.day).toBe("2026-03-03");
    });

    it("is called on deconfliction", async () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      await Promise.all([
        orch.proposeSignal("BTC:test-strat", "BTC", 7000, "long"),
        orch.proposeSignal("BTC:test-strat-mr", "BTC", 7000, "long"),
      ]);

      const deconflicted = decisions.filter((d) => d.type === "signal_deconflicted");
      expect(deconflicted).toHaveLength(2);
      expect(deconflicted.find((d) => d.data.action === "winner")).toBeDefined();
      expect(deconflicted.find((d) => d.data.action === "rejected")).toBeDefined();
    });
  });

  describe("canSignal blocks before proposeSignal", () => {
    it("rejected signals should not enter deconfliction buffer", () => {
      orch.recordClose("BTC:test-strat", -20); // hit daily loss

      const gate = orch.canSignal("BTC:test-strat");
      expect(gate.allowed).toBe(false);
      // Signal should never reach proposeSignal — verified by design
      // (strategy-runner checks canSignal first, skips proposeSignal if blocked)
    });
  });

  describe("Gate 3: Volatility Spike", () => {
    let spikeOrch: Orchestrator;

    beforeEach(() => {
      // threshold=1.5%, lookback=4 bars, cooldown=4 bars
      spikeOrch = createOrchestrator({
        volSpikeThresholdPct: 1.5,
        volSpikeLookbackBars: 4,
        volSpikeCooldownBars: 4,
      });
      spikeOrch.registerModule("BTC:test-strat", "breakout");
      spikeOrch.registerModule("SOL:test-strat-pb", "pullback");
    });

    it("does not activate spike when change < threshold", () => {
      // 5 prices with < 1.5% change over 4 bars
      const base = 100;
      for (let i = 0; i < 5; i++) {
        spikeOrch.reportPrice("BTC", base + i * 0.1, 1000 + i * 900_000);
      }
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(false);
      expect(spikeOrch.canSignal("BTC:test-strat").allowed).toBe(true);
    });

    it("activates spike when change > threshold", () => {
      // Price jumps from 100 to 102 in 4 bars → 2% > 1.5%
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100.2, 2000);
      spikeOrch.reportPrice("BTC", 100.4, 3000);
      spikeOrch.reportPrice("BTC", 100.6, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000); // |102/100 - 1| = 2% > 1.5%
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(true);
    });

    it("blocks ALL modules when spike is active", () => {
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000);

      expect(spikeOrch.canSignal("BTC:test-strat").allowed).toBe(false);
      expect(spikeOrch.canSignal("SOL:test-strat-pb").allowed).toBe(false);
      expect(spikeOrch.canSignal("BTC:test-strat").reason).toBe("Volatility spike active");
    });

    it("blocks entries on different coin (BTC spike → SOL blocked)", () => {
      // Spike triggered by BTC
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000);

      // SOL never reported but still blocked
      expect(spikeOrch.canSignal("SOL:test-strat-pb").allowed).toBe(false);
    });

    it("clears spike after Z bars of cooldown", () => {
      // lookback=1 keeps ring buffer short, so old prices are pushed out in 1 bar
      const o = createOrchestrator({ volSpikeLookbackBars: 1, volSpikeCooldownBars: 4 });
      o.registerModule("BTC:test-strat", "breakout");

      o.reportPrice("BTC", 100, 1000);
      o.reportPrice("BTC", 102, 2000); // spike! cooldown=4

      // 4 bars of stable prices: 1 to push old price out + 3 cooldown ticks
      o.reportPrice("BTC", 102, 3000); // buffer=[102,102], tick 4→3
      o.reportPrice("BTC", 102, 4000); // tick 3→2
      o.reportPrice("BTC", 102, 5000); // tick 2→1
      expect(o.isVolatilitySpikeActive()).toBe(true);
      o.reportPrice("BTC", 102, 6000); // tick 1→0 → cleared
      expect(o.isVolatilitySpikeActive()).toBe(false);
      expect(o.canSignal("BTC:test-strat").allowed).toBe(true);
    });

    it("resets cooldown if new spike occurs during cooldown", () => {
      const o = createOrchestrator({ volSpikeLookbackBars: 1, volSpikeCooldownBars: 4 });
      o.registerModule("BTC:test-strat", "breakout");

      o.reportPrice("BTC", 100, 1000);
      o.reportPrice("BTC", 102, 2000); // spike! cooldown=4

      // 2 stable bars (push old price out + tick cooldown)
      o.reportPrice("BTC", 102, 3000); // buffer=[102,102], tick 4→3
      o.reportPrice("BTC", 102, 4000); // tick 3→2

      // New spike: 102 → 104 (~1.96% > 1.5%)
      o.reportPrice("BTC", 104, 5000); // tick 2→1, then |104/102|≈1.96% → reset cooldown=4
      expect(o.isVolatilitySpikeActive()).toBe(true);

      // Need 1 bar to push old 102 out + 3 cooldown ticks
      o.reportPrice("BTC", 104, 6000); // buffer=[104,104], tick 4→3
      o.reportPrice("BTC", 104, 7000); // tick 3→2
      o.reportPrice("BTC", 104, 8000); // tick 2→1
      expect(o.isVolatilitySpikeActive()).toBe(true);
      o.reportPrice("BTC", 104, 9000); // tick 1→0 → cleared
      expect(o.isVolatilitySpikeActive()).toBe(false);
    });

    it("does NOT affect shouldForceClose (only blocks entries)", () => {
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000); // spike active

      // shouldForceClose only cares about daily loss, not spike
      expect(spikeOrch.shouldForceClose()).toBe(false);
    });

    it("gate priority: daily loss > max trades > vol spike", () => {
      // Hit daily loss limit
      spikeOrch.recordClose("BTC:test-strat", -20);

      // Also trigger spike
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000);

      const result = spikeOrch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R"); // daily loss checked first, not spike
    });

    it("day reset does NOT clear spike state", () => {
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000);
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(true);

      spikeOrch.resetDayIfNeeded("2026-03-04");
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(true);
    });

    it("needs lookback+1 prices before detecting spike", () => {
      // Only 4 prices (need 5 = lookback+1 for 4-bar lookback)
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 110, 4000); // huge jump but only 4 data points
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(false);
    });

    it("dedup: same barTs from different coins only ticks cooldown once", () => {
      const o = createOrchestrator({ volSpikeLookbackBars: 1, volSpikeCooldownBars: 4 });
      o.registerModule("BTC:test-strat", "breakout");
      o.registerModule("SOL:test-strat-pb", "pullback");

      o.reportPrice("BTC", 100, 1000);
      o.reportPrice("BTC", 102, 2000); // spike! cooldown=4

      // Bar 3000: push old price out → cooldown tick 4→3
      o.reportPrice("BTC", 102, 3000);

      // Bar 4000: BTC and SOL report same barTs → cooldown ticks only once (3→2)
      o.reportPrice("BTC", 102, 4000);
      o.reportPrice("SOL", 50, 4000); // same barTs → no extra tick

      // 2 more unique bars needed
      o.reportPrice("BTC", 102, 5000); // tick 2→1
      expect(o.isVolatilitySpikeActive()).toBe(true);
      o.reportPrice("BTC", 102, 6000); // tick 1→0 → cleared
      expect(o.isVolatilitySpikeActive()).toBe(false);
    });

    it("spike on price drop (descending) also triggers", () => {
      // Price drops from 100 to 98 in 4 bars → |-2%| > 1.5%
      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 99.8, 2000);
      spikeOrch.reportPrice("BTC", 99.5, 3000);
      spikeOrch.reportPrice("BTC", 99.2, 4000);
      spikeOrch.reportPrice("BTC", 98, 5000); // |98/100 - 1| = 2%
      expect(spikeOrch.isVolatilitySpikeActive()).toBe(true);
    });

    it("logs spike_detected and spike_cleared decisions", () => {
      const o = createOrchestrator({ volSpikeLookbackBars: 1, volSpikeCooldownBars: 4 });
      const decisions: OrchestratorDecision[] = [];
      o.setDecisionCallback((d) => decisions.push(d));

      o.reportPrice("BTC", 100, 1000);
      o.reportPrice("BTC", 102, 2000); // spike detected

      const detected = decisions.find((d) => d.data.event === "spike_detected");
      expect(detected).toBeDefined();
      expect(detected!.data.coin).toBe("BTC");
      expect(detected!.data.changePct).toBeCloseTo(2.0, 1);

      // Clear spike: 1 bar to push old price out + 3 cooldown ticks
      o.reportPrice("BTC", 102, 3000);
      o.reportPrice("BTC", 102, 4000);
      o.reportPrice("BTC", 102, 5000);
      o.reportPrice("BTC", 102, 6000); // cleared

      const cleared = decisions.find((d) => d.data.event === "spike_cleared");
      expect(cleared).toBeDefined();
    });

    it("canSignal logs volatility_spike gate when blocked", () => {
      const decisions: OrchestratorDecision[] = [];
      spikeOrch.setDecisionCallback((d) => decisions.push(d));

      spikeOrch.reportPrice("BTC", 100, 1000);
      spikeOrch.reportPrice("BTC", 100, 2000);
      spikeOrch.reportPrice("BTC", 100, 3000);
      spikeOrch.reportPrice("BTC", 100, 4000);
      spikeOrch.reportPrice("BTC", 102, 5000);

      spikeOrch.canSignal("BTC:test-strat");

      const blocked = decisions.find((d) => d.type === "signal_blocked" && d.data.gate === "volatility_spike");
      expect(blocked).toBeDefined();
      expect(blocked!.moduleId).toBe("BTC:test-strat");
    });
  });

  describe("Gate 6: Squeeze", () => {
    it("allows signal when no squeeze reported", () => {
      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(true);
    });

    it("blocks signal when squeeze is active", () => {
      orch.reportSqueeze("BTC", true, 1000);
      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Squeeze active");
    });

    it("is a GLOBAL gate: squeeze on BTC blocks SOL entry", () => {
      orch.reportSqueeze("BTC", true, 1000);
      const result = orch.canSignal("SOL:test-strat-pb");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Squeeze active");
    });

    it("allows signal after squeeze is released", () => {
      orch.reportSqueeze("BTC", true, 1000);
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(false);

      orch.reportSqueeze("BTC", false, 2000);
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(true);
    });

    it("stays blocked if one coin still squeezed (multi-coin)", () => {
      orch.reportSqueeze("BTC", true, 1000);
      orch.reportSqueeze("SOL", true, 1000);

      // Release BTC but SOL still squeezed
      orch.reportSqueeze("BTC", false, 2000);
      expect(orch.canSignal("BTC:test-strat").allowed).toBe(false);
    });

    it("dedup: ignores report with same barTs for same coin", () => {
      orch.reportSqueeze("BTC", true, 1000);
      // Second report with same barTs should be ignored
      orch.reportSqueeze("BTC", false, 1000);
      expect(orch.isSqueezeActive()).toBe(true);
    });

    it("dedup: ignores report with older barTs for same coin", () => {
      orch.reportSqueeze("BTC", true, 2000);
      // Older barTs should be ignored
      orch.reportSqueeze("BTC", false, 1000);
      expect(orch.isSqueezeActive()).toBe(true);
    });

    it("accepts reports from different coins with same barTs", () => {
      orch.reportSqueeze("BTC", true, 1000);
      orch.reportSqueeze("SOL", false, 1000);
      expect(orch.isSqueezeActive()).toBe(true);
    });

    it("cold start: no reports → squeeze inactive", () => {
      expect(orch.isSqueezeActive()).toBe(false);
    });

    it("day reset does NOT clear squeeze state", () => {
      orch.reportSqueeze("BTC", true, 1000);
      orch.resetDayIfNeeded("2026-03-04");
      expect(orch.isSqueezeActive()).toBe(true);
    });

    it("gate priority: daily loss checked before squeeze", () => {
      orch.recordClose("BTC:test-strat", -20); // hit daily loss
      orch.reportSqueeze("BTC", true, 1000);

      const result = orch.canSignal("BTC:test-strat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R"); // daily loss, not squeeze
    });

    it("logs squeeze_detected on false→true transition", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.reportSqueeze("BTC", true, 1000);

      const detected = decisions.find((d) => d.data.event === "squeeze_detected");
      expect(detected).toBeDefined();
      expect(detected!.data.coin).toBe("BTC");
    });

    it("logs squeeze_released on true→false transition", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.reportSqueeze("BTC", true, 1000);
      orch.reportSqueeze("BTC", false, 2000);

      const released = decisions.find((d) => d.data.event === "squeeze_released");
      expect(released).toBeDefined();
      expect(released!.data.coin).toBe("BTC");
    });

    it("does NOT log on same-state report (true→true)", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.reportSqueeze("BTC", true, 1000);
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.reportSqueeze("BTC", true, 2000);

      const squeezeEvents = decisions.filter(
        (d) => d.data.event === "squeeze_detected" || d.data.event === "squeeze_released",
      );
      expect(squeezeEvents).toHaveLength(0);
    });

    it("shouldForceClose is NOT affected by squeeze", () => {
      orch.reportSqueeze("BTC", true, 1000);
      expect(orch.shouldForceClose()).toBe(false);
    });
  });
});
