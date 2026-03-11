import type { IterationMetric } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VariantSummaryInfo {
  id: string;
  status: "active" | "plateaued" | "complete" | "killed";
  bestScore: number;
  bestPnl: number;
  iterationsUsed: number;
  killReason?: string;
  plateauReason?: string;
}

export interface SummaryOpts {
  asset: string;
  strategy?: string;
  runId: string;
  metrics: IterationMetric[];
  variants: VariantSummaryInfo[];
  durationMs: number;
  totalIters: number;
  globalBestVariantId: string;
  globalBestScore: number;
  globalBestPnl: number;
  globalBestIter: number;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtRow(m: IterationMetric): string {
  const dur = m.durationMs != null ? `  ${fmtDuration(m.durationMs)}` : "";
  return `PnL $${m.pnl.toFixed(2)}  PF ${m.pf.toFixed(2)}  WR ${m.wr.toFixed(0)}%  DD ${Math.abs(m.dd).toFixed(1)}%  AvgR ${m.avgR.toFixed(2)}  T ${m.trades}${dur}`;
}

/** Group metrics by variantId, preserving insertion order. */
function groupByVariant(metrics: IterationMetric[]): Map<string, IterationMetric[]> {
  const map = new Map<string, IterationMetric[]>();
  for (const m of metrics) {
    const key = m.variantId ?? "_seed";
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(m);
  }
  return map;
}

function statusSuffix(v: VariantSummaryInfo): string {
  if (v.status === "killed") {
    return v.killReason ? `killed (${v.killReason})` : "killed";
  }
  const parts: string[] = [v.status];
  if (v.bestScore > 0) parts.push(`score ${v.bestScore.toFixed(1)}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// WhatsApp summary (plain text, no ANSI)
// ---------------------------------------------------------------------------

export function buildSessionSummary(opts: SummaryOpts): string {
  const {
    asset, strategy, runId, metrics, variants, durationMs, totalIters,
    globalBestVariantId, globalBestScore, globalBestPnl, globalBestIter,
    success,
  } = opts;

  const icon = success ? "\u{2705}" : "\u{26A0}\u{FE0F}";
  const status = success ? "CRITERIA PASSED" : "MAX ITER REACHED";
  const label = strategy ? `${asset}/${strategy}` : asset;

  const lines: string[] = [];
  lines.push(`${icon} *B.R.E.A.K.E.R. — ${label}*`);
  lines.push(`${status}  |  ${fmtDuration(durationMs)}  |  ${totalIters} iters  |  ${variants.length} variants`);
  lines.push(`BEST: ${globalBestVariantId}  |  score ${globalBestScore.toFixed(1)}  |  PnL $${globalBestPnl.toFixed(2)}`);
  lines.push(`Run: ${runId}`);
  lines.push("");

  const grouped = groupByVariant(metrics);

  for (const v of variants) {
    const vMetrics = grouped.get(v.id) ?? [];
    const suffix = statusSuffix(v);

    if (v.status === "killed" && vMetrics.length === 0) {
      lines.push(`-- ${v.id} -- ${suffix}`);
      continue;
    }

    lines.push(`-- ${v.id} (${vMetrics.length} iters) -- ${suffix}`);
    for (const m of vMetrics) {
      const arrow = m.verdict === "improved" ? "\u{2B06}\u{FE0F}" :
                    m.verdict === "degraded" ? "\u{2B07}\u{FE0F}" : "\u{27A1}\u{FE0F}";
      const star = m.iter === globalBestIter && v.id === globalBestVariantId ? "\u{2B50} " : "";
      lines.push(`  ${star}${arrow} iter ${m.iter}  ${fmtRow(m)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
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

// ---------------------------------------------------------------------------
// Console summary (ANSI colored)
// ---------------------------------------------------------------------------

export function buildConsoleSummary(opts: SummaryOpts): string {
  const {
    asset, strategy, metrics, variants, durationMs, totalIters,
    globalBestVariantId, globalBestScore, globalBestPnl, globalBestIter,
    success,
  } = opts;
  const label = strategy ? `${asset}/${strategy}` : asset;

  const statusColor = success ? A.grn : A.ylw;
  const statusText = success ? "CRITERIA PASSED" : "MAX ITER REACHED";

  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(`  ${A.b}B.R.E.A.K.E.R.${A.r} — ${label}`);
  lines.push(`  ${statusColor}${statusText}${A.r}  ${A.d}│${A.r}  ${fmtDuration(durationMs)}  ${A.d}│${A.r}  ${totalIters} iters  ${A.d}│${A.r}  ${variants.length} variants`);
  lines.push(`  BEST: ${A.b}${globalBestVariantId}${A.r}  ${A.d}│${A.r}  score ${A.b}${globalBestScore.toFixed(1)}${A.r}  ${A.d}│${A.r}  PnL ${A.b}$${globalBestPnl.toFixed(2)}${A.r}`);

  if (metrics.length === 0) return lines.join("\n");

  const grouped = groupByVariant(metrics);

  for (const v of variants) {
    const vMetrics = grouped.get(v.id) ?? [];
    const suffix = statusSuffix(v);

    lines.push("");

    if (v.status === "killed" && vMetrics.length === 0) {
      lines.push(`  ${A.d}── ${v.id} ── ${suffix}${A.r}`);
      continue;
    }

    lines.push(`  ${A.d}── ${v.id} (${vMetrics.length} iters) ── ${suffix}${A.r}`);

    for (const m of vMetrics) {
      const isGlobalBest = m.iter === globalBestIter && v.id === globalBestVariantId;
      const arrow = m.verdict === "improved" ? `${A.grn}▲${A.r}`
                 : m.verdict === "degraded" ? `${A.red}▼${A.r}`
                 : `${A.d}─${A.r}`;

      const color = isGlobalBest ? A.grn : A.d;
      const star = isGlobalBest ? "⭐ " : "";

      lines.push(
        `  ${star}${arrow} ${color}iter ${m.iter}${A.r}  ${color}${fmtRow(m)}${A.r}`,
      );
    }
  }

  return lines.join("\n");
}
