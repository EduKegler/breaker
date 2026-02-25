import type { IterationMetric } from "../types.js";

/**
 * Build a WhatsApp-friendly session summary in markdown.
 * Replaces the bash _send_session_summary() function.
 */
export function buildSessionSummary(opts: {
  asset: string;
  strategy?: string;
  runId: string;
  metrics: IterationMetric[];
  durationMs: number;
  success: boolean;
  bestIter: number;
  bestPnl: number;
}): string {
  const { asset, strategy, runId, metrics, durationMs, success, bestIter, bestPnl } = opts;
  const durMin = Math.floor(durationMs / 60000);
  const durSec = Math.floor((durationMs % 60000) / 1000);
  const durStr = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`;

  const icon = success ? "\u{2705}" : "\u{26A0}\u{FE0F}";
  const status = success ? "CRITERIA PASSED" : "MAX ITER REACHED";

  const lines: string[] = [];
  const label = strategy ? `${asset}/${strategy}` : asset;
  lines.push(`${icon} *B.R.E.A.K.E.R. — ${label}*`);
  lines.push(`Status: ${status}`);
  lines.push(`Run: ${runId}`);
  lines.push(`Duration: ${durStr}`);
  lines.push("");

  // Best iteration
  lines.push(`*Best iter:* ${bestIter} (PnL $${bestPnl.toFixed(2)})`);
  lines.push("");

  // Evolution table
  if (metrics.length > 0) {
    lines.push("*PnL Evolution:*");
    for (const m of metrics) {
      const arrow = m.verdict === "improved" ? "\u{2B06}\u{FE0F}" :
                    m.verdict === "degraded" ? "\u{2B07}\u{FE0F}" : "\u{27A1}\u{FE0F}";
      lines.push(
        `  ${arrow} iter${m.iter}: PnL=$${m.pnl.toFixed(2)} PF=${m.pf.toFixed(2)} WR=${m.wr.toFixed(1)}% DD=${m.dd.toFixed(1)}% T=${m.trades}`,
      );
    }
    lines.push("");
  }

  // Last metrics
  const last = metrics[metrics.length - 1];
  if (last) {
    lines.push("*Last iter:*");
    lines.push(`  PnL: $${last.pnl.toFixed(2)}`);
    lines.push(`  PF: ${last.pf.toFixed(2)}`);
    lines.push(`  DD: ${last.dd.toFixed(1)}%`);
    lines.push(`  WR: ${last.wr.toFixed(1)}%`);
    lines.push(`  Trades: ${last.trades}`);
  }

  return lines.join("\n");
}
