import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("execa", () => ({
  execaSync: vi.fn(),
}));

import { execaSync } from "execa";
import { runEngineChild } from "./spawn-engine-child.js";

describe("runEngineChild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns child process and parses JSON result", () => {
    const fakeResult = {
      metrics: { totalPnl: 42, numTrades: 5 },
      analysis: { byDirection: {}, byExitType: {} },
      trades: [],
    };
    vi.mocked(execaSync).mockReturnValue({ stdout: JSON.stringify(fakeResult) } as any);

    const result = runEngineChild({
      repoRoot: "/repo",
      factoryName: "createDonchianAdx",
      dbPath: "/repo/.cache/candles.db",
      coin: "BTC",
      source: "binance",
      interval: "15m",
      startTime: 1000,
      endTime: 2000,
    });

    expect(result).toEqual(fakeResult);
    expect(execaSync).toHaveBeenCalledWith(
      "node",
      ["/repo/dist/loop/stages/run-engine-child.js"],
      expect.objectContaining({ cwd: "/repo", timeout: 30000 }),
    );
  });

  it("passes paramOverrides in stdin input", () => {
    const fakeResult = { metrics: {}, analysis: {}, trades: [] };
    vi.mocked(execaSync).mockReturnValue({ stdout: JSON.stringify(fakeResult) } as any);

    runEngineChild({
      repoRoot: "/repo",
      factoryName: "createDonchianAdx",
      paramOverrides: { dcSlow: 40 },
      dbPath: "/db",
      coin: "ETH",
      source: "binance",
      interval: "1h",
      startTime: 100,
      endTime: 200,
    });

    const call = vi.mocked(execaSync).mock.calls[0];
    const input = JSON.parse(call[2]!.input as string);
    expect(input.factoryName).toBe("createDonchianAdx");
    expect(input.paramOverrides).toEqual({ dcSlow: 40 });
    expect(input.coin).toBe("ETH");
  });

  it("throws when child process returns invalid JSON", () => {
    vi.mocked(execaSync).mockReturnValue({ stdout: "not json" } as any);

    expect(() =>
      runEngineChild({
        repoRoot: "/repo",
        factoryName: "createDonchianAdx",
        dbPath: "/db",
        coin: "BTC",
        source: "binance",
        interval: "15m",
        startTime: 0,
        endTime: 1,
      }),
    ).toThrow();
  });
});
