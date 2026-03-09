---
name: commit
description: Commit and push changes. Use when the user says "commit", "commit and push", "commita", "commita e pusha", "manda pro git", "salva no git", or wants to commit current changes.
argument-hint: "[message]"
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

### 3. Simplify

Run `/simplify` to review changed code for reuse, quality, and efficiency issues, and fix any found.

### 4. Verify .md files

Read the git diff and check if the following files need updates:

- **CLAUDE.md** (root and package-level) — Any new convention or pattern that should be documented?
- **AGENTS.md** — Any new convention that should be documented?
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
