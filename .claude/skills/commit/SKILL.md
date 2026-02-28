---
name: commit
description: Commit and push changes. Use when the user says "commit", "commit and push", "commita", "commita e pusha", "manda pro git", "salva no git", or wants to commit current changes.
argument-hint: "[message]"
disable-model-invocation: true
allowed-tools: "Bash, Read, Glob, Grep, Edit"
---

# Commit, Validate & Push

Validate, commit, and push current changes following project conventions.

## Steps

### 1. Check for changes

```bash
git status
git diff --stat
```

If the working tree is clean (nothing to commit), inform the user and STOP.

### 2. Build & Test

```bash
pnpm build && pnpm test
```

If build or unit tests fail, show the errors and STOP. Do not commit broken code.

Then run E2E tests:

```bash
pnpm test:e2e
```

- If E2E fails due to **auth expired/absent** (TradingView login required) → warn the user but **do not block** the commit (auth is external)
- If E2E fails due to **code errors** → show errors and STOP

### 3. Verify .md files

Read the git diff and check if the following files need updates:

- **CLAUDE.md** (root and package-level) — Any new convention or pattern that should be documented?
- **AGENTS.md** — Any new convention that should be documented?
- **README.md** — Are usage instructions still valid?

If any .md needs updating, **update it before committing** (using Edit tool). Show the user what was changed.

### 4. Generate commit message

Analyze all changes (`git diff --staged` + `git diff`) and generate a message following **Conventional Commits**:

```
type(scope): description
```

- **Types**: feat, fix, refactor, test, docs, chore, perf, ci
- **Scope**: affected module (webhook, dashboard, automation, lib, infra, etc.)
- **Description**: imperative, concise, focuses on the "why"
- **Language**: always in English, regardless of the user's language

If `$ARGUMENTS` contains a message, use it as the base for the commit message.

**NEVER include Co-Authored-By or any AI attribution** (global rule).

### 5. Stage, Commit & Push

- `git add` relevant files explicitly (do NOT use `git add -A` — avoid committing secrets like .env)
- `git commit` with the generated message (use HEREDOC format)
- `git push`
- Show the final result to the user

### 6. Knowledge Base drift check

**MANDATORY**: you MUST actually read `docs/knowledge-base.md` using the Read tool. Do NOT skip this step or assume the file doesn't exist without checking.

1. Read `docs/knowledge-base.md` (if the file doesn't exist, say so and skip the rest of this step).
2. Cross-check the KB content against the actual codebase:
   - **Strategy descriptions**: do indicators, entry rules, exit rules, and free variables described in the KB match the actual `.ts` strategy files in `packages/backtest/src/strategies/`?
   - **BREAKER Results tables**: are PF, WR, DD, Trades, PnL values current or stale?
   - **Config values**: do criteria, profiles, and guardrails described in the KB match `packages/refiner/breaker-config.json`?
   - **Operational limits**: do daily limits, consecutive loss rules, session descriptions match the strategy code?
   - **Iron rules / glossary**: any values that contradict what the code actually does?

**DO NOT update** `knowledge-base.md` — only **list the discrepancies** found (if any) so the user can decide what to fix. If everything matches, say so.
