---
name: pine-check
description: Validate a Pine Script file syntax. Use when the user says "pine-check", "validate pine", "check the script", "lint pine", "valida o pine", "checa o script", "verifica o .pine", or wants to validate a .pine strategy file.
argument-hint: "[ASSET]"
disable-model-invocation: true
allowed-tools: "Read, Bash, mcp__pinescript-syntax-checker__check_syntax"
---

# Pine Script Syntax Checker

Validate a Pine Script strategy file using the PineScript syntax checker MCP.

## Steps

### 1. Determine the asset

- If `$ARGUMENTS` is provided (e.g., "BTC", "ETH", "SOL"), use it
- If no argument, ask the user which asset to check
- The strategy file is at: `/Users/edu/Projects/pine/assets/{ASSET}/strategy.pine`

### 2. Read the strategy file

Read the full contents of `assets/{ASSET}/strategy.pine`.

If the file doesn't exist, inform the user and list available assets from `assets/` directory.

### 3. Validate with PineScript Syntax Checker

Use the `mcp__pinescript-syntax-checker__check_syntax` tool with the full Pine Script code.

### 4. Report results

**If validation succeeds:**
- Confirm the script compiles without errors

**If validation fails:**
- Show each error with line number and message
- Use MCP Context7 (`mcp__context7__query-docs`) to look up Pine Script docs if needed
- Suggest the fix based on the error message and Pine Script best practices
