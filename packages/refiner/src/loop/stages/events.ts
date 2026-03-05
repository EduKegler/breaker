import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { DashboardEvent, ScoreBreakdown } from "../../types/events.js";

const loggers = new Map<string, pino.Logger>();

function getLogger(filePath: string): pino.Logger {
  let instance = loggers.get(filePath);
  if (!instance) {
    instance = pino(
      {
        base: undefined,
        level: "info",
        formatters: { level: () => ({ ts: new Date().toISOString() }) },
        timestamp: false,
      },
      pino.destination({ dest: filePath, sync: true, append: true }),
    );
    loggers.set(filePath, instance);
  }
  return instance;
}

/**
 * Emit a structured event to the NDJSON events log.
 * Replaces lib/emit_event.sh with pure TypeScript.
 */
export function emitEvent(opts: {
  artifactsDir: string;
  runId: string;
  asset: string;
  iter: number;
  stage: string;
  status: string;
  strategy?: string;
  pnl?: number;
  pf?: number;
  dd?: number;
  trades?: number;
  message?: string;
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
}): void {
  const dir = opts.artifactsDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, "events.ndjson");
  const log = getLogger(filePath);

  const event: Omit<DashboardEvent, "ts"> & { strategy?: string } = {
    run_id: opts.runId,
    asset: opts.asset,
    ...(opts.strategy ? { strategy: opts.strategy } : {}),
    iter: opts.iter,
    stage: opts.stage,
    status: opts.status,
    pnl: opts.pnl ?? 0,
    pf: opts.pf ?? 0,
    dd: opts.dd ?? 0,
    trades: opts.trades ?? 0,
    message: opts.message ?? "",
    ...(opts.score !== undefined && { score: opts.score }),
    ...(opts.scoreBreakdown && { scoreBreakdown: opts.scoreBreakdown }),
    ...(opts.wr !== undefined && { wr: opts.wr }),
    ...(opts.avgR !== undefined && { avgR: opts.avgR }),
    ...(opts.trainPF !== undefined && { trainPF: opts.trainPF }),
    ...(opts.testPF !== undefined && { testPF: opts.testPF }),
    ...(opts.pfRatio !== undefined && { pfRatio: opts.pfRatio }),
    ...(opts.overfitFlag !== undefined && { overfitFlag: opts.overfitFlag }),
    ...(opts.model && { model: opts.model }),
    ...(opts.durationMs !== undefined && { durationMs: opts.durationMs }),
    ...(opts.escalationReason && { escalationReason: opts.escalationReason }),
  };

  log.info(event, "");
}
