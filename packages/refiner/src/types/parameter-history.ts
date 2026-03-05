export interface ParameterChange {
  param: string;
  from: unknown;
  to: unknown;
}

export interface IterationMetrics {
  pnl: number;
  trades: number;
  pf: number;
}

export interface ParameterHistoryIteration {
  iter: number;
  date: string;
  change: ParameterChange | null;
  before: IterationMetrics | null;
  after: IterationMetrics | null;
  verdict: "improved" | "degraded" | "neutral" | "pending";
  note?: string;
}

export interface NeverWorkedEntry {
  param: string;
  value: unknown;
  iter: number;
  reason: string;
  note?: string;
}

export interface PendingHypothesis {
  iter: number;
  rank: number;
  hypothesis: string;
  condition?: string;
  expired: boolean;
  note?: string;
}

export interface ApproachRecord {
  id: number;
  name: string;
  indicators: string[];
  startIter: number;
  endIter: number;
  bestScore: number;
  bestMetrics: { pnl: number; pf: number; wr: number };
  verdict: "exhausted" | "promising" | "active";
  reason?: string;
}

export interface ResearchBriefRecord {
  queries: string[];
  findings: { source: string; summary: string }[];
  suggestedApproaches: { name: string; indicators: string[]; entryLogic: string; rationale: string }[];
  timestamp: string;
}

/** Records which KB catalog components were used in a restructure iteration */
export interface TestedCombination {
  iter: number;
  /** Slot name → chosen candidate name (e.g. "Entry Signal" → "Donchian Channel") */
  components: Record<string, string>;
  bestMetrics: { pnl: number; pf: number; wr: number; dd: number; trades: number } | null;
}

export interface ParameterHistory {
  iterations: ParameterHistoryIteration[];
  neverWorked: (string | NeverWorkedEntry)[];
  exploredRanges: Record<string, unknown[]>;
  pendingHypotheses: PendingHypothesis[];
  approaches?: ApproachRecord[];
  researchLog?: ResearchBriefRecord[];
  testedCombinations?: TestedCombination[];
  currentPhase?: "refine" | "research" | "restructure";
  phaseStartIter?: number;
}
