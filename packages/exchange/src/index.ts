// Types
export type { ExchangeConfig, Guardrails, Sizing } from "./types/config.js";
export { ExchangeConfigSchema, GuardrailsSchema, SizingSchema } from "./types/config.js";
export type { ExchangeEvent, EventType } from "./types/events.js";

// Domain
export { checkRisk } from "./domain/risk-engine.js";
export type { RiskCheckInput, RiskCheckResult } from "./domain/risk-engine.js";
export { signalToIntent } from "./domain/order-intent.js";
export type { OrderIntent } from "./domain/order-intent.js";
export { PositionBook } from "./domain/position-book.js";
export type { LivePosition } from "./domain/position-book.js";
export { resolveOrderStatus } from "./domain/order-status.js";

// Adapters
export type { HlClient, HlPosition, HlOrderResult, HlOpenOrder, HlHistoricalOrder } from "./adapters/hyperliquid-client.js";
export { HyperliquidClient } from "./adapters/hyperliquid-client.js";
export { DryRunHlClient } from "./adapters/dry-run-client.js";
export { HlEventStream } from "./adapters/hl-event-stream.js";
export type { WsOrder, WsUserFill, HlEventStreamCallbacks } from "./adapters/hl-event-stream.js";
export { SqliteStore } from "./adapters/sqlite-store.js";
export { EventLog } from "./adapters/event-log.js";
export { CandlePoller } from "./adapters/candle-poller.js";
export { HttpAlertsClient, formatOpenMessage } from "./adapters/alerts-client.js";

// Application
export { handleSignal } from "./application/signal-handler.js";
export { StrategyRunner } from "./application/strategy-runner.js";
export { ReconcileLoop, reconcile } from "./application/reconcile-loop.js";
export type { ReconciledData } from "./application/reconcile-loop.js";
export { replayStrategy } from "./application/strategy-replay.js";
export type { ReplaySignal, ReplayParams } from "./application/strategy-replay.js";

// Server
export { createApp } from "./server.js";

// WebSocket
export { WsBroker } from "./lib/ws-broker.js";
