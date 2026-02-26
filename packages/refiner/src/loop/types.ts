import type { ResolvedCriteria, ModelRouting, Guardrails, PhasesConfig, ScoringConfig, ResearchConfig } from "../types/config.js";
import type { Metrics, CandleInterval, DataSource } from "@breaker/backtest";

export type LoopPhase = "refine" | "research" | "restructure";

export interface LoopConfig {
  asset: string;
  strategy: string;
  maxIter: number;
  maxFixAttempts: number;
  maxTransientFailures: number;
  maxNoChange: number;
  autoCommit: boolean;
  criteria: ResolvedCriteria;
  modelRouting: ModelRouting;
  guardrails: Guardrails;
  phases: PhasesConfig;
  scoring: ScoringConfig;
  research: ResearchConfig;
  coin: string;
  dataSource: DataSource;
  interval: CandleInterval;
  strategyFactory: string;
  startTime: number;
  endTime: number;
  dbPath: string;
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
  strategyContent: string;
  metrics: Metrics;
  params?: Record<string, number>;
  iter: number;
  timestamp: string;
}

export type ErrorClass =
  | "compile_error"
  | "timeout"
  | "network"
  | "transient"
  | "unknown";

export interface StageResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorClass?: ErrorClass;
}
