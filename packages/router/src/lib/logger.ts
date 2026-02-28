import pino from "pino";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || join(__dirname, "../../infra/logs");

export const logger = pino(
  { level: "debug" },
  pino.transport({
    targets: [
      { target: "pino/file", level: "debug", options: { destination: 1 } },
      {
        target: "pino-roll",
        level: "debug",
        options: {
          file: join(LOG_DIR, "webhook"),
          frequency: "daily",
          dateFormat: "yyyy-MM-dd",
          extension: ".ndjson",
          mkdir: true,
        },
      },
    ],
  }),
);
