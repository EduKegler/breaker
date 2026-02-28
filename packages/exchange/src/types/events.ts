export type EventType =
  | "signal_received"
  | "risk_check_passed"
  | "risk_check_failed"
  | "order_placed"
  | "order_filled"
  | "order_cancelled"
  | "order_rejected"
  | "position_opened"
  | "position_closed"
  | "leverage_set"
  | "reconcile_ok"
  | "reconcile_drift"
  | "daemon_started"
  | "daemon_stopped"
  | "warmup_complete"
  | "candle_polled"
  | "notification_sent"
  | "notification_failed"
  | "entry_no_fill"
  | "error";

export interface ExchangeEvent {
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}
