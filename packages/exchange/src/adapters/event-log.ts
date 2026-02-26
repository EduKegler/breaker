import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExchangeEvent } from "../types/events.js";

export class EventLog {
  private filePath: string;
  private ready: Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ready = mkdir(dirname(filePath), { recursive: true }).then(() => {});
  }

  async append(event: ExchangeEvent): Promise<void> {
    await this.ready;
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }
}
