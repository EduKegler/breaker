import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "../types.js";
import { runClaude } from "./run-claude.js";

export interface ResearchBrief {
  queries: string[];
  findings: { source: string; summary: string }[];
  suggestedApproaches: { name: string; indicators: string[]; entryLogic: string; rationale: string }[];
  timestamp: string;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Conduct research by spawning Claude CLI with WebSearch and Context7 tools.
 * Claude writes a research-brief.json to the artifacts dir.
 */
export async function conductResearch(opts: {
  asset: string;
  currentMetrics: { pnl: number; pf: number; wr: number; dd: number };
  exhaustedApproaches: string[];
  artifactsDir: string;
  model: string;
  timeoutMs: number;
  repoRoot: string;
  allowedDomains?: string[];
}): Promise<StageResult<ResearchBrief>> {
  const { asset, currentMetrics, exhaustedApproaches, artifactsDir, model, timeoutMs, repoRoot, allowedDomains } = opts;

  const briefPath = path.join(artifactsDir, "research-brief.json");

  // Delete stale brief from previous attempt to avoid optimize using outdated data
  try { fs.unlinkSync(briefPath); } catch { /* ignore if not exists */ }

  const exhaustedList = exhaustedApproaches.length > 0
    ? `\nExhausted approaches (do NOT repeat):\n${exhaustedApproaches.map((a) => `- ${a}`).join("\n")}`
    : "";

  const domainRestriction = allowedDomains && allowedDomains.length > 0
    ? `\nSOURCE QUALITY TIERS:
Trusted domains: ${allowedDomains.join(", ")}
- Findings from trusted domains: use directly
- Findings from OTHER domains: you may still consider them, but mark as "[UNVERIFIED SOURCE]" in the findings summary. Most trading blogs are low-quality affiliate content — treat unverified sources with skepticism.`
    : "";

  const prompt = `You are a quantitative trading researcher. Your task is to research alternative trading strategies for ${asset} on the 15-minute timeframe.

Current strategy performance:
- PnL: $${currentMetrics.pnl}
- Profit Factor: ${currentMetrics.pf}
- Win Rate: ${currentMetrics.wr}%
- Max Drawdown: ${currentMetrics.dd}%
${exhaustedList}${domainRestriction}

INSTRUCTIONS:
1. Use WebSearch to find 2-3 promising trading strategies/approaches for ${asset} 15m timeframe
2. Focus on: momentum, mean reversion, volatility breakout, or regime-based approaches
3. Look for Pine Script implementations and indicator combinations
4. Use Context7 to look up Pine Script documentation for any indicators you find

Write your findings as a JSON file to ${briefPath} with this exact structure:
{
  "queries": ["search query 1", "search query 2"],
  "findings": [{"source": "url or description", "summary": "what was found"}],
  "suggestedApproaches": [
    {
      "name": "Approach Name",
      "indicators": ["RSI", "Bollinger Bands"],
      "entryLogic": "Description of entry/exit logic",
      "rationale": "Why this might work better"
    }
  ],
  "timestamp": "${new Date().toISOString()}"
}

Write ONLY the JSON file. Do not modify any other files.`;

  try {
    const result = await runClaude(
      ["--model", model, "--dangerously-skip-permissions", "--allowedTools", "WebSearch,mcp__context7__resolve-library-id,mcp__context7__query-docs,Read,Write", "-p", prompt],
      { cwd: repoRoot, timeoutMs, label: "research" },
    );

    if (result.status !== 0) {
      log(`Research Claude exited with code ${result.status}`);
      return { success: false, error: `Research failed: exit code ${result.status}` };
    }

    // Read the brief
    if (!fs.existsSync(briefPath)) {
      log("Research brief file not created — falling back");
      return { success: false, error: "research-brief.json not created" };
    }

    const raw = fs.readFileSync(briefPath, "utf8");
    let brief: ResearchBrief;
    try {
      brief = JSON.parse(raw) as ResearchBrief;
    } catch {
      log("Research brief is not valid JSON — falling back");
      return { success: false, error: "research-brief.json is not valid JSON" };
    }

    // Basic validation
    if (!brief.suggestedApproaches || !Array.isArray(brief.suggestedApproaches)) {
      return { success: false, error: "research-brief.json missing suggestedApproaches" };
    }

    return { success: true, data: brief };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
