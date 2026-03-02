import { describe, it, expect, vi } from "vitest";
import { HlEventStream } from "./hl-event-stream.js";
import type { WsOrder, WsUserFill } from "../types/hl-event-stream.js";

function createMockSdk() {
  const wsListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    ws: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = wsListeners.get(event) ?? [];
        list.push(cb);
        wsListeners.set(event, list);
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of wsListeners.get(event) ?? []) cb(...args);
      },
    },
    subscriptions: {
      subscribeToOrderUpdates: vi.fn().mockResolvedValue(undefined),
      subscribeToUserFills: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("HlEventStream", () => {
  it("start() subscribes to order updates and user fills", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");

    await stream.start({
      onOrderUpdate: vi.fn(),
      onFill: vi.fn(),
    });

    expect(sdk.subscriptions.subscribeToOrderUpdates).toHaveBeenCalledWith(
      "0xtest",
      expect.any(Function),
    );
    expect(sdk.subscriptions.subscribeToUserFills).toHaveBeenCalledWith(
      "0xtest",
      expect.any(Function),
    );
  });

  it("forwards order update events to callback", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onOrderUpdate = vi.fn();

    await stream.start({ onOrderUpdate, onFill: vi.fn() });

    // Simulate SDK pushing an order update
    const subscribedCb = sdk.subscriptions.subscribeToOrderUpdates.mock.calls[0][1];
    const orders: WsOrder[] = [
      {
        order: { coin: "BTC", side: "A", limitPx: "94000", sz: "0.01", oid: 123, timestamp: 1000, origSz: "0.01" },
        status: "filled",
        statusTimestamp: 2000,
        user: "0xtest",
      },
    ];
    subscribedCb(orders);

    expect(onOrderUpdate).toHaveBeenCalledWith(orders);
  });

  it("forwards fill events to callback", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onFill = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill });

    // Simulate SDK pushing fills
    const subscribedCb = sdk.subscriptions.subscribeToUserFills.mock.calls[0][1];
    const fills: WsUserFill[] = [
      {
        coin: "BTC", px: "95000", sz: "0.01", side: "A", time: 1000,
        startPosition: "0", dir: "Open Long", closedPnl: "0",
        hash: "0xabc", oid: 123, crossed: false, fee: "0.5", tid: 1,
      },
    ];
    subscribedCb({ isSnapshot: false, fills });

    expect(onFill).toHaveBeenCalledWith(fills, false);
  });

  it("passes isSnapshot=true for snapshot fills", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onFill = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill });

    const subscribedCb = sdk.subscriptions.subscribeToUserFills.mock.calls[0][1];
    subscribedCb({ isSnapshot: true, fills: [] });

    expect(onFill).toHaveBeenCalledWith([], true);
  });

  it("stop() does not throw", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn() });
    expect(() => stream.stop()).not.toThrow();
  });

  it("stop() before start() does not throw", () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    expect(() => stream.stop()).not.toThrow();
  });

  it("callback error does not crash HlEventStream", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onOrderUpdate = vi.fn().mockImplementation(() => {
      throw new Error("callback exploded");
    });

    await stream.start({ onOrderUpdate, onFill: vi.fn() });

    // Simulate SDK pushing an order update — should not throw
    const subscribedCb = sdk.subscriptions.subscribeToOrderUpdates.mock.calls[0][1];
    expect(() => subscribedCb([])).not.toThrow();
    expect(onOrderUpdate).toHaveBeenCalledOnce();
  });

  it("fill callback error does not crash HlEventStream", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onFill = vi.fn().mockImplementation(() => {
      throw new Error("fill callback exploded");
    });

    await stream.start({ onOrderUpdate: vi.fn(), onFill });

    const subscribedCb = sdk.subscriptions.subscribeToUserFills.mock.calls[0][1];
    expect(() => subscribedCb({ isSnapshot: false, fills: [] })).not.toThrow();
    expect(onFill).toHaveBeenCalledOnce();
  });

  it("callbacks are ignored after stop()", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onOrderUpdate = vi.fn();
    const onFill = vi.fn();

    await stream.start({ onOrderUpdate, onFill });
    stream.stop();

    // Simulate SDK pushing events after stop — should be silently ignored
    const orderCb = sdk.subscriptions.subscribeToOrderUpdates.mock.calls[0][1];
    const fillCb = sdk.subscriptions.subscribeToUserFills.mock.calls[0][1];
    orderCb([]);
    fillCb({ isSnapshot: false, fills: [] });

    expect(onOrderUpdate).not.toHaveBeenCalled();
    expect(onFill).not.toHaveBeenCalled();
  });

  it("calls onReconnected when SDK emits reconnect event", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onReconnected = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onReconnected });

    expect(sdk.ws.on).toHaveBeenCalledWith("reconnect", expect.any(Function));

    // Simulate WS reconnect
    sdk.ws.emit("reconnect");

    expect(onReconnected).toHaveBeenCalledOnce();
  });

  it("does not call onReconnected after stop()", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onReconnected = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onReconnected });
    stream.stop();

    sdk.ws.emit("reconnect");

    expect(onReconnected).not.toHaveBeenCalled();
  });

  it("onReconnected error does not crash HlEventStream", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onReconnected = vi.fn().mockImplementation(() => {
      throw new Error("reconnect callback exploded");
    });

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onReconnected });

    expect(() => sdk.ws.emit("reconnect")).not.toThrow();
    expect(onReconnected).toHaveBeenCalledOnce();
  });

  it("works without onReconnected callback", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn() });

    // Should not throw even though onReconnected is undefined
    expect(() => sdk.ws.emit("reconnect")).not.toThrow();
  });

  it("calls onDisconnected when SDK emits close event", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onDisconnected = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onDisconnected });

    expect(sdk.ws.on).toHaveBeenCalledWith("close", expect.any(Function));

    sdk.ws.emit("close", 1006, "connection lost");

    expect(onDisconnected).toHaveBeenCalledWith(1006, "connection lost");
  });

  it("does not call onDisconnected after stop()", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onDisconnected = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onDisconnected });
    stream.stop();

    sdk.ws.emit("close", 1006, "connection lost");

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("onDisconnected error does not crash", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onDisconnected = vi.fn().mockImplementation(() => {
      throw new Error("disconnect callback exploded");
    });

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onDisconnected });

    expect(() => sdk.ws.emit("close", 1006, "lost")).not.toThrow();
    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  it("calls onMaxReconnectFailed when SDK emits maxReconnectAttemptsReached", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onMaxReconnectFailed = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onMaxReconnectFailed });

    expect(sdk.ws.on).toHaveBeenCalledWith("maxReconnectAttemptsReached", expect.any(Function));

    sdk.ws.emit("maxReconnectAttemptsReached");

    expect(onMaxReconnectFailed).toHaveBeenCalledOnce();
  });

  it("does not call onMaxReconnectFailed after stop()", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onMaxReconnectFailed = vi.fn();

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onMaxReconnectFailed });
    stream.stop();

    sdk.ws.emit("maxReconnectAttemptsReached");

    expect(onMaxReconnectFailed).not.toHaveBeenCalled();
  });

  it("onMaxReconnectFailed error does not crash", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");
    const onMaxReconnectFailed = vi.fn().mockImplementation(() => {
      throw new Error("maxReconnect callback exploded");
    });

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn(), onMaxReconnectFailed });

    expect(() => sdk.ws.emit("maxReconnectAttemptsReached")).not.toThrow();
    expect(onMaxReconnectFailed).toHaveBeenCalledOnce();
  });

  it("works without onDisconnected/onMaxReconnectFailed callbacks", async () => {
    const sdk = createMockSdk();
    const stream = new HlEventStream(sdk as never, "0xtest");

    await stream.start({ onOrderUpdate: vi.fn(), onFill: vi.fn() });

    expect(() => sdk.ws.emit("close", 1006, "lost")).not.toThrow();
    expect(() => sdk.ws.emit("maxReconnectAttemptsReached")).not.toThrow();
  });
});
