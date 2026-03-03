---
name: lint-conventions
description: Validate project naming and code conventions. Use when the user says "lint", "checa convencoes", "check conventions", "validate naming", "lint conventions", "verifica convencoes", or wants to check codebase conventions.
allowed-tools: "Bash, Glob, Grep, Read"
---

# Lint Project Conventions

Validate that the codebase follows the conventions defined in CLAUDE.md.

## Checks

### 1. Kebab-case file names

All `.ts` files in `packages/*/src/` must use kebab-case (hyphens, not underscores or camelCase).

```bash
find /Users/edu/Projects/trading/packages/*/src -name '*.ts' ! -path '*/node_modules/*' ! -path '*/dist/*' | grep -E '[A-Z_]' | grep -v '__' || echo "✅ All files use kebab-case"
```

Exceptions: none in this project.

### 2. One export per file

Each `.ts` file in `src/` (except `index.ts`, `types.ts`, `types/*.ts`, `*.test.ts`) should have at most one primary `export function` or `export class`.

For each package, scan non-exempt files:

```bash
for f in $(find /Users/edu/Projects/trading/packages/*/src -name '*.ts' ! -name 'index.ts' ! -name 'types.ts' ! -name '*.test.ts' ! -path '*/types/*' ! -path '*/node_modules/*' ! -path '*/dist/*'); do
  count=$(grep -cE '^export (function|class|const) ' "$f" 2>/dev/null || echo 0)
  if [ "$count" -gt 1 ]; then
    echo "⚠️  $f has $count exports"
  fi
done
echo "✅ One-export-per-file check done"
```

Note: multiple `export type` is fine. Only count `export function`, `export class`, `export const`.

### 3. isMainModule guard

Executable entry points (files with top-level execution like `daemon.ts`, `server.ts`, `orchestrator.ts`, `run-*.ts`) must have an `isMainModule(import.meta.url)` guard.

Search for files that import things and have top-level function calls but lack the guard:

```bash
for f in $(find /Users/edu/Projects/trading/packages/*/src -maxdepth 1 -name '*.ts' ! -name 'index.ts' ! -name '*.test.ts' ! -path '*/node_modules/*' ! -path '*/dist/*'); do
  if grep -qE '(main\(\)|listen\(|start\(\))' "$f" 2>/dev/null; then
    if ! grep -q 'isMainModule' "$f" 2>/dev/null; then
      echo "⚠️  $f — executable without isMainModule guard"
    fi
  fi
done
echo "✅ isMainModule guard check done"
```

### 4. Test file coverage

Every `.ts` file in `src/` (except `index.ts`, `types.ts`, `types/*.ts`) should have a `.test.ts` counterpart.

```bash
for f in $(find /Users/edu/Projects/trading/packages/*/src -name '*.ts' ! -name 'index.ts' ! -name 'types.ts' ! -name '*.test.ts' ! -name '*.d.ts' ! -path '*/types/*' ! -path '*/node_modules/*' ! -path '*/dist/*'); do
  testFile="${f%.ts}.test.ts"
  if [ ! -f "$testFile" ]; then
    echo "⚠️  Missing test: $testFile"
  fi
done
echo "✅ Test coverage check done"
```

### 5. No .env leaks for non-secrets

Check that `.env` files only contain secrets (API keys, tokens, credentials):

```bash
for envFile in $(find /Users/edu/Projects/trading/packages -name '.env' ! -name '.env.example' ! -path '*/node_modules/*'); do
  echo "--- $envFile ---"
  grep -v '^#' "$envFile" | grep -v '^$' | grep -viE '(KEY|TOKEN|SECRET|PASSWORD|ADDRESS|CREDENTIAL)' || echo "✅ Only secrets"
done
```

### 6. Report

Present a summary:

```
═══ CONVENTION LINT REPORT ═══════════════════════
✅ Kebab-case:        X files checked, Y violations
✅ One-export:        X files checked, Y violations
✅ isMainModule:      X executables checked, Y missing
⚠️  Test coverage:    X files, Y missing tests
✅ Env secrets-only:  X .env files checked
══════════════════════════════════════════════════
```

List all violations grouped by check type. For each violation, suggest the fix.
