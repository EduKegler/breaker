#!/usr/bin/env node
/**
 * dashboard.ts — B.R.E.A.K.E.R. Dashboard
 * Usage: node dist/dashboard/dashboard.js [--html]
 * Reads the latest artifacts/{run}/events.ndjson and prints a summary
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { isMainModule } from "@breaker/kit";
import type { DashboardEvent } from "../types/events.js";
import { detectAnomalies } from "./anomalies.js";
import { safeJsonParse } from "../lib/safe-json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const artifactsDir = path.join(ROOT, "artifacts");

function getLatestRun(): string {
  if (!fs.existsSync(artifactsDir)) {
    console.error("No artifacts directory found at: " + artifactsDir);
    process.exit(1);
  }

  const runs = fs
    .readdirSync(artifactsDir)
    .filter((name) => {
      const full = path.join(artifactsDir, name);
      return fs.statSync(full).isDirectory();
    })
    .sort();

  if (runs.length === 0) {
    console.error("No run directories found in: " + artifactsDir);
    process.exit(1);
  }

  const latestDir = path.join(artifactsDir, runs[runs.length - 1]);
  const eventsFile = path.join(latestDir, "events.ndjson");

  if (!fs.existsSync(eventsFile)) {
    console.error("No events.ndjson found in: " + latestDir);
    process.exit(1);
  }

  return eventsFile;
}

const dashboardEventSchema = z.object({
  ts: z.string(),
  iter: z.number(),
  stage: z.string(),
  status: z.string(),
  pnl: z.number().default(0),
  pf: z.number().default(0),
  dd: z.number().default(0),
  trades: z.number().default(0),
  message: z.string().default(""),
  run_id: z.string(),
  asset: z.string().default(""),
  anomalies: z.array(z.string()).optional(),
});

function parseEvents(file: string): DashboardEvent[] {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events: DashboardEvent[] = [];
  for (const line of lines) {
    try {
      events.push(safeJsonParse(line, { schema: dashboardEventSchema }) as DashboardEvent);
    } catch {
      // Skip malformed lines or lines that fail schema validation
    }
  }
  return events;
}

function padR(str: string | number, width: number): string {
  const s = String(str);
  return s.length >= width
    ? s.slice(0, width)
    : s + " ".repeat(width - s.length);
}

function padL(str: string | number, width: number): string {
  const s = String(str);
  return s.length >= width
    ? s.slice(0, width)
    : " ".repeat(width - s.length) + s;
}

export function printSummary(events: DashboardEvent[]): void {
  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  const enriched = detectAnomalies(events);
  const runId = enriched[0].run_id;
  const totalIters = Math.max(
    ...enriched.map((e) => Number(e.iter) || 0),
  );

  const parseDoneEvents = enriched.filter(
    (e) => e.stage === "PARSE_DONE",
  );
  const lastParse =
    parseDoneEvents.length > 0
      ? parseDoneEvents[parseDoneEvents.length - 1]
      : null;

  console.log("");
  console.log("=== B.R.E.A.K.E.R. Dashboard ===");
  console.log("Run ID   : " + runId);
  console.log("Events   : " + enriched.length);
  console.log("Max Iter : " + totalIters);

  if (lastParse) {
    console.log("");
    console.log("--- Latest Metrics (iter " + lastParse.iter + ") ---");
    console.log("  PnL    : " + lastParse.pnl);
    console.log("  PF     : " + lastParse.pf);
    console.log("  DD     : " + lastParse.dd + "%");
    console.log("  Trades : " + lastParse.trades);
  }

  const last10 = enriched.slice(-10);
  console.log("");
  console.log("--- Last " + last10.length + " Events ---");
  const header = [
    padR("TIMESTAMP", 21),
    padL("ITER", 4),
    padR("STAGE", 16),
    padR("STATUS", 8),
    padL("PNL", 10),
    padL("PF", 6),
    padL("DD", 6),
    padL("TRADES", 7),
    "MESSAGE",
  ].join("  ");
  const sep = "-".repeat(header.length);
  console.log(header);
  console.log(sep);

  for (const e of last10) {
    const flag = e.anomalies?.length ? " [!]" : "";
    const row = [
      padR(e.ts || "", 21),
      padL(String(e.iter || 0), 4),
      padR(e.stage || "", 16),
      padR(e.status || "", 8),
      padL(String(e.pnl || 0), 10),
      padL(String(e.pf || 0), 6),
      padL(String(e.dd || 0), 6),
      padL(String(e.trades || 0), 7),
      (e.message || "") + flag,
    ].join("  ");
    console.log(row);
    if (e.anomalies?.length) {
      for (const a of e.anomalies) {
        console.log("         [!] " + a);
      }
    }
  }
  console.log("");
}

export function generateHTML(events: DashboardEvent[]): string {
  if (events.length === 0) {
    return "<html><body><p>No events found.</p></body></html>";
  }

  const enriched = detectAnomalies(events);
  const runId = enriched[0].run_id;
  const totalIters = Math.max(
    ...enriched.map((e) => Number(e.iter) || 0),
  );

  const parseDoneEvents = enriched.filter(
    (e) => e.stage === "PARSE_DONE",
  );
  const lastParse =
    parseDoneEvents.length > 0
      ? parseDoneEvents[parseDoneEvents.length - 1]
      : null;

  const pnlSeries = parseDoneEvents.map((e) => ({
    iter: e.iter,
    pnl: Number(e.pnl) || 0,
    pf: Number(e.pf) || 0,
    dd: Number(e.dd) || 0,
  }));

  const pnlValues = pnlSeries.map((p) => p.pnl);
  const maxPnl = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
  const minPnl = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;
  const range = maxPnl - minPnl || 1;
  const chartHeight = 80;
  const chartWidth = Math.max(pnlValues.length * 30, 300);

  let svgPath = "";
  let svgPoints = "";
  if (pnlValues.length > 0) {
    const points = pnlValues.map((v, i) => {
      const x =
        (i / Math.max(pnlValues.length - 1, 1)) * chartWidth;
      const y =
        chartHeight - ((v - minPnl) / range) * chartHeight;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    svgPath =
      '<polyline points="' +
      points.join(" ") +
      '" fill="none" stroke="#4CAF50" stroke-width="2"/>';
    svgPoints = points
      .map((pt, i) => {
        const [x, y] = pt.split(",");
        return (
          '<circle cx="' +
          x +
          '" cy="' +
          y +
          '" r="3" fill="#4CAF50" title="iter ' +
          pnlSeries[i].iter +
          ": " +
          pnlValues[i] +
          '"/>'
        );
      })
      .join("");
  }

  const esc = (v: unknown): string =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const tableRows = enriched
    .map((e) => {
      const statusColor =
        e.status === "success"
          ? "#4CAF50"
          : e.status === "error"
            ? "#f44336"
            : "#2196F3";
      const anomalyHtml = e.anomalies?.length
        ? ` <span title="${esc(e.anomalies.join("; "))}" style="color:#FFC107;cursor:help">&#9888;</span>`
        : "";
      return `    <tr>
      <td>${esc(e.ts)}</td>
      <td>${esc(e.iter || 0)}</td>
      <td>${esc(e.stage)}</td>
      <td style="color:${statusColor};font-weight:bold">${esc(e.status)}${anomalyHtml}</td>
      <td>${esc(e.pnl || 0)}</td>
      <td>${esc(e.pf || 0)}</td>
      <td>${esc(e.dd || 0)}</td>
      <td>${esc(e.trades || 0)}</td>
      <td>${esc(e.message)}</td>
    </tr>`;
    })
    .join("\n");

  const latestMetrics = lastParse
    ? `
  <div class="metrics">
    <div class="metric"><span class="label">Latest PnL</span><span class="value">${lastParse.pnl}</span></div>
    <div class="metric"><span class="label">Profit Factor</span><span class="value">${lastParse.pf}</span></div>
    <div class="metric"><span class="label">Max Drawdown</span><span class="value">${lastParse.dd}%</span></div>
    <div class="metric"><span class="label">Total Trades</span><span class="value">${lastParse.trades}</span></div>
  </div>`
    : "";

  const chartSection =
    pnlValues.length > 0
      ? `
  <h2>PnL Over Iterations</h2>
  <div style="overflow-x:auto">
    <svg width="${chartWidth}" height="${chartHeight + 20}" style="border:1px solid #444;background:#1e1e1e;display:block;margin:0 auto">
      ${svgPath}
      ${svgPoints}
      <text x="0" y="${chartHeight + 15}" fill="#aaa" font-size="10">min: ${minPnl}</text>
      <text x="${chartWidth - 60}" y="${chartHeight + 15}" fill="#aaa" font-size="10">max: ${maxPnl}</text>
    </svg>
  </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>B.R.E.A.K.E.R. Dashboard — ${runId}</title>
  <style>
    body { font-family: monospace; background: #121212; color: #e0e0e0; margin: 20px; }
    h1 { color: #4CAF50; }
    h2 { color: #aaa; font-size: 1em; margin-top: 2em; }
    .summary { margin-bottom: 1em; color: #aaa; }
    .metrics { display: flex; gap: 20px; flex-wrap: wrap; margin: 1em 0; }
    .metric { background: #1e1e1e; border: 1px solid #333; padding: 12px 20px; border-radius: 4px; }
    .metric .label { display: block; font-size: 0.75em; color: #888; }
    .metric .value { display: block; font-size: 1.5em; color: #4CAF50; font-weight: bold; }
    table { border-collapse: collapse; width: 100%; margin-top: 1em; font-size: 0.85em; }
    th { background: #1e1e1e; color: #aaa; padding: 8px; text-align: left; border-bottom: 1px solid #444; }
    td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
    tr:hover td { background: #1a1a2e; }
    tr:last-child td { border-bottom: none; }
  </style>
</head>
<body>
  <h1>B.R.E.A.K.E.R. Dashboard</h1>
  <div class="summary">
    <strong>Run ID:</strong> ${runId} &nbsp;|&nbsp;
    <strong>Events:</strong> ${enriched.length} &nbsp;|&nbsp;
    <strong>Max Iter:</strong> ${totalIters}
  </div>
  ${latestMetrics}
  ${chartSection}
  <h2>All Events</h2>
  <table>
    <thead>
      <tr>
        <th>Timestamp</th>
        <th>Iter</th>
        <th>Stage</th>
        <th>Status</th>
        <th>PnL</th>
        <th>PF</th>
        <th>DD</th>
        <th>Trades</th>
        <th>Message</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
  <p style="color:#444;margin-top:2em;font-size:0.75em">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;
}

// Only run when executed directly
if (isMainModule(import.meta.url)) {
  const eventsFile = getLatestRun();
  const events = parseEvents(eventsFile);

  if (process.argv.includes("--html")) {
    const html = generateHTML(events);
    const outPath = path.join(ROOT, "dashboard.html");
    writeFileAtomic.sync(outPath, html);
    console.log("Dashboard written to " + outPath);
  } else {
    printSummary(events);
  }
}
