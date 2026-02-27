import pino from "pino";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Per-module log level overrides, set at runtime via setLogConfig() */
let logLevelOverrides: Record<string, string> = {};

/** Set per-module log level overrides (called by daemon at startup) */
export function setLogConfig(overrides: Record<string, string>): void {
  logLevelOverrides = overrides;
}

function getBaseLevel(): string {
  return process.env.LOG_LEVEL ?? "debug";
}

function createLogger(): pino.Logger {
  if (process.env.VITEST) {
    return pino({ level: "silent" });
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const LOG_DIR = process.env.LOG_DIR || join(__dirname, "../../logs");

  return pino(
    { level: getBaseLevel() },
    pino.transport({
      targets: [
        { target: "pino/file", level: getBaseLevel(), options: { destination: 1 } },
        {
          target: "pino-roll",
          level: getBaseLevel(),
          options: {
            file: join(LOG_DIR, "exchange"),
            frequency: "daily",
            dateFormat: "yyyy-MM-dd",
            extension: ".ndjson",
            mkdir: true,
          },
        },
      ],
    }),
  );
}

export const logger = createLogger();

/** Create a child logger with per-module log level from config */
export function createChildLogger(module: string): pino.Logger {
  const level = logLevelOverrides[module] ?? undefined;
  const child = logger.child({ module });
  if (level) {
    child.level = level;
  }
  return child;
}
