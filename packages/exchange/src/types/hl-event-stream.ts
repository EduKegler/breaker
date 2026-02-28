export interface WsOrder {
  order: {
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
  };
  status: string;
  statusTimestamp: number;
  user: string;
}

export interface WsUserFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface HlEventStreamCallbacks {
  onOrderUpdate: (orders: WsOrder[]) => void;
  onFill: (fills: WsUserFill[], isSnapshot: boolean) => void;
}
