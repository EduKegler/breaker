#!/usr/bin/env node
/**
 * build-fix-prompt.ts
 *
 * Generates a prompt for correcting Pine compilation errors detected by the backtest runner.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "../../playwright");
const REPO_ROOT = path.resolve(__dirname, "../..");

const ERROR_FILE = path.join(RUNNER_DIR, "error-last-run.json");

export interface CompilationError {
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
}

export interface ErrorData {
  strategyFile: string;
  timestamp?: string;
  errors: CompilationError[] | null;
}

/**
 * Generate fix prompt from error data. Extracted from main() for testability.
 */
export function generateFixPrompt(errorData: ErrorData, repoRoot: string): string {
  const { strategyFile, timestamp } = errorData;
  const errors: CompilationError[] = Array.isArray(errorData.errors)
    ? errorData.errors
    : [];

  if (!strategyFile || typeof strategyFile !== "string") {
    throw new Error("errorData missing valid 'strategyFile' field");
  }

  const pineFilePath = path.normalize(
    path.resolve(repoRoot, strategyFile.replace(/^(\.\.\/)+/, "")),
  );
  const repoRootNormalized = path.normalize(repoRoot) + path.sep;

  if (!pineFilePath.startsWith(repoRootNormalized)) {
    throw new Error(`Path traversal blocked: ${strategyFile}`);
  }

  if (!fs.existsSync(pineFilePath)) {
    throw new Error(`Pine file not found: ${pineFilePath}`);
  }

  const errorsFormatted = errors
    .map((e, i) => {
      const lines = [
        `### Error ${i + 1}`,
        `- Message: ${e.message}`,
        e.line
          ? `- Line: ${e.line}${e.column ? `, Column: ${e.column}` : ""}`
          : "",
        e.snippet
          ? `- Code snippet:\n\`\`\`pine\n${e.snippet}\n\`\`\``
          : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");

  return `You need to fix Pine Script compilation errors.

## CONTEXT
- Pine file with error: \`${pineFilePath}\`
- Error timestamp: ${timestamp ?? "unknown"}
- Backtest runner detected ${errors.length} compilation error(s) on TradingView

## ERRORS DETECTED

${errorsFormatted || "No error details available — check the file manually."}

## YOUR TASK

1. **Read** the file \`${pineFilePath}\` completely
2. **Identify the root cause** of each error (use MCP pinescript-syntax-checker and Context7 to look up Pine Script docs if needed)
3. **Fix** the error(s) in the Pine file with the smallest necessary change
4. **Save** the corrected .pine file

## IMPORTANT RULES
- Fix ONLY the compilation errors — do not refactor code that is not broken
- After fixing, the loop will run the backtest again automatically
- If the error is scope-related (e.g.: function in local scope), move to global scope
- If the error is multiline-related, use parentheses for line continuation
`;
}

function main(): void {
  if (!fs.existsSync(ERROR_FILE)) {
    process.stderr.write(`File not found: ${ERROR_FILE}\n`);
    process.exit(1);
  }

  let errorData: ErrorData;
  try {
    errorData = JSON.parse(fs.readFileSync(ERROR_FILE, "utf8")) as ErrorData;
  } catch (e) {
    process.stderr.write(
      `Error parsing error-last-run.json: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  try {
    const prompt = generateFixPrompt(errorData, REPO_ROOT);
    process.stdout.write(prompt);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-fix-prompt.js");

if (isMain) {
  main();
}
