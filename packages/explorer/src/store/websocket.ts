import type { StoreState } from "./types.js";
import type {
  HealthResponse,
  LivePosition,
  OrderRow,
  OpenOrder,
  EquitySnapshot,
  CandleData,
  SignalRow,
  PricesEvent,
} from "../types/api.js";

interface WsMessage {
  type: string;
  timestamp: string;
  data: unknown;
}

type StoreApi = {
  getState: () => StoreState;
  setState: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void;
};

export function connectWebSocket(url: string, store: StoreApi, reconnectMs = 3000): () => void {
  let ws: WebSocket | null = null;
  let intentionalClose = false;

  function connect() {
    store.setState({ wsStatus: "connecting" });
    ws = new WebSocket(url);

    ws.onopen = () => {
      store.setState({ wsStatus: "connected" });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as WsMessage;
        handleMessage(msg, store);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      store.setState({ wsStatus: "disconnected" });
      ws = null;
      if (!intentionalClose) {
        setTimeout(connect, reconnectMs);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    intentionalClose = true;
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}

function handleMessage(msg: WsMessage, store: StoreApi) {
  const { setState } = store;

  switch (msg.type) {
    case "snapshot": {
      const d = msg.data as {
        positions: LivePosition[];
        orders: OrderRow[];
        openOrders: OpenOrder[];
        equity: { snapshots: EquitySnapshot[] } | EquitySnapshot[];
        health: HealthResponse;
        signals?: SignalRow[];
      };
      setState({
        positions: d.positions,
        orders: d.orders,
        openOrders: d.openOrders,
        equity: Array.isArray(d.equity) ? d.equity : d.equity.snapshots,
        health: d.health,
        ...(d.signals ? { signals: d.signals } : {}),
      });
      break;
    }
    case "positions":
      setState({ positions: msg.data as LivePosition[] });
      break;
    case "orders":
      setState({ orders: msg.data as OrderRow[] });
      break;
    case "open-orders":
      setState({ openOrders: msg.data as OpenOrder[] });
      break;
    case "equity":
      setState({ equity: msg.data as EquitySnapshot[] });
      break;
    case "health":
      setState({ health: msg.data as HealthResponse });
      break;
    case "candle": {
      const newCandle = msg.data as CandleData & { coin?: string };
      const coin = newCandle.coin;
      if (!coin) break;
      setState((s) => {
        const arr = s.coinCandles[coin] ?? [];
        const last = arr.length - 1;
        if (last >= 0 && arr[last].t === newCandle.t) {
          const updated = [...arr];
          updated[last] = newCandle;
          return { coinCandles: { ...s.coinCandles, [coin]: updated } };
        }
        const idx = arr.findIndex((c) => c.t === newCandle.t);
        if (idx >= 0) {
          const updated = [...arr];
          updated[idx] = newCandle;
          return { coinCandles: { ...s.coinCandles, [coin]: updated } };
        }
        return { coinCandles: { ...s.coinCandles, [coin]: [...arr, newCandle] } };
      });
      break;
    }
    case "signals":
      setState({ signals: msg.data as SignalRow[] });
      break;
    case "prices": {
      const p = msg.data as PricesEvent;
      const coin = p.coin;
      if (!coin) break;
      setState((s) => {
        const old = s.coinPrices[coin];
        let flash = s.priceFlash;
        if (coin === s.selectedCoin) {
          const refPrice = p.hlMidPrice ?? p.dataSourcePrice;
          const prevRefPrice = old?.hlMidPrice ?? old?.dataSourcePrice;
          if (refPrice != null && prevRefPrice != null && refPrice !== prevRefPrice) {
            flash = refPrice > prevRefPrice ? "up" : "down";
          }
        }
        return {
          coinPrices: { ...s.coinPrices, [coin]: p },
          priceFlash: flash,
        };
      });
      break;
    }
  }
}
