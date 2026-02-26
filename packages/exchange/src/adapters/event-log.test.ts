import { describe, it, expect, afterEach } from "vitest";
import { EventLog } from "./event-log.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExchangeEvent } from "../types/events.js";

const tmpDir = join(tmpdir(), "breaker-event-log-test");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("EventLog", () => {
  it("appends NDJSON events to file", async () => {
    const logPath = join(tmpDir, "events.ndjson");
    const log = new EventLog(logPath);

    const event1: ExchangeEvent = {
      type: "signal_received",
      timestamp: "2024-01-01T00:00:00Z",
      data: { asset: "BTC", side: "LONG" },
    };

    const event2: ExchangeEvent = {
      type: "order_placed",
      timestamp: "2024-01-01T00:01:00Z",
      data: { coin: "BTC", size: 0.01 },
    };

    await log.append(event1);
    await log.append(event2);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("signal_received");
    expect(JSON.parse(lines[1]).type).toBe("order_placed");
  });

  it("creates directory if it does not exist", async () => {
    const nested = join(tmpDir, "nested", "deep", "events.ndjson");
    const log = new EventLog(nested);

    await log.append({
      type: "daemon_started",
      timestamp: "2024-01-01T00:00:00Z",
      data: {},
    });

    const content = await readFile(nested, "utf-8");
    expect(content.trim()).toContain("daemon_started");
  });
});
