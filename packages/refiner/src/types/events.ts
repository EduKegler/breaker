export interface ScoreBreakdown {
  pf: number;
  avgR: number;
  wr: number;
  dd: number;
  complexity: number;
  sampleConfidence: number;
}

export interface DashboardEvent {
  ts: string;
  iter: number;
  stage: string;
  status: string;
  pnl: number;
  pf: number;
  dd: number;
  trades: number;
  message: string;
  run_id: string;
  asset: string;
  anomalies?: string[];
  score?: number;
  scoreBreakdown?: ScoreBreakdown;
  wr?: number;
  avgR?: number;
  trainPF?: number;
  testPF?: number;
  pfRatio?: number;
  overfitFlag?: boolean;
  model?: string;
  durationMs?: number;
  escalationReason?: string;
  promptChars?: number;
  approxPromptTokens?: number;
  phase?: string;
  claudeDurationMs?: number;
  maxTurnsUsed?: number;
  actualTurnsUsed?: number;
  verdict?: string;
}
