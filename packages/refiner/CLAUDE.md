# CLAUDE Instructions — refiner

## Project overview
B.R.E.A.K.E.R. — Backtesting & Refinement Engine for Automated Knowledge-driven Execution & Routing. Automated strategy optimization using in-process `@breaker/backtest` engine (no Playwright, no TradingView, no Pine Script).

## Project structure
- `src/automation/` — Prompt builders for Claude optimization/fix (`build-optimize-prompt.ts`, `build-fix-prompt.ts`)
- `src/dashboard/` — Dashboard and anomaly detection
- `src/lib/` — Config, lock, strategy-registry, candle-loader, strategy-path, safe-json
- `src/loop/` — Orchestrator + state-machine (xstate v5) + stages + variant-manager + variant-generator + seed-generator
- `src/types/` — Zod config schemas
- `assets/{asset}/{strategy}/` — Strategy data dir (checkpoints, param history, variant registry)
  - Seed data: `checkpoints/`, `parameter-history.json` (root level)
  - Non-seed variants: `variants/{variant-id}/checkpoints/`, `variants/{variant-id}/parameter-history.json`
  - `variant-registry.json` — runtime artifact, gitignored (absolute paths)
- Strategies live in `packages/backtest/src/strategies/` (shared library)

## Optimization loop
- CLI: `node dist/loop/orchestrator.js --asset=BTC --strategy=breakout --max-iter=20`
- Lock is asset-level (`breaker-BTC.lock`) — prevents concurrent optimization of the same asset.
- **Optimize-first loop**: each iteration runs Optimize → Apply → Backtest → Score → Checkpoint/Rollback (change evaluated in same iteration)
- **The loop STOPS when all criteria met**, unless baseline already passes — then runs all iterations to maximize score.
- Two execution modes:
  - **refine**: param changes only → in-process `runBacktest()` (~2s/iteration)
  - **restructure**: Claude edits strategy `.ts` → typecheck → rebuild → child process (~5s/iteration)
- Phase escalation: refine → research → restructure (automatic when refine plateaus)

## Variant-based optimization
- **Motivacao**: O antigo restructure phase ficava preso em rollback loops — refine melhorava params, restructure degradava, rollback restaurava, loop infinito. Variantes resolvem: cada combinacao de componentes KB e uma tentativa atomica. Plateau = proxima combinacao, nao retry.
- **Ciclo (outer loop)**: seed → refine → plateau → gera nova variante inline → refine → plateau → ... ate esgotar `--max-iter`
- **Outer loop**: quando plateau/kill/budget e detectado, a variante e marcada (`plateaued`/`killed`), nova variante e gerada inline (sem reiniciar o processo), actor xstate e recriado com estado limpo, baseline da nova variante e rodado, e o for-loop continua com iteracoes restantes. Se a geracao falhar (2 tentativas com retry), o loop termina.
- **Variant switch triggers**: (1) phase escalation (neutralStreak, noChangeCount, wfRejectStreak) → plateaued; (2) early kill (PF < thresholds derivados de MODULE_CRITERIA) → killed; (3) per-variant budget exhausted (default 15 iters) → plateaued.
- **Early kill progressivo** (`shouldKillVariant` em phase-helpers.ts): PF < 0.3 = kill imediato; iter 3 = PF < minPF×0.6; iter 6 = PF < minPF×0.75. Thresholds derivados de MODULE_CRITERIA, nao hardcoded.
- **Per-variant budget**: `perVariantBudget` em breaker-config.json (default 15). Forca variant switch mesmo sem plateau de phase.
- **Retry de geracao**: cada call site de `switchToNewVariant` tenta 2x antes de desistir.
- **Sem promocao automatica**: usuario compara scores manualmente via variant-registry.json e decide qual promover.
- Arquivos-chave:
  - `variant-switch.ts` — Funcao `switchToNewVariant()`: encapsula generateVariant → rebuild → import → baseline → checkpoint → score
  - `variant-manager.ts` — Registry (variant-registry.json), naming (buildVariantId, SLOT_PRIORITY), lifecycle (active→plateaued→complete→killed)
  - `variant-generator.ts` — Geracao: pre-seleciona combinacao via `selectNextCombination()` → prompt com componentes atribuidos → Claude implementa → `fixFactoryName()` → `createVariant()`
  - `seed-generator.ts` — Bootstrap: skeleton → optimizeStrategy(restructure) → fixStrategy fallback
  - `build-module-context.ts` — CANDIDATE_SLUGS, STARTING_COMPONENTS (slug-based), extractStartingPoint(), getKbSection(), MODULE_CRITERIA, ComponentCatalog. M1 has "Direction" optional slot (both/long-only/short-only), composite entry signal `squeeze-donchian`, and expanded `partial-tp` exit with dual TP structure
  - `build-optimize-prompt.ts` — preSelectedComponents (restructure com componentes atribuídos), validateSlugComponents() com 3-pass fuzzy matching (alias → prefix/substring → global), formatCatalogForPrompt() mostra slugs em backticks

## Seed auto-bootstrap
- Se seed ausente: variant registry → config-derived path (getStrategySourcePath) → checkpoint restore → gerar do KB via seed-generator.ts
- Seed USA variant naming (buildVariantId(getStartingComponents(moduleId))), NAO o strategyFactory do config
- `esmCacheStale` flag controla in-process vs child-process backtest (true para: seed gerado, transicao post-restructure)

## ESM cache & child-process
- Node ESM module cache nao invalida apos rebuild → `factory()` retorna codigo antigo
- `esmCacheStale = true` forca child-process via `run-engine-child.ts` com dynamic import (strategyFilePath)
- Child-process auto-descobre factory via `Object.keys(mod).find(k => k.startsWith("create"))`
- FACTORIES map em run-engine-child.ts so tem o seed registrado estaticamente; variantes usam dynamic import
- **CRITICO**: Apos gerar nova variante + rebuild, `factory` DEVE ser recarregada via `await import(distPath)` e `esmCacheStale = false`. Sem isso, `factory()` retorna params do seed → no-op detection, guardrails e backtest in-process operam no schema errado. Variantes com params exclusivos (ex: `atrTrailMult` vs seed's `trailMult`) ficam com no-ops falsos

## Rollback puro (loop-state.ts)
- `applyRollback()` e `applyB2Rollback()` sao funcoes puras em `loop-state.ts`
- Orchestrator faz side-effects (checkpoint.rollback, actor.send, fs, emitEvent) e delega restauracao de estado para as funcoes puras
- Testes em `loop-state.test.ts` cobrem fluxos cross-step (rollback → proxima iteracao recebe estado correto)

## Experimental integrity (mandatory)
- Before accepting an iteration result, compare `contentHash` of strategy source.
- During an optimization loop, keep the backtest window fixed; only change in a new round.
- Walk-forward overfit gate (KB §10.1): `validateWalkForward()` in `guardrails.ts` rejects iterations where `overfitFlag=true` (pfRatio < 0.6, i.e., testPF < 60% of trainPF), even if score improved. Prevents promotion of memorized strategies. Absolute PF < 1.0 is NOT checked by the WF guard — it's enforced by scoring criteria. Conflating "bad strategy" with "overfitting" creates a Catch-22 for losing strategies.
- Profitability regression guard: `validateProfitabilityRegression()` in `guardrails.ts` rejects iterations where BOTH PF and avgR worsened vs best checkpoint (prevents trade-count-driven score inflation).
- Checkpoint save decision uses `effectiveVerdict` (not raw score comparison alone). Guardrail-rejected iterations (WF overfit, free variable count, profitability regression) never save checkpoints, and trigger rollback to last good state.
- Checkpoint save bakes optimized params into strategy source via `bakeParamDefaults()` — strategy files become self-contained. Stale params (from previous strategy versions) are auto-cleaned from `best-params.json`.

## Naming (breaker-specific)
- Strategy `name` field: `{ASSET} {TF} {Category} — {Strategy Name}` (e.g. `BTC 15m Breakout — Donchian ADX`).
- Use full names (breakout, mean-reversion), not abbreviations in docs and code.

## Configuration (breaker-specific)
- `.env` for secrets only (API keys, tokens).
- Non-secret config lives in `breaker-config.json` and constants in code.
- Strategy data config in `breaker-config.json`: `coin`, `dataSource`, `interval`, `strategyFactory`, `dateRange`.

## Infra conventions (breaker-specific)
- Shell commands: `execaSync` from `execa` (no `child_process`)
- File writes: `write-file-atomic` (no `fs.writeFileSync`)
- JSON parsing: `safeJsonParse()` from `src/lib/safe-json.ts` — `jsonrepair` for LLM output, Zod schemas for validation
- State management: xstate v5 machine in `src/loop/state-machine.ts` advises phase/counter state; for-loop still drives iteration flow

## Config vs KB alignment
- Scoring weights: `sampleConfidence=0` (gate binário via `sampleFloor`, não recompensa mais trades). Pesos redistribuídos: pf=30, avgR=25, wr=12, dd=18, complexity=15.
- `breaker-config.json` top-level `minPF` set to KB floor (1.3). Strategy profiles can set stricter values.
- Orchestrator enforces KB module floors at runtime via `MODULE_CRITERIA` — config values less strict than KB are auto-bumped.
- M2 (mean-reversion) WR gate: KB requires WR >= 50%. Enforced by MODULE_CRITERIA + orchestrator floor override.

## Strategy files are AI-generated (critical)
- Strategy `.ts` files in `packages/backtest/src/strategies/` are **generated and updated by the refiner's Claude optimizer** via prompts.
- **Never fix bugs by editing strategy files directly** — the next refiner run will overwrite changes.
- Fixes must go into the **prompt** (`build-optimize-prompt.ts`) as hard rules, and/or into the **engine** as runtime validation guards.
- Strategy files should **not have hand-maintained unit tests** — they are ephemeral artifacts. Engine-level tests cover correctness.

## Known pitfalls
- `docs/knowledge-base.md` é parseado em runtime por `extractComponentCatalog()` — alterar formato (headers, tabelas) quebra geração de variantes. Teste de integração em `build-module-context.test.ts` valida com o KB real.
- Can't run breaker inside Claude Code session (nested session protection); use `unset CLAUDECODE`
- `run-engine-child.ts` child-process path E2E validated (~280ms with 26k candles after init() optimization)
- `backoffDelay` extracted to `@breaker/kit` — import from kit, not from loop/
- `pctOfPosition` in `takeProfits` is a **fraction (0-1)**, not a percentage. Engine validates at runtime (`> 1` throws). Enforced in optimizer prompt as hard rule.

## Build and test (breaker-specific)
- Coverage: `pnpm vitest run --coverage`
- Tests: `pnpm test` (791 tests across 34 files)
- After strategy code changes in restructure phase: `pnpm --filter @breaker/backtest typecheck` then `pnpm --filter @breaker/backtest build`
