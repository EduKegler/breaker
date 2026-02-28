// Types
export type { ExchangeConfig, Guardrails, Sizing, CoinStrategy, CoinConfig } from "./types/config.js";
export { ExchangeConfigSchema, GuardrailsSchema, SizingSchema, CoinStrategySchema, CoinConfigSchema } from "./types/config.js";
export type { ExchangeEvent, EventType } from "./types/events.js";
export type { HlClient, HlPosition, HlOrderResult, HlEntryResult, HlOpenOrder, HlHistoricalOrder, HlAccountState, HlSpotBalance } from "./types/hl-client.js";
export type { WsOrder, WsUserFill, HlEventStreamCallbacks } from "./types/hl-event-stream.js";
export type { AlertsClient } from "./types/alerts-client.js";

// Domain
export { checkRisk } from "./domain/check-risk.js";
export type { RiskCheckInput, RiskCheckResult } from "./domain/check-risk.js";
export { signalToIntent } from "./domain/signal-to-intent.js";
export type { OrderIntent } from "./domain/signal-to-intent.js";
export { PositionBook } from "./domain/position-book.js";
export type { LivePosition } from "./domain/position-book.js";
export { resolveOrderStatus } from "./domain/order-status.js";

// Adapters
export { HyperliquidClient } from "./adapters/hyperliquid-client.js";
export { DryRunHlClient } from "./adapters/dry-run-client.js";
export { HlEventStream } from "./adapters/hl-event-stream.js";
export { SqliteStore } from "./adapters/sqlite-store.js";
export { EventLog } from "./adapters/event-log.js";
export { CandlePoller } from "./adapters/candle-poller.js";
export { HttpAlertsClient } from "./adapters/alerts-client.js";
export { formatOpenMessage } from "./adapters/format-alert-message.js";

// Application
export { handleSignal } from "./application/handle-signal.js";
export { StrategyRunner } from "./application/strategy-runner.js";
export { ReconcileLoop } from "./application/reconcile-loop.js";
export { reconcile } from "./application/reconcile.js";
export type { ReconciledData } from "./application/reconcile-loop.js";
export { replayStrategy } from "./application/replay-strategy.js";
export type { ReplaySignal, ReplayParams } from "./application/replay-strategy.js";

// Server
export { createApp } from "./create-app.js";

// WebSocket
export { WsBroker } from "./lib/ws-broker.js";
