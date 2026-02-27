import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { WsBroker } from "./ws-broker.js";

let httpServer: HttpServer;
let broker: WsBroker;

function getPort(server: HttpServer): number {
  const addr = server.address();
  if (typeof addr === "object" && addr) return addr.port;
  throw new Error("Server not listening");
}

async function startBroker(): Promise<number> {
  httpServer = createServer();
  broker = new WsBroker();
  broker.attach(httpServer);
  httpServer.listen(0);
  await once(httpServer, "listening");
  return getPort(httpServer);
}

async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(ws, "open");
  return ws;
}

async function cleanup() {
  broker?.close();
  if (httpServer) {
    httpServer.closeAllConnections();
    if (httpServer.listening) {
      httpServer.close();
    }
  }
}

afterEach(cleanup);

describe("WsBroker", () => {
  it("accepts WebSocket connections on /ws path", async () => {
    const port = await startBroker();
    const ws = await connectWs(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("broadcasts messages to all connected clients", async () => {
    const port = await startBroker();
    const ws1 = await connectWs(port);
    const ws2 = await connectWs(port);

    const msg1Promise = once(ws1, "message");
    const msg2Promise = once(ws2, "message");

    broker.broadcast(JSON.stringify({ type: "test", data: 42 }));

    const [[raw1], [raw2]] = await Promise.all([msg1Promise, msg2Promise]);
    const parsed1 = JSON.parse(String(raw1));
    const parsed2 = JSON.parse(String(raw2));

    expect(parsed1).toEqual({ type: "test", data: 42 });
    expect(parsed2).toEqual({ type: "test", data: 42 });

    ws1.close();
    ws2.close();
  });

  it("broadcastEvent sends typed JSON message", async () => {
    const port = await startBroker();
    const ws = await connectWs(port);

    const msgPromise = once(ws, "message");
    broker.broadcastEvent("positions", [{ coin: "BTC" }]);
    const [[raw]] = await Promise.all([msgPromise]);
    const parsed = JSON.parse(String(raw));

    expect(parsed.type).toBe("positions");
    expect(parsed.data).toEqual([{ coin: "BTC" }]);
    expect(parsed.timestamp).toBeDefined();

    ws.close();
  });

  it("emits client:connected when a new client connects", async () => {
    const port = await startBroker();
    const connectPromise = once(broker, "client:connected");
    const ws = await connectWs(port);
    const [clientWs] = await connectPromise;
    expect(clientWs).toBeInstanceOf(WebSocket);
    ws.close();
  });

  it("handles client disconnect gracefully", async () => {
    const port = await startBroker();
    const ws = await connectWs(port);
    ws.close();
    await once(ws, "close");
    // broadcast after disconnect should not throw
    broker.broadcast(JSON.stringify({ type: "noop" }));
  });

  it("close() shuts down the WebSocket server", async () => {
    const port = await startBroker();
    const ws = await connectWs(port);
    const closePromise = once(ws, "close");
    broker.close();
    await closePromise;
    // afterEach handles httpServer cleanup
  });
});
