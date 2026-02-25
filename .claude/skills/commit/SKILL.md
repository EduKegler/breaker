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

### 3. Validate & update MEMORY.MD

Read `MEMORY.MD` and audit it against the current state of the project:

- **Test count**: run `pnpm test` (if not already run in step 2) and verify the reported number matches. Fix if wrong.
- **Stale references**: check that file paths, strategy names, and metric values mentioned in MEMORY.MD still exist and are correct (use Glob/Grep to verify).
- **Line count**: MEMORY.MD must stay under ~50 lines. If it grew beyond that, consolidate or remove entries that are now obvious from code.
- **Sections**: must have exactly: Current state, Pending items, Known pitfalls, Non-obvious decisions.

If anything is wrong or stale, **fix it before committing** (using Edit tool). Show the user what was changed.

### 4. Verify other .md files

Read the git diff and check if the following files need updates:

- **AGENTS.MD** — Any new convention that should be documented?
- **README.md** — Are usage instructions still valid?

If any .md needs updating, **update it before committing** (using Edit tool). Show the user what was changed.

### 5. Generate commit message

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

### 6. Stage, Commit & Push

- `git add` relevant files explicitly (do NOT use `git add -A` — avoid committing secrets like .env)
- `git commit` with the generated message (use HEREDOC format)
- `git push`
- Show the final result to the user

### 7. Knowledge Base drift check

After pushing, do a quick cross-check of `docs/knowledge-base.md` against the actual codebase:

- **Strategy descriptions**: do indicators, entry rules, exit rules, and free variables described in the KB match the actual `.pine` files in `assets/`?
- **BREAKER Results tables**: are PF, WR, DD, Trades, PnL values current or stale?
- **Config values**: do criteria, profiles, and guardrails described in the KB match `breaker-config.json`?
- **Operational limits**: do daily limits, consecutive loss rules, session descriptions match the Pine code?
- **Iron rules / glossary**: any values that contradict what the code actually does?

**DO NOT update** `knowledge-base.md` — only **list the discrepancies** found (if any) so the user can decide what to fix. If everything matches, say so.
