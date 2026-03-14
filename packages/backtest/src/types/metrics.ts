// BREAKER-compatible types — must match @breaker/refiner/src/types/parse-results.ts

export interface Metrics {
  totalPnl: number | null;
  numTrades: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  winRate: number | null;
  avgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  maxLossR: number | null;
  expectancy: number | null;

  // Cost-aware metrics
  edgeBpsGross: number | null;
  edgeBpsNet: number | null;
  avgCostBps: number | null;
  tradesPerDay: number | null;
  totalCostPct: number | null;

  // Risk metrics (equity-curve based)
  sharpeRatio: number | null;
  sortinoRatio: number | null;
}

export interface Thresholds {
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR: number;
  minAvgR: number;
}

export interface CriteriaResult {
  pnlPositive: boolean;
  tradesOk: boolean;
  pfOk: boolean;
  ddOk: boolean;
  wrOk: boolean;
  avgROk: boolean;
}

// --- Trade Analysis ---

export interface DirectionStats {
  count: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  avgTrade: number;
}

export interface ExitTypeStats {
  signal: string;
  count: number;
  pnl: number;
  winRate: number;
}

export interface HourStats {
  hour: number;
  count: number;
  pnl: number;
}

export interface DayStats {
  count: number;
  pnl: number;
}

export interface HourSim {
  hour: number;
  tradesRemoved: number;
  pnlDelta: number;
  pnlAfter: number;
  tradesAfter: number;
}

export interface DaySim {
  day: string;
  tradesRemoved: number;
  pnlDelta: number;
  pnlAfter: number;
  tradesAfter: number;
}

export interface RemoveAllSL {
  tradesRemoved: number;
  pnlDelta: number;
  pnlAfter: number;
  tradesAfter: number;
}

export interface FilterSimulations {
  totalPnl: number;
  totalTrades: number;
  byHour: HourSim[];
  byDay: DaySim[];
  removeAllSL: RemoveAllSL;
}

export interface HourConsistency {
  hour: number;
  trainPnl: number;
  trainCount: number;
  testPnl: number;
  testCount: number;
  consistent: boolean | null;
}

export interface WalkForward {
  trainTrades: number;
  testTrades: number;
  splitRatio: number;
  hourConsistency: HourConsistency[];
  trainPF: number | null;
  testPF: number | null;
  pfRatio: number | null;
  overfitFlag: boolean;
}

export interface RollingWfWindow {
  windowIndex: number;
  trainTrades: number;
  testTrades: number;
  trainPF: number | null;
  testPF: number | null;
  pfRatio: number | null;
  pass: boolean;
}

export interface RollingWalkForward {
  windows: RollingWfWindow[];
  windowsPassed: number;
  windowsTotal: number;
  passRate: number;
  worstPfRatio: number | null;
  overfitFlag: boolean;
}

export type SessionName = "Asia" | "London" | "NY" | "Off-peak";

export interface SessionStats {
  count: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  edgeBpsNet: number;
  avgCostBps: number;
}

export type RegimeName = "trending" | "ranging" | "unclear";

/** Alias for DirectionStats — same shape, distinct semantic context. */
export type RegimeStats = DirectionStats;

export interface TradeAnalysis {
  totalExitRows: number;
  byDirection: Record<string, DirectionStats>;
  byExitType: ExitTypeStats[];
  avgBarsWinners: number | null;
  avgBarsLosers: number | null;
  byDayOfWeek: Record<string, DayStats>;
  bestHoursUTC: HourStats[];
  worstHoursUTC: HourStats[];
  best3TradesPnl: number[];
  worst3TradesPnl: number[];
  filterSimulations: FilterSimulations;
  walkForward: WalkForward | null;
  rollingWalkForward: RollingWalkForward | null;
  bySession: Record<SessionName, SessionStats> | null;
  byRegime: Partial<Record<RegimeName, RegimeStats>> | null;
}
