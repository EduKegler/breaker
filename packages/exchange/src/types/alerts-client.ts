import type { OrderIntent } from "../domain/signal-to-intent.js";

export interface AlertsClient {
  notifyPositionOpened(intent: OrderIntent, mode: string): Promise<void>;
  notifyTrailingSlMoved(coin: string, direction: string, oldLevel: number, newLevel: number, entryPrice: number, mode: string): Promise<void>;
  sendText(text: string): Promise<void>;
}
