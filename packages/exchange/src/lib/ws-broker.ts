import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import { EventEmitter } from "node:events";

export class WsBroker extends EventEmitter {
  private wss: WebSocketServer | null = null;

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.emit("client:connected", ws);
    });
  }

  broadcast(data: string): void {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  broadcastEvent(type: string, data: unknown): void {
    this.broadcast(JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      data,
    }));
  }

  close(): void {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }
  }
}
