export type ModuleType = "breakout" | "pullback" | "mean-reversion" | "trend-following";

export interface OrchestratorConfig {
  maxDailyLossR: number;
  riskPerTradeUsd: number;
  maxTradesPerDay: number;
  volSpikeThresholdPct: number;
  volSpikeLookbackBars: number;
  volSpikeCooldownBars: number;
}

export interface OrchestratorDecision {
  timestamp: string;
  type: "signal_allowed" | "signal_blocked" | "signal_deconflicted" | "force_close_triggered" | "day_reset";
  moduleId: string;
  data: Record<string, unknown>;
}

interface SignalResolution {
  proceed: boolean;
  reason?: string;
}

interface ModuleState {
  type: ModuleType;
  priority: number;
}

const MODULE_PRIORITY: Record<ModuleType, number> = {
  "breakout": 4,
  "pullback": 3,
  "mean-reversion": 2,
  "trend-following": 1,
};

const DECONFLICT_DELAY_MS = 50;

export class Orchestrator {
  private dailyPnl = 0;
  private tradesToday = 0;
  private lastResetDay = "";
  private maxDailyLossUsd: number;
  private maxTradesPerDay: number;
  private modules = new Map<string, ModuleState>();

  // Signal buffer for deconfliction: coin:barTs → moduleId → signal info
  private signalBuffer = new Map<string, Map<string, { direction: string; priority: number }>>();
  private barTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private barResolvers = new Map<string, Map<string, (r: SignalResolution) => void>>();

  // Gate 3: Volatility spike state
  private volatilitySpikeActive = false;
  private spikeCooldownRemaining = 0;
  private priceHistory = new Map<string, number[]>();
  private lastTickBarTs = 0;

  private onDecisionCb?: (d: OrchestratorDecision) => void;

  constructor(private config: OrchestratorConfig) {
    this.maxDailyLossUsd = config.maxDailyLossR * config.riskPerTradeUsd;
    this.maxTradesPerDay = config.maxTradesPerDay;
  }

  registerModule(id: string, type: ModuleType): void {
    this.modules.set(id, {
      type,
      priority: MODULE_PRIORITY[type],
    });
  }

  setDecisionCallback(cb: (d: OrchestratorDecision) => void): void {
    this.onDecisionCb = cb;
  }

  canSignal(moduleId: string): { allowed: boolean; reason?: string } {
    // Gate 1: Daily loss limit
    if (this.dailyPnl <= -this.maxDailyLossUsd) {
      this.logDecision("signal_blocked", moduleId, {
        gate: "daily_loss",
        dailyPnl: this.dailyPnl,
        maxDailyLossUsd: this.maxDailyLossUsd,
      });
      return { allowed: false, reason: `Daily loss >= ${this.config.maxDailyLossR}R` };
    }

    // Gate 2: Max trades per day
    if (this.tradesToday >= this.maxTradesPerDay) {
      this.logDecision("signal_blocked", moduleId, {
        gate: "max_trades",
        tradesToday: this.tradesToday,
        maxTradesPerDay: this.maxTradesPerDay,
      });
      return { allowed: false, reason: "Max trades/day reached" };
    }

    // Gate 3: Volatility spike
    if (this.volatilitySpikeActive) {
      this.logDecision("signal_blocked", moduleId, {
        gate: "volatility_spike",
        spikeCooldownRemaining: this.spikeCooldownRemaining,
      });
      return { allowed: false, reason: "Volatility spike active" };
    }

    this.logDecision("signal_allowed", moduleId, {
      dailyPnl: this.dailyPnl,
      tradesToday: this.tradesToday,
    });
    return { allowed: true };
  }

  proposeSignal(
    moduleId: string,
    coin: string,
    barTs: number,
    direction: string,
  ): Promise<SignalResolution> {
    const mod = this.modules.get(moduleId);
    const priority = mod?.priority ?? 0;
    const bufferKey = `${coin}:${barTs}`;

    return new Promise<SignalResolution>((resolve) => {
      // Initialize buffer for this bar if first signal
      if (!this.signalBuffer.has(bufferKey)) {
        this.signalBuffer.set(bufferKey, new Map());
        this.barResolvers.set(bufferKey, new Map());

        // Start timer — resolve all after delay
        const timer = setTimeout(() => {
          this.resolveBar(bufferKey);
        }, DECONFLICT_DELAY_MS);
        this.barTimers.set(bufferKey, timer);
      }

      this.signalBuffer.get(bufferKey)!.set(moduleId, { direction, priority });
      this.barResolvers.get(bufferKey)!.set(moduleId, resolve);
    });
  }

  recordEntry(moduleId: string): void {
    this.tradesToday++;
  }

  recordClose(_moduleId: string, pnl: number): void {
    this.dailyPnl += pnl;
  }

  shouldForceClose(): boolean {
    return this.dailyPnl <= -this.maxDailyLossUsd;
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  getTradesToday(): number {
    return this.tradesToday;
  }

  resetDayIfNeeded(currentDay: string): void {
    if (currentDay === this.lastResetDay) return;
    this.lastResetDay = currentDay;
    this.dailyPnl = 0;
    this.tradesToday = 0;
    this.logDecision("day_reset", "system", { day: currentDay });
  }

  reportPrice(coin: string, closePrice: number, barTs: number): void {
    // Append to ring buffer (keep at most lookback + 1 entries)
    const maxLen = this.config.volSpikeLookbackBars + 1;
    let history = this.priceHistory.get(coin);
    if (!history) {
      history = [];
      this.priceHistory.set(coin, history);
    }
    history.push(closePrice);
    if (history.length > maxLen) {
      history.splice(0, history.length - maxLen);
    }

    // Tick cooldown on new unique barTs (dedup across coins)
    if (barTs > this.lastTickBarTs) {
      this.lastTickBarTs = barTs;
      if (this.volatilitySpikeActive) {
        this.spikeCooldownRemaining--;
        if (this.spikeCooldownRemaining <= 0) {
          this.volatilitySpikeActive = false;
          this.spikeCooldownRemaining = 0;
          this.logDecision("signal_allowed", "system", { event: "spike_cleared" });
        }
      }
    }

    // Check for spike if enough history
    if (history.length >= maxLen) {
      const oldClose = history[0];
      const changePct = Math.abs(closePrice / oldClose - 1) * 100;
      if (changePct > this.config.volSpikeThresholdPct) {
        this.volatilitySpikeActive = true;
        this.spikeCooldownRemaining = this.config.volSpikeCooldownBars;
        this.logDecision("signal_blocked", "system", {
          event: "spike_detected",
          coin,
          changePct,
          threshold: this.config.volSpikeThresholdPct,
          cooldownBars: this.config.volSpikeCooldownBars,
        });
      }
    }
  }

  isVolatilitySpikeActive(): boolean {
    return this.volatilitySpikeActive;
  }

  private resolveBar(bufferKey: string): void {
    const signals = this.signalBuffer.get(bufferKey);
    const resolvers = this.barResolvers.get(bufferKey);
    if (!signals || !resolvers) return;

    // Clean up
    this.signalBuffer.delete(bufferKey);
    this.barResolvers.delete(bufferKey);
    this.barTimers.delete(bufferKey);

    // Single signal — most common case (~90%)
    if (signals.size === 1) {
      const [moduleId, resolver] = [...resolvers.entries()][0];
      resolver({ proceed: true });
      return;
    }

    // Multiple signals — check for direction conflict
    const directions = new Set([...signals.values()].map((s) => s.direction));

    if (directions.size > 1) {
      // Opposite directions — reject all
      for (const [moduleId, resolver] of resolvers) {
        this.logDecision("signal_deconflicted", moduleId, {
          action: "rejected",
          reason: "Opposite direction conflict",
          bufferKey,
        });
        resolver({ proceed: false, reason: "Opposite direction conflict" });
      }
      return;
    }

    // Same direction — highest priority wins
    let winner: { moduleId: string; priority: number } | null = null;
    for (const [moduleId, signal] of signals) {
      if (!winner || signal.priority > winner.priority) {
        winner = { moduleId, priority: signal.priority };
      }
    }

    for (const [moduleId, resolver] of resolvers) {
      if (moduleId === winner!.moduleId) {
        this.logDecision("signal_deconflicted", moduleId, {
          action: "winner",
          bufferKey,
          competitorCount: signals.size,
        });
        resolver({ proceed: true });
      } else {
        this.logDecision("signal_deconflicted", moduleId, {
          action: "rejected",
          reason: `Lower priority than ${winner!.moduleId}`,
          bufferKey,
        });
        resolver({ proceed: false, reason: `Lower priority than ${winner!.moduleId}` });
      }
    }
  }

  private logDecision(
    type: OrchestratorDecision["type"],
    moduleId: string,
    data: Record<string, unknown>,
  ): void {
    const decision: OrchestratorDecision = {
      timestamp: new Date().toISOString(),
      type,
      moduleId,
      data,
    };
    this.onDecisionCb?.(decision);
  }
}
