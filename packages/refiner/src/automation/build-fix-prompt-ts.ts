/**
 * build-fix-prompt-ts.ts
 *
 * Generates a prompt for correcting TypeScript compilation errors
 * detected after a restructure-phase edit to a strategy file.
 * Replaces Pine-specific build-fix-prompt.ts.
 */

interface TsCompilationError {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string; // e.g. "TS2345"
}

interface BuildFixPromptOptions {
  strategySourcePath: string;
  errors: TsCompilationError[];
  buildOutput: string;
}

/**
 * Generate a prompt for Claude to fix TypeScript compilation errors
 * in a strategy file after a restructure edit.
 */
export function buildFixPrompt(opts: BuildFixPromptOptions): string {
  const { strategySourcePath, errors, buildOutput } = opts;

  const errorsFormatted = errors.length
    ? errors
        .map((e, i) => {
          const lines = [
            `### Error ${i + 1}${e.code ? ` (${e.code})` : ""}`,
            `- Message: ${e.message}`,
            e.file ? `- File: ${e.file}` : "",
            e.line
              ? `- Line: ${e.line}${e.column ? `, Column: ${e.column}` : ""}`
              : "",
          ].filter(Boolean);
          return lines.join("\n");
        })
        .join("\n\n")
    : "";

  const rawOutputSection = buildOutput.trim()
    ? `## RAW BUILD OUTPUT\n\`\`\`\n${buildOutput.slice(0, 3000)}\n\`\`\`\n`
    : "";

  return `You need to fix TypeScript compilation errors in a strategy file.

## CONTEXT
- Strategy file: \`${strategySourcePath}\`
- Build command: \`pnpm --filter @breaker/backtest typecheck\`
- ${errors.length} compilation error(s) detected after restructure edit

## ERRORS DETECTED

${errorsFormatted || "No structured error details — check raw build output below."}

${rawOutputSection}
## YOUR TASK

1. **Read** the file \`${strategySourcePath}\` completely
2. **Identify the root cause** of each error
3. **Fix** the error(s) with the smallest necessary change
4. **Run** \`pnpm --filter @breaker/backtest typecheck\` to verify the fix compiles
5. **Save** the corrected .ts file

## IMPORTANT RULES
- Fix ONLY the compilation errors — do not refactor or optimize code that is not broken
- Do not change strategy logic, parameter values, or indicator calculations unless they cause the type error
- After fixing, the loop will run the backtest again automatically
- The strategy must still conform to the \`Strategy\` interface from @breaker/backtest
- If a type import is missing, add it from @breaker/backtest
`;
}
