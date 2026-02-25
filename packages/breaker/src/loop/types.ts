import type { ResolvedCriteria, ModelRouting, Guardrails, PhasesConfig, ScoringConfig, ResearchConfig } from "../types/config.js";
import type { ParseResultsOutput, Metrics } from "../types/parse-results.js";

export type LoopPhase = "refine" | "research" | "restructure";

export interface LoopConfig {
  asset: string;
  strategy: string;
  maxIter: number;
  maxFixAttempts: number;
  maxStaleAttempts: number;
  maxTransientFailures: number;
  maxNoChange: number;
  autoCommit: boolean;
  criteria: ResolvedCriteria;
  modelRouting: ModelRouting;
  guardrails: Guardrails;
  phases: PhasesConfig;
  scoring: ScoringConfig;
  research: ResearchConfig;
  chartUrl: string;
  dateRange: string;
  repoRoot: string;
  strategyDir: string;
  strategyFile: string;
  configFile: string;
  paramHistoryFile: string;
  checkpointDir: string;
  artifactsDir: string;
  runId: string;
}

export interface IterationState {
  iter: number;
  globalIter: number;
  bestPnl: number;
  bestIter: number;
  fixAttempts: number;
  staleAttempts: number;
  integrityAttempts: number;
  transientFailures: number;
  noChangeCount: number;
  previousPnl: number;
  sessionMetrics: IterationMetric[];
  currentPhase: LoopPhase;
  currentScore: number;
  bestScore: number;
  neutralStreak: number;
  phaseCycles: number;
}

export interface IterationMetric {
  iter: number;
  pnl: number;
  pf: number;
  dd: number;
  wr: number;
  trades: number;
  verdict: string;
}

export interface CheckpointData {
  pineContent: string;
  metrics: Metrics;
  iter: number;
  timestamp: string;
}

export type ErrorClass =
  | "compile_error"
  | "timeout"
  | "network"
  | "stale_xlsx"
  | "transient_ui"
  | "unknown";

export interface StageResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorClass?: ErrorClass;
}
