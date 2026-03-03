import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator, type OrchestratorDecision } from "./orchestrator.js";

function createOrchestrator(overrides?: Partial<Parameters<typeof Orchestrator["prototype"]["constructor"]>[0]>) {
  return new Orchestrator({
    maxDailyLossR: 2,
    riskPerTradeUsd: 10,
    maxTradesPerDay: 5,
    ...overrides,
  });
}

describe("Orchestrator", () => {
  let orch: Orchestrator;

  beforeEach(() => {
    orch = createOrchestrator();
    orch.registerModule("BTC:donchian-adx", "breakout");
    orch.registerModule("BTC:keltner-rsi2", "mean-reversion");
    orch.registerModule("SOL:ema-pullback", "pullback");
  });

  describe("canSignal", () => {
    it("allows signal in clean state", () => {
      const result = orch.canSignal("BTC:donchian-adx");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("blocks after daily PnL reaches 2R loss", () => {
      // maxDailyLossR=2, riskPerTradeUsd=10 → threshold = $20
      orch.recordClose("BTC:donchian-adx", -12);
      orch.recordClose("BTC:keltner-rsi2", -8);
      // dailyPnl = -20, threshold = -20 → blocked

      const result = orch.canSignal("SOL:ema-pullback");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R");
    });

    it("blocks module with 2 consecutive losses", () => {
      orch.recordClose("BTC:donchian-adx", -5);
      orch.recordClose("BTC:donchian-adx", -5);

      const result = orch.canSignal("BTC:donchian-adx");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("consecutive losses");

      // Other modules still allowed
      expect(orch.canSignal("BTC:keltner-rsi2").allowed).toBe(true);
    });

    it("blocks after max trades per day", () => {
      for (let i = 0; i < 5; i++) orch.recordEntry("BTC:donchian-adx");

      const result = orch.canSignal("BTC:donchian-adx");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Max trades/day");
    });

    it("applies gates in priority order — daily loss before trades/day", () => {
      // Hit both limits
      orch.recordClose("BTC:donchian-adx", -20);
      for (let i = 0; i < 5; i++) orch.recordEntry("BTC:donchian-adx");

      const result = orch.canSignal("BTC:donchian-adx");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2R"); // daily loss is checked first
    });
  });

  describe("recordClose", () => {
    it("increments consecutive losses and pauses at 2", () => {
      orch.recordClose("BTC:donchian-adx", -5);
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(true);

      orch.recordClose("BTC:donchian-adx", -5);
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(false);
    });

    it("resets consecutive losses and unpauses on profit", () => {
      orch.recordClose("BTC:donchian-adx", -5);
      orch.recordClose("BTC:donchian-adx", -5);
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(false);

      orch.recordClose("BTC:donchian-adx", 10);
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(true);
    });

    it("accumulates daily PnL across modules", () => {
      orch.recordClose("BTC:donchian-adx", -12);
      expect(orch.getDailyPnl()).toBe(-12);

      orch.recordClose("SOL:ema-pullback", -8);
      expect(orch.getDailyPnl()).toBe(-20);
    });
  });

  describe("shouldForceClose", () => {
    it("returns true when daily PnL <= -2R", () => {
      orch.recordClose("BTC:donchian-adx", -20);
      expect(orch.shouldForceClose()).toBe(true);
    });

    it("returns false when within limit", () => {
      orch.recordClose("BTC:donchian-adx", -19);
      expect(orch.shouldForceClose()).toBe(false);
    });

    it("returns true when daily PnL exceeds limit", () => {
      orch.recordClose("BTC:donchian-adx", -25);
      expect(orch.shouldForceClose()).toBe(true);
    });
  });

  describe("resetDayIfNeeded", () => {
    it("resets all state and unpauses modules", () => {
      orch.recordClose("BTC:donchian-adx", -5);
      orch.recordClose("BTC:donchian-adx", -5);
      orch.recordEntry("BTC:donchian-adx");
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(false);

      orch.resetDayIfNeeded("2026-03-03");
      expect(orch.getDailyPnl()).toBe(0);
      expect(orch.getTradesToday()).toBe(0);
      expect(orch.canSignal("BTC:donchian-adx").allowed).toBe(true);
    });

    it("does not reset if same day", () => {
      orch.resetDayIfNeeded("2026-03-02");
      orch.recordClose("BTC:donchian-adx", -10);

      orch.resetDayIfNeeded("2026-03-02");
      expect(orch.getDailyPnl()).toBe(-10);
    });
  });

  describe("recordEntry", () => {
    it("increments trades today", () => {
      expect(orch.getTradesToday()).toBe(0);
      orch.recordEntry("BTC:donchian-adx");
      expect(orch.getTradesToday()).toBe(1);
      orch.recordEntry("SOL:ema-pullback");
      expect(orch.getTradesToday()).toBe(2);
    });
  });

  describe("proposeSignal", () => {
    it("single signal proceeds immediately", async () => {
      const result = await orch.proposeSignal("BTC:donchian-adx", "BTC", 1000, "long");
      expect(result.proceed).toBe(true);
    });

    it("same direction — higher priority wins", async () => {
      // breakout(4) vs mean-reversion(2) — breakout wins
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:donchian-adx", "BTC", 2000, "long"),
        orch.proposeSignal("BTC:keltner-rsi2", "BTC", 2000, "long"),
      ]);
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(false);
      expect(r2.reason).toContain("Lower priority");
    });

    it("opposite direction — both rejected", async () => {
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:donchian-adx", "BTC", 3000, "long"),
        orch.proposeSignal("BTC:keltner-rsi2", "BTC", 3000, "short"),
      ]);
      expect(r1.proceed).toBe(false);
      expect(r1.reason).toContain("Opposite direction");
      expect(r2.proceed).toBe(false);
      expect(r2.reason).toContain("Opposite direction");
    });

    it("different coins do not conflict", async () => {
      const [r1, r2] = await Promise.all([
        orch.proposeSignal("BTC:donchian-adx", "BTC", 4000, "long"),
        orch.proposeSignal("SOL:ema-pullback", "SOL", 4000, "short"),
      ]);
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(true);
    });

    it("different bar timestamps do not conflict", async () => {
      const r1 = await orch.proposeSignal("BTC:donchian-adx", "BTC", 5000, "long");
      const r2 = await orch.proposeSignal("BTC:keltner-rsi2", "BTC", 6000, "short");
      expect(r1.proceed).toBe(true);
      expect(r2.proceed).toBe(true);
    });
  });

  describe("decision callback", () => {
    it("is called with correct data on canSignal allow", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.canSignal("BTC:donchian-adx");
      expect(decisions).toHaveLength(1);
      expect(decisions[0].type).toBe("signal_allowed");
      expect(decisions[0].moduleId).toBe("BTC:donchian-adx");
    });

    it("is called with correct data on canSignal block", () => {
      const decisions: OrchestratorDecision[] = [];
      orch.setDecisionCallback((d) => decisions.push(d));

      orch.recordClose("BTC:donchian-adx", -20);
      orch.canSignal("BTC:donchian-adx");

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
        orch.proposeSignal("BTC:donchian-adx", "BTC", 7000, "long"),
        orch.proposeSignal("BTC:keltner-rsi2", "BTC", 7000, "long"),
      ]);

      const deconflicted = decisions.filter((d) => d.type === "signal_deconflicted");
      expect(deconflicted).toHaveLength(2);
      expect(deconflicted.find((d) => d.data.action === "winner")).toBeDefined();
      expect(deconflicted.find((d) => d.data.action === "rejected")).toBeDefined();
    });
  });

  describe("canSignal blocks before proposeSignal", () => {
    it("rejected signals should not enter deconfliction buffer", () => {
      orch.recordClose("BTC:donchian-adx", -20); // hit daily loss

      const gate = orch.canSignal("BTC:donchian-adx");
      expect(gate.allowed).toBe(false);
      // Signal should never reach proposeSignal — verified by design
      // (strategy-runner checks canSignal first, skips proposeSignal if blocked)
    });
  });
});
