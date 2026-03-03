---
name: kb-drift
description: Check knowledge base for drift against codebase. Use when the user says "kb drift", "verifica kb", "knowledge base check", "drift check", "checa o kb", "kb desatualizado", or wants to verify if the knowledge base matches the code.
allowed-tools: "Read, Glob, Grep, Agent"
---

# Knowledge Base Drift Check

Cross-check `docs/knowledge-base.md` against the actual codebase to find discrepancies.

## Steps

### 1. Read the Knowledge Base

Read `docs/knowledge-base.md`. If the file doesn't exist, inform the user and STOP.

### 2. Cross-check against codebase

Use Agent (Explore) subagents in parallel to check each area:

#### a) Strategy descriptions
- Read strategy `.ts` files in `packages/backtest/src/strategies/`
- Compare indicators, entry rules, exit rules, and free variables described in the KB against actual code
- Check that param names, ranges, and defaults match

#### b) Config values
- Read `packages/refiner/breaker-config.json`
- Compare criteria, profiles (minPF, maxDD, minWR, minTrades, maxFreeVariables), and guardrails against KB values
- Check scoring weights match

#### c) Operational limits
- Read `packages/exchange/exchange-config.json` and relevant source files
- Compare daily limits, consecutive loss rules, session descriptions, risk parameters
- Check orchestrator gates (daily loss, trades/day, module pause) match KB

#### d) Iron rules & glossary
- Verify any hardcoded values or rules mentioned in KB match the actual code behavior
- Check that canonical parameters (fees, slippage, risk per trade) are consistent

#### e) BREAKER Results tables
- Check if PF, WR, DD, Trades, PnL values in the KB are marked as stale or outdated
- Note any results that reference old strategy versions

### 3. Report findings

Present a structured report:

```
## KB Drift Report

### Discrepancies found
- [section] description of mismatch (KB says X, code says Y)

### Matches confirmed
- [section] brief summary of what was checked and matches

### Stale data
- [section] data that may be outdated but can't be verified against code alone
```

**DO NOT update** `knowledge-base.md` — only list discrepancies so the user can decide what to fix.
