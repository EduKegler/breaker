import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { DashboardEvent } from "../../types/events.js";

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
  };

  log.info(event, "");
}
