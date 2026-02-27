# BREAKER - Periodic Code Review Checklist

> **Monorepo:** pnpm workspaces. Run tools per-package, not from root.
> Run this checklist every 1-2 weeks or after major feature additions.
> Copy this into a new issue/doc and check off items as you go.

---

## 1. Architecture & Code Organization

- [ ] **Extract shared utilities to `@breaker/kit`**
  - Scan for pure functions duplicated across modules (formatters, validators, math helpers)
  - Look for generic type utilities that aren't domain-specific
  - Check for shared constants (timeframes, session times, thresholds) that live in random files
  - Identify reusable hooks or composable logic (retry, polling, debounce patterns)
  - _Prompt:_ "List all exported functions in `src/`. Which ones are pure, stateless, and used by 2+ modules? Those are candidates for `@breaker/kit`."

- [ ] **Module boundaries are clean (pnpm monorepo)**
  - No circular dependencies between packages (check per-package, not root)
  - Each module has a clear single responsibility
  - Imports flow in one direction (kit -> domain -> application)
  - _Tool:_ `pnpm -r exec npx madge --circular --extensions ts src/`

- [ ] **Dead code removal**
  - Unused exports, variables, types
  - Commented-out code blocks older than 2 weeks
  - Unreachable branches or impossible conditions
  - _Tool:_ `npx ts-prune` or `npx knip`

- [ ] **Zod schemas stay in sync**
  - Config files validated at startup with Zod schemas (fail-fast on bad config)
  - API response schemas match current Hyperliquid SDK types
  - New config fields added to both the config file AND the Zod schema

---

## 2. Test Coverage & Quality

- [ ] **Find untested code paths**
  - Run coverage report: `npx vitest --coverage`
  - Focus on: files < 60% branch coverage
  - Priority targets: any file touching money/orders/positions
  - _Prompt:_ "Given this coverage report, which uncovered lines handle critical trading logic (entries, exits, position sizing, risk checks)?"

- [ ] **Test quality audit**
  - Tests assert behavior, not implementation details
  - Edge cases covered: zero values, negative numbers, empty arrays, boundary conditions
  - Trading-specific edges: partial fills, slippage, session boundaries, weekend gaps
  - No flaky tests (time-dependent, order-dependent)

- [ ] **Missing test categories**
  - Unit tests for all pure calculation functions
  - Integration tests for strategy pipelines (signal -> filter -> entry -> exit)
  - Snapshot tests for indicator outputs against known data
  - Error path tests: what happens when API returns garbage?

---

## 3. Observability & Debugging

- [ ] **Structured logging coverage**
  - Every external API call logs: request params, response status, latency
  - Strategy decisions log: signal type, confidence, filters applied, final decision
  - Position lifecycle logs: open reason, size, entry price, exit reason, exit price, PnL
  - Rate limit / retry events with backoff info
  - _Format:_ `{ timestamp, level, module, action, ...context }` (JSON for parsing)

- [ ] **Error context is sufficient**
  - Errors include: what was attempted, with what inputs, what failed
  - Stack traces preserved (no swallowed errors with generic messages)
  - Network errors log: endpoint, method, status code, response body snippet

- [ ] **Debug mode / dry-run flags**
  - Can enable verbose logging per module without code changes
  - Dry-run mode logs what WOULD happen without executing trades
  - Paper trading mode validates full flow without real money

---

## 4. Flow & Readability

- [ ] **Code is concise and intention-revealing**
  - Functions are < 30 lines (extract if longer)
  - No deeply nested if/else chains (> 3 levels) -- use early returns or strategy pattern
  - Variable names describe WHAT, not HOW (`maxRiskPerTrade` not `val2`)
  - Complex conditions extracted into named booleans (`const isValidEntry = ...`)

- [ ] **Strategy flow is traceable**
  - Can follow a trade from signal detection to order execution in < 5 file hops
  - Each step in the pipeline has clear input/output types
  - Decision points are documented with WHY comments, not WHAT comments

- [ ] **Configuration over hardcoding**
  - Magic numbers extracted to config with descriptive names
  - Session times, thresholds, timeouts are configurable
  - Secrets in `.env` ONLY; operational config (endpoints, params) in config files like `exchange-config.json` -- not hardcoded in source (see AGENTS.md)

---

## 5. Security & Safety

- [ ] **Critical: API key / secret handling**
  - No secrets in code, git history, or logs
  - Keys loaded from env vars or secret manager only
  - API keys have minimum required permissions (read-only where possible)
  - _Check:_ `git log --all -p | grep -i "secret\|apikey\|private_key"` (scan history)

- [ ] **Critical: Order safety guards**
  - Maximum position size enforced at code level (not just config)
  - Maximum loss per trade / per day hard limits
  - Rate limiting on order submission (prevent accidental spam)
  - Kill switch via `maxTradesPerDay: 0` in config works correctly; _TODO:_ evaluate explicit `enabled: false` flag for clearer intent
  - Sanity checks: reject orders with obviously wrong prices (> X% from market)

- [ ] **Critical: Input validation**
  - All external data (API responses, websocket messages) validated with Zod before use
  - Price/quantity values checked for: NaN, Infinity, negative, zero, absurd magnitude
  - Timestamps validated (not in the future, not stale beyond threshold)

- [ ] **Network & state safety**
  - Reconnection logic for websockets with state reconciliation
  - Idempotency: router deduplicates via `alert_id` in SQLite + Redis (ESTABLISHED PATTERN -- verify it covers all entry points, not just the main router)
  - Graceful degradation: what happens if Hyperliquid API is down for 5 min?

---

## 6. Bug Hunting (High & Critical)

- [ ] **Race conditions**
  - Concurrent strategy signals don't create conflicting orders
  - Position state is consistent between check and order placement
  - Websocket reconnect doesn't miss or duplicate messages

- [ ] **Floating point traps**
  - Financial math uses precision helpers (`truncateSize()`, `truncatePrice()` via `toPrecision(5)` / `szDecimals`) consistently before every calculation and SDK call
  - No raw `number` arithmetic on prices/sizes without truncation applied afterward
  - Comparison operators on prices account for truncation (don't compare pre- vs post-truncated values)
  - Rounding is explicit and consistent (floor for buys, ceil for sells)
  - _TODO:_ Evaluate if migrating to a Decimal library is worth it as complexity grows

- [ ] **State management bugs**
  - Stale state after errors (failed order leaves position tracker in wrong state)
  - Memory leaks: intervals/timeouts/listeners cleaned up on shutdown
  - State persisted correctly across restarts (no orphaned positions)

- [ ] **Graceful shutdown sequence**
  - SIGTERM/SIGINT handler defined and tested
  - On shutdown: cancel all pending/open orders before exit
  - On shutdown: close or log open positions (configurable: close vs leave with trailing stop)
  - On shutdown: flush pending logs and persist state to disk/DB
  - On shutdown: close websocket connections cleanly (not just process.exit)
  - Restart recovery: on startup, reconcile local state with exchange state (detect orphaned positions)

- [ ] **Boundary / edge cases**
  - Session transitions (what happens at exact session open/close?)
  - Midnight UTC rollover
  - First candle of the day (no previous data)
  - Market holidays / low liquidity periods
  - Order fills at exactly stop loss or take profit price

- [ ] **Hyperliquid SDK traps**
  - `floatToWire()` rejects non-truncated values -- verify `truncateSize()` / `truncatePrice()` applied before EVERY SDK call
  - Symbol format consistency: `BTC-PERP` vs `BTC` -- `toSymbol()` adapter always used
  - SDK version pinned; check changelog for breaking changes on update
  - Leverage and margin mode set correctly before order placement (not assumed from previous state)

---

## 7. Performance

- [ ] **No unnecessary work in hot paths**
  - Indicator calculations cached when input hasn't changed
  - Websocket message handlers are fast (< 1ms) -- offload heavy work
  - No synchronous I/O in the trading loop

- [ ] **Memory management**
  - Candle/tick history has a max length (not growing unbounded)
  - Old logs rotated or cleaned up
  - Large objects (order book snapshots) garbage-collected properly

---

## 8. Documentation & Maintainability

- [ ] **Critical paths are documented**
  - README covers: setup, config, running, testing
  - Each strategy module has a header comment explaining the thesis
  - Risk parameters documented with rationale for chosen values

- [ ] **Changelog discipline**
  - Breaking changes are noted
  - Strategy parameter changes logged with before/after and reasoning

---

## Quick Commands Reference

```bash
# Circular dependencies (per package -- monorepo)
pnpm -r exec npx madge --circular --extensions ts src/

# Dead code / unused exports
npx knip

# Test coverage
pnpm test -- --coverage

# Type check (monorepo)
pnpm typecheck

# Secret scanning
git secrets --scan  # or gitleaks detect

# Find TODOs and FIXMEs
grep -rn "TODO\|FIXME\|HACK\|XXX" packages/
```

---

## AI-Assisted Review Prompts

Use these prompts when pasting code into Claude or another AI for review:

1. **Kit extraction:** "Here are my source files. List all pure, stateless functions that are used by more than one module. For each, suggest if it belongs in a shared `@breaker/kit` package."

2. **Test gaps:** "Here is my source code and my test files. Identify the most critical untested code paths, prioritized by risk (anything touching orders, positions, or money first)."

3. **Logging audit:** "Review this module. Where would structured log statements help debug production issues? Suggest specific log lines with context fields."

4. **Bug hunt:** "Analyze this code for race conditions, floating point errors, state inconsistencies, and unhandled edge cases. Focus on high and critical severity only."

5. **Security review:** "Review this code for security issues: exposed secrets, missing input validation, unsafe external data handling, and missing safety guards for trading operations."