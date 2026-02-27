import { useEffect, useRef, useState, useCallback } from "react";

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface WsMessage {
  type: string;
  timestamp: string;
  data: unknown;
}

interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  reconnectMs?: number;
}

export function useWebSocket({ url, onMessage, reconnectMs = 3000 }: UseWebSocketOptions) {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    setStatus("connecting");
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setStatus("connected");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as WsMessage;
        onMessageRef.current(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
      setTimeout(connect, reconnectMs);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url, reconnectMs]);

  useEffect(() => {
    connect();
    return () => {
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null; // prevent reconnect on intentional close
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status };
}
