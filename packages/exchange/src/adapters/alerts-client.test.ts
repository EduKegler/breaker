import { describe, it, expect, vi } from "vitest";
import { formatOpenMessage, formatTrailingSlMessage } from "./alerts-client.js";
import type { OrderIntent } from "../domain/order-intent.js";
import type { AlertsClient } from "./alerts-client.js";

const intent: OrderIntent = {
  coin: "BTC",
  side: "buy",
  size: 0.01,
  entryPrice: 95420,
  stopLoss: 94200,
  takeProfits: [{ price: 96800, pctOfPosition: 0.5 }],
  direction: "long",
  notionalUsd: 954.2,
  comment: "Donchian breakout",
};

describe("formatOpenMessage", () => {
  it("formats long position message", () => {
    const msg = formatOpenMessage(intent, "testnet");
    expect(msg).toContain("BTC LONG aberto");
    expect(msg).toContain("Entry:");
    expect(msg).toContain("SL:");
    expect(msg).toContain("TP1:");
    expect(msg).toContain("Size: 0.01 BTC");
    expect(msg).toContain("Mode: testnet");
  });

  it("formats short position message", () => {
    const shortIntent: OrderIntent = {
      ...intent,
      direction: "short",
      side: "sell",
    };
    const msg = formatOpenMessage(shortIntent, "live");
    expect(msg).toContain("SHORT aberto");
    expect(msg).toContain("Mode: live");
  });

  it("handles multiple take profits", () => {
    const multiTp: OrderIntent = {
      ...intent,
      takeProfits: [
        { price: 96800, pctOfPosition: 0.5 },
        { price: 98000, pctOfPosition: 0.5 },
      ],
    };
    const msg = formatOpenMessage(multiTp, "testnet");
    expect(msg).toContain("TP1:");
    expect(msg).toContain("TP2:");
  });

  it("handles no take profits", () => {
    const noTp: OrderIntent = { ...intent, takeProfits: [] };
    const msg = formatOpenMessage(noTp, "testnet");
    expect(msg).not.toContain("TP");
  });
});

describe("formatTrailingSlMessage", () => {
  it("formats long trailing SL move", () => {
    const msg = formatTrailingSlMessage("BTC", "long", 93000, 94000, 92000, "testnet");
    expect(msg).toContain("BTC LONG");
    expect(msg).toContain("trailing");
    expect(msg).toContain("Mode: testnet");
  });

  it("formats short trailing SL move", () => {
    const msg = formatTrailingSlMessage("BTC", "short", 97000, 96000, 98000, "live");
    expect(msg).toContain("BTC SHORT");
    expect(msg).toContain("trailing");
    expect(msg).toContain("Mode: live");
  });

  it("includes old and new levels", () => {
    const msg = formatTrailingSlMessage("ETH", "long", 3400, 3500, 3200, "testnet");
    expect(msg).toContain("3,400");
    expect(msg).toContain("3,500");
  });
});

describe("AlertsClient interface (mock)", () => {
  it("calls notifyPositionOpened", async () => {
    const mockClient: AlertsClient = {
      notifyPositionOpened: vi.fn(),
      notifyTrailingSlMoved: vi.fn(),
      sendText: vi.fn(),
    };

    await mockClient.notifyPositionOpened(intent, "testnet");
    expect(mockClient.notifyPositionOpened).toHaveBeenCalledWith(intent, "testnet");
  });

  it("calls notifyTrailingSlMoved", async () => {
    const mockClient: AlertsClient = {
      notifyPositionOpened: vi.fn(),
      notifyTrailingSlMoved: vi.fn(),
      sendText: vi.fn(),
    };

    await mockClient.notifyTrailingSlMoved("BTC", "long", 93000, 94000, 92000, "testnet");
    expect(mockClient.notifyTrailingSlMoved).toHaveBeenCalledWith("BTC", "long", 93000, 94000, 92000, "testnet");
  });
});
