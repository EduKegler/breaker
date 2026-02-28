# MEMORY — explorer

## Current state
- "Tactical Terminal" redesign: single-page dashboard, dark terminal aesthetic.
- Fonts: Outfit (display) + JetBrains Mono (data) via Google Fonts in index.html.
- Paleta: terminal-bg (#0a0a0f), terminal-surface (#12121a), profit (#00ff88), loss (#ff3366).
- Layout: header bar + account info bar + candlestick chart (full-width) + grid [equity 60% | positions 40%] + open orders + order log.
- Noise texture via SVG data URI overlay (2.5% opacity).
- No pages/ directory — all content in app.tsx with component composition.
- Hybrid HTTP+WS model: initial HTTP fetch + WebSocket push updates (no more usePoll).
- useWebSocket hook with auto-reconnect (3s), WS status indicator in header.
- "Open Orders" section shows live Hyperliquid orders (SL/TP/limit) via GET /open-orders + WS push.
- PositionCard shows inline TP/SL badges below position data, filtered by coin from openOrders.
- Build output: ~781KB JS (recharts + lightweight-charts), 11KB CSS.
- CandlestickChart component uses lightweight-charts v5.1 (createChart, CandlestickSeries, createSeriesMarkers, createPriceLine).
- Entry markers: blue (auto) / yellow (manual), "L"/"S" text, size 1. Replay signals: blue arrows. Price lines: entry (amber dotted), SL (red dashed).
- WS events: "candle" appends new candle, "signals" replaces signals array.

## Pending items
- Add config page showing exchange configuration.
- Consider adding TP price lines from open orders (currently only entry+SL shown).
- Add error boundaries and loading skeletons.
- usePoll still exists in lib/use-poll.ts but is no longer imported (can be deleted).

## Known pitfalls
- recharts (~500KB) + lightweight-charts (~40KB) — could use dynamic import to split.
- Vite proxy only works in dev mode; production needs separate API server.
- Vite proxy for /ws path uses `ws: true` — required for WebSocket upgrade.
- Tailwind custom colors (terminal-*, profit, loss, amber) defined in tailwind.config.js.

## Non-obvious decisions
- Noise overlay uses `body::after` with SVG feTurbulence — no image asset needed.
- CSS custom properties in :root mirror Tailwind colors for use in recharts inline styles.
- EquityChart uses AreaChart with gradient fill (linearGradient in SVG defs).
- Order table has sticky header with max-h-[400px] scrollable body.
- `glow-header` class uses box-shadow with green rgba for header glow effect.
- API interfaces live in `src/types/api.ts`; `src/lib/api.ts` only exports the `api` object.
- AccountPanel fetches via HTTP polling (30s) since daemon has no WS event for account state. Unrealized PnL derived from positions array (real-time via WS).
- `ToastProvider` component in `lib/toast-provider.tsx`; `useToasts` hook in `lib/use-toasts.ts`.
- `orderTypeLabel` helper extracted to `components/order-type-label.ts` (shared by open-orders-table + position-card).
