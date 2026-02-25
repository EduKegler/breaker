# MEMORY — Current Project State

Updated: 2026-02-25

## Current state

- **VPS**: tv.kegler.dev (Docker + Caddy HTTPS)
- **Pipeline**: TradingView alert → webhook → Evolution API → WhatsApp
- **641 tests** (30 files), build OK
- **Date range**: configurable via `breaker-config.json` (global + per-strategy), supports presets + custom:YYYY-MM-DD:YYYY-MM-DD
- **Strategies**: BTC/breakout (squeeze.pine), BTC/mean-reversion (keltner-rsi2.pine)
- **Knowledge base**: `docs/knowledge-base.md` (source of truth for strategy research & decisions)

## Pending items (by priority — follow knowledge-base)

### Phase 2: Refine (current)
- [x] breakout: PF 1.733, DD 4.89%, WR 52% — criteria met (PF>1.6, DD<6%)
- [ ] mean-reversion: restructured VWAP→Keltner RSI2 (iter 21-25). Best: PF 0.857, 113t, PnL -48.58. Needs more tuning (PF target 1.4)

### Phase 3: Integrate (after both validated)
- [ ] Run Mod1 + Mod2 in parallel — verify no overlap
- [ ] Measure combined result (portfolio PF, combined DD)

### Backlog
- [ ] VPS deploy with working REDIS_URL
- SUI, ETH, SOL — paused until BTC Mod1+Mod2 validated

## Known pitfalls

- **Squeeze filter is critical**: without it WR drops 42%→24%, trades explode. NEVER remove.
- **SessionEnd close is necessary**: without it trades accumulate overnight, DD explodes.
- **R:R < 2.0 and rrTarget=2.5 both worse**: winners hitting 3R matter; 73% close at SessionEnd anyway.
- **adxMin=25 is anti-predictive**: ADX 20-25 trades have better WR. Confirmed 2x.
- **4H trend guard + RSI degraded breakout**: score dropped 65.8→54.5. Don't add higher-TF filters.
- **Checkpoint must be reset on structural rewrite**: orchestrator restores best.pine at end-of-loop — if checkpoint has old strategy code, new code gets overwritten.

## Non-obvious decisions

- **Stop via 1h ATR × 1.5 (not 15m)**: 15m ATR on BTC is noise.
- **Sessions are structural, not optimizable**: hardcoded NY/London times. Reduces overfit.
- **Score weights**: PF 25%, avgR 20%, WR 10%, DD 15%, Complexity 10%, Sample 20% (denom 150 trades).
- **Criteria raised after EMA50 filter**: minPF=1.8, minWR=42, maxDD=4, minTrades=60. High bar forces sample optimization.
- **rollbackThreshold = 0.08**: was 0.15, lowered because 9% degradation wasn't triggering.
- **protectedFields includes temporal filters**: badDay, useDayFilter, blockedHours, blockedDays.
- **Breakout trades vs PF tension**: ~54 signals/year natural. Forcing ≥70 trades degrades PF (1.34 vs 2.32).
- **countPineInputs skips strategy() args**: multi-line declaration was counted as free vars.
- **End-of-loop restore**: orchestrator restores checkpoint at end (optimize was overwriting on last iter).
- **resolveAssetCriteria 3-layer merge**: global → assetClass → strategyProfile → ResolvedCriteria.
- **Redis policy**: REDIS_URL set = fail-fast if Redis down. Without it, degraded memory mode with `/health` signaling.
- **Anti-overfit hardening**: strategyProfiles, variable count gate, session breakdown, walk-forward with pfRatio.
