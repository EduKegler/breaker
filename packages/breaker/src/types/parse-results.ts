// --- Thresholds & Metrics ---

export interface Thresholds {
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR: number;
  minAvgR: number;
}

export interface Metrics {
  totalPnl: number | null;
  numTrades: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  winRate: number | null;
  avgR: number | null;
}

export interface CriteriaResult {
  pnlPositive: boolean;
  tradesOk: boolean;
  pfOk: boolean;
  ddOk: boolean;
  wrOk: boolean;
  avgROk: boolean;
}

// --- Pine Params ---

export interface PineParams {
  // Legacy Donchian params (kept for backward compat)
  atrMult?: number;
  maxBarsToTp1?: number;
  rr1?: number;
  rr2?: number;
  // Session ORB + Squeeze params
  slAtrMult?: number;
  rrTarget?: number;
  maxBarsInTrade?: number;
  adxMin?: number;
  bbLen?: number;
  bbMult?: number;
  kcLen?: number;
  kcMult?: number;
  emaLen?: number;
  adxLen?: number;
  atrLen?: number;
  minStopPct?: number;
  maxNotionalUsd?: number;
  maxEntriesPerDay?: number;
  dailyLossUsd?: number;
  // Common params
  riskTradeUsd?: number;
  cooldownBars?: number;
  filters: Record<string, boolean>;
  blockedHours: number[];
  blockedDays: string[];
  [key: string]: number | undefined | Record<string, boolean> | number[] | string[];
}

export interface XlsxParams {
  riskTradeUsd: number;
  atrMult: number;
  maxBarsToTp1: number;
  rr1: number;
  rr2: number;
  cooldownBars: number;
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

export interface SessionStats {
  count: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
}

export type SessionName = "Asia" | "London" | "NY" | "Off-peak";

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
  bySession: Record<SessionName, SessionStats> | null;
}

// --- Main Output ---

export interface ParseResultsOutput {
  passed: boolean;
  xlsxStale: boolean;
  filepath: string;
  thresholds: Thresholds;
  metrics: Metrics;
  criteria: CriteriaResult;
  pineParams: PineParams | null;
  xlsxParams: XlsxParams | null;
  tradeAnalysis: TradeAnalysis | null;
}

// --- Internal types used during parsing ---

export interface TradeMapEntry {
  entrySerial?: number;
  exitSerial?: number;
  pnl?: number;
}

export interface HourBucket {
  count: number;
  pnl: number;
}

export interface DayBucket {
  count: number;
  pnl: number;
}

export interface DirectionBucket {
  count: number;
  pnl: number;
  wins: number;
  grossWin: number;
  grossLoss: number;
}

export interface ExitTypeBucket {
  count: number;
  pnl: number;
  wins: number;
}
