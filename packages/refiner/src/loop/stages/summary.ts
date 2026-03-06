import type { IterationMetric } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/**
 * Build a WhatsApp-friendly session summary in markdown (plain text, no ANSI).
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
  const durStr = fmtDuration(durationMs);

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
      let dur = "";
      if (m.durationMs != null) {
        const mins = Math.floor(m.durationMs / 60000);
        const secs = Math.floor((m.durationMs % 60000) / 1000);
        dur = mins > 0 ? ` ${mins}m ${secs}s` : ` ${secs}s`;
      }
      const summary = m.summary ? ` | ${m.summary}` : "";
      lines.push(
        `  ${arrow} iter${m.iter}: PnL=$${m.pnl.toFixed(2)} PF=${m.pf.toFixed(2)} WR=${m.wr.toFixed(1)}% DD=${Math.abs(m.dd).toFixed(1)}% T=${m.trades}${dur}${summary}`,
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
    lines.push(`  DD: ${Math.abs(last.dd).toFixed(1)}%`);
    lines.push(`  WR: ${last.wr.toFixed(1)}%`);
    lines.push(`  Trades: ${last.trades}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ANSI color constants
// ---------------------------------------------------------------------------

const A = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  ylw: "\x1b[33m",
  cyn: "\x1b[36m",
};

/**
 * Build a colored console summary (ANSI). Not for WhatsApp/file.
 */
export function buildConsoleSummary(opts: {
  asset: string;
  strategy?: string;
  runId: string;
  metrics: IterationMetric[];
  durationMs: number;
  success: boolean;
  bestIter: number;
  bestPnl: number;
  bestScore: number;
}): string {
  const { asset, strategy, metrics, durationMs, success, bestIter, bestPnl, bestScore } = opts;
  const durStr = fmtDuration(durationMs);
  const label = strategy ? `${asset}/${strategy}` : asset;

  const statusColor = success ? A.grn : A.ylw;
  const statusText = success ? "CRITERIA PASSED" : "MAX ITER REACHED";

  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(`  ${A.b}B.R.E.A.K.E.R.${A.r} — ${label}`);
  lines.push(`  ${statusColor}${statusText}${A.r}  ${A.d}│${A.r}  ${durStr}  ${A.d}│${A.r}  best iter ${bestIter}  ${A.d}│${A.r}  score ${A.b}${bestScore.toFixed(1)}${A.r}`);
  lines.push(`  PnL ${A.b}$${bestPnl.toFixed(2)}${A.r}`);

  if (metrics.length === 0) return lines.join("\n");

  // Find best/worst PnL indices
  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 0; i < metrics.length; i++) {
    if (metrics[i].pnl > metrics[bestIdx].pnl) bestIdx = i;
    if (metrics[i].pnl < metrics[worstIdx].pnl) worstIdx = i;
  }

  lines.push("");

  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];

    // Row color: green for best, red for worst, dim for the rest
    let color: string;
    if (bestIdx === worstIdx) {
      color = A.d;
    } else if (i === bestIdx) {
      color = A.grn;
    } else if (i === worstIdx) {
      color = A.red;
    } else {
      color = A.d;
    }

    const dur = m.durationMs != null ? fmtDuration(m.durationMs) : "";
    const arrow = m.verdict === "improved" ? `${A.grn}▲${A.r}`
               : m.verdict === "degraded" ? `${A.red}▼${A.r}`
               : `${A.d}─${A.r}`;

    // Line 1: iter + metrics
    lines.push(
      `  ${arrow} ${color}iter ${m.iter}${A.r}  ${color}PnL $${m.pnl.toFixed(2)}  PF ${m.pf.toFixed(2)}  WR ${m.wr.toFixed(1)}%  DD ${Math.abs(m.dd).toFixed(1)}%  T ${m.trades}${A.r}${dur ? `  ${A.d}${dur}${A.r}` : ""}`,
    );
    // Line 2: summary (if present)
    if (m.summary) {
      lines.push(`${A.d}         ${m.summary}${A.r}`);
    }
  }

  return lines.join("\n");
}
