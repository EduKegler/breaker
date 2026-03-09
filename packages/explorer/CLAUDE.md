# CLAUDE Instructions — explorer

## Project overview
Live trading dashboard — Vite + React SPA that visualizes exchange positions, orders, and equity curve. Consumes APIs from @breaker/exchange via Vite dev proxy.

## Project structure
```
├── src/
│   ├── main.tsx            # React root (QueryProvider > ToastProvider > App)
│   ├── app.tsx             # App shell: side effects, layout
│   ├── store/
│   │   ├── types.ts            # StoreState = ServerSlice & MarketDataSlice & UiSlice & Actions
│   │   ├── use-store.ts        # create<StoreState>()(...) — Zustand store
│   │   ├── server-slice.ts     # positions, orders, openOrders, equity, signals, pendingEntries (WS-pushed)
│   │   ├── market-data-slice.ts # coinCandles, coinReplaySignals, coinPrices, candlesLoading
│   │   ├── ui-slice.ts         # selectedCoin, selectedInterval, enabledStrategies, show*, priceFlash, wsStatus
│   │   ├── actions.ts          # fetchInitialData, initCoinData, loadMoreCandles, UI actions
│   │   ├── selectors.ts        # selectStreamingCandles, selectFilteredSignals, deriveCoinList, etc.
│   │   └── websocket.ts        # connectWebSocket(url, store) → cleanup fn (bridges WS → QueryClient)
│   ├── components/
│   │   ├── candlestick-chart.tsx   # Chart orchestrator (~160 lines), delegates to hooks
│   │   ├── coin-chart-toolbar.tsx  # Coin tabs + strategy toggles above chart
│   │   ├── position-card.tsx       # Position card with PnL
│   │   ├── order-table.tsx         # Sortable order table
│   │   ├── signal-popover.tsx      # Quick signal popover (multi-coin, uses useSendQuickSignal)
│   │   ├── candle-countdown.tsx    # Countdown timer to next candle close
│   │   ├── timeframe-switcher.tsx  # Interval pill buttons (1m..1d) with LIVE badge
│   │   ├── history-tabs.tsx        # Tab switcher: Positions / Signals history
│   │   ├── signal-history-table.tsx # Signal history with outcome badges (executed/blocked/rejected)
│   │   └── ...
│   ├── lib/
│   │   ├── api.ts                  # Fetch wrapper for exchange APIs
│   │   ├── query-keys.ts           # React Query key factories (as const tuples)
│   │   ├── query-provider.tsx      # QueryClient + QueryClientProvider
│   │   ├── use-health-query.ts     # useQuery — health (staleTime: Infinity, WS setQueryData)
│   │   ├── use-config-query.ts     # useQuery — config (staleTime: Infinity)
│   │   ├── use-account-query.ts    # useQuery — account (refetchInterval: 30s)
│   │   ├── use-position-history-query.ts # useQuery — position history (WS setQueryData)
│   │   ├── use-alt-candles-query.ts # useQuery — alt timeframe candles (keyed by coin+interval)
│   │   ├── use-active-candles.ts   # Combines streaming candles (Zustand) with alt candles (RQ)
│   │   ├── use-close-position.ts   # useMutation — close position
│   │   ├── use-cancel-order.ts     # useMutation — cancel order
│   │   ├── use-toggle-auto-trading.ts # useMutation — toggle auto trading (optimistic)
│   │   ├── use-send-quick-signal.ts # useMutation — send quick signal
│   │   ├── strategy-abbreviations.ts # [B], [MR], [PB] abbreviation map + strategyLabel()
│   │   ├── parse-utc.ts            # UTC date parser for SQLite datetimes
│   │   ├── to-chart-time.ts        # toChartTime(), toOhlcData(), toOhlcvData() shared helpers
│   │   ├── interval-ms.ts          # INTERVAL_MS constant (shared by countdown + switcher)
│   │   ├── compute-vpvr.ts         # Pure function: volume profile (VPVR) bucket computation
│   │   ├── use-chart-instance.ts   # Hook: creates chart, volume series, crosshair, legend
│   │   ├── use-chart-candles.ts    # Hook: smart delta detection + incremental updates
│   │   ├── use-chart-markers.ts    # Hook: signal markers + vertical lines primitive
│   │   ├── use-chart-price-lines.ts # Hook: partial price lines (Entry, SL, TP, TSL, Liq)
│   │   ├── use-keyboard-shortcuts.ts # Hook: Space, Home, +/-, ←/→ coin navigation
│   │   ├── primitives/
│   │   │   ├── canvas-types.ts         # Local types for ISeriesPrimitive canvas rendering
│   │   │   ├── crosshair-highlight.ts  # Semi-transparent bar highlight under cursor
│   │   │   ├── signal-vertical-lines.ts # Dashed vertical lines at signal timestamps
│   │   │   ├── partial-price-lines.ts  # Horizontal lines from openedAt to right edge
│   │   │   ├── session-highlight.ts    # Asia/Europe/America session background colors
│   │   │   └── volume-profile.ts       # VPVR horizontal histogram on right side
│   │   └── ...
│   └── index.css           # Tailwind imports
├── index.html              # SPA entry
├── vite.config.ts          # Vite + React plugin + proxy to :3200
├── tailwind.config.js
├── postcss.config.js
└── tsconfig.json           # Bundler resolution (not NodeNext)
```

## Stack
- Vite 6 + React 19 + TypeScript + **Zustand** (WS/UI state) + **React Query** (server state)
- Tailwind CSS 3 for styling (custom colors: terminal-*, profit, loss, amber)
- recharts for equity curve, lightweight-charts v5.1 for candlestick chart
- Fonts: Outfit (display) + JetBrains Mono (data) via Google Fonts

## State management — what goes where

### React Query (server state)
- **Queries**: health, config, account (polling 30s), positionHistory, altCandles (keyed by coin+interval)
- **Mutations**: closePosition, cancelOrder, toggleAutoTrading, sendQuickSignal
- WS events update React Query cache via `setQueryData()` (e.g., health, position-history)
- WS "positions" event triggers `invalidateQueries(["server", "account"])` for cross-invalidation
- Query hooks in `lib/use-*-query.ts`, mutation hooks in `lib/use-*.ts`
- `queryClient` exported from `lib/query-provider.tsx` for non-React access (e.g., websocket.ts)

### Zustand (WS-pushed + UI state)
- **ServerSlice**: positions, orders, openOrders, equity, signals, pendingEntries (all WS-pushed)
- **MarketDataSlice**: coinCandles, coinReplaySignals, coinPrices (WS incremental + REST seed)
- **UiSlice**: selectedCoin, selectedInterval, enabledStrategies, show*, priceFlash, wsStatus, autoTrading
- **Actions**: fetchInitialData (WS bootstrap), initCoinData, loadMoreCandles, UI toggles
- **Selectors** in `store/selectors.ts`: `selectStreamingCandles`, `selectFilteredSignals`, `deriveCoinList`, etc.
- **WebSocket standalone**: `connectWebSocket()` writes via `setState()` + `_qc?.setQueryData()`

### Decision rule
- Data that is **fetched once or polled** → React Query
- Data with **WS incremental merge** (candles, replay signals) → Zustand
- **Mutations** with toast feedback → React Query `useMutation`
- **UI state** → Zustand

## Data flow
- Hybrid HTTP+WS model: React Query queries + `fetchInitialData` (WS bootstrap) + WebSocket push
- Vite dev proxy: `/api/*` → `http://localhost:3200/*`, `/ws` with `ws: true`
- Exchange endpoints: /health, /positions, /orders, /equity, /config, /open-orders, /candles, /signals, /strategy-signals
- WS events: "candle" (routed by `coin`), "prices" (routed by `coin`), "signals" replaces signals array
- **Per-coin state**: `coinCandles`, `coinReplaySignals`, `coinPrices` keyed by coin name in store
- Derived data (`selectFilteredSignals`, `selectFilteredReplaySignals`, `selectCoinPositions`) computed in selectors

## Build and test
- `pnpm dev` — Vite dev server on port 5173
- `pnpm build` — tsc + vite build (output in dist/)
- `pnpm test` — vitest (passWithNoTests, frontend is manually tested)

## Key patterns
- "Tactical Terminal" dark aesthetic: terminal-bg (#0a0a0f), noise overlay via SVG feTurbulence
- Entry markers: blue (auto) / yellow (manual), "L"/"S" text, size 1
- Strategy abbreviations: derived dynamically from `moduleType` (B=breakout, MR=mean-reversion, PB=pullback, TF=trend-following) or from strategy name initials. `[M]` = manual — centralized in `strategy-abbreviations.ts`
- CandlestickChart is a memo'd orchestrator (~160 lines) that delegates to 4 specialized hooks: `useChartInstance`, `useChartCandles`, `useChartMarkers`, `useChartPriceLines`
- Smart delta detection via refs: `update()` for incremental WS ticks (O(1)), `setData()` only for full dataset (init, coin switch, load more)
- Coin switch reuses same chart instance (no `key` remount) — `setData()` + `scrollToRealTime()` handles the transition
- Canvas primitives use `ISeriesPrimitive<Time>` from lightweight-charts v5.1, drawing via `useBitmapCoordinateSpace()`. Local `canvas-types.ts` provides structural types (fancy-canvas types not directly exported)
- lw-charts v5.1 subscribe/unsubscribe: `subscribeVisibleLogicalRangeChange(handler)` returns void — use separate `unsubscribeVisibleLogicalRangeChange(handler)` for cleanup
- Session/VPVR primitives: single effect each (attach + update), re-run when candles/coin changes (not on every in-progress tick — handled by incremental `update()` path)
- Shared helpers: `toChartTime()`, `toOhlcData()`, `toOhlcvData()`, `chartTimeToUtcSec()` in `lib/to-chart-time.ts`; `INTERVAL_MS` in `lib/interval-ms.ts`
- **Timezone**: lw-charts has no native TZ support — `toChartTime()` subtracts `TZ_OFFSET_SEC` (computed once from `getTimezoneOffset()`) so the X-axis shows local time. Use `chartTimeToUtcSec()` to reverse when real UTC is needed (e.g., session-highlight hour detection)
- Timeframe switcher: `selectedInterval: string | null` (null = streaming interval); alt candles fetched via `useAltCandlesQuery` (keyed by coin+interval, eliminates race conditions)
- API interfaces in `src/types/api.ts`; `src/lib/api.ts` exports the `api` object
- `ToastProvider` in `lib/toast-provider.tsx`; `useToasts` hook in `lib/use-toasts.ts`
- Mutations use `useToasts()` directly (no toast bridge needed)
- **React Compiler** active via `babel-plugin-react-compiler` in vite.config.ts — auto-memoizes components/hooks, no manual `React.memo` or `useMemo`/`useCallback` needed for perf. Write plain functions and let the compiler optimize.
- No backend server needed — Vite proxy handles API routing in dev
