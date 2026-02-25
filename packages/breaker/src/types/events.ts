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
}
