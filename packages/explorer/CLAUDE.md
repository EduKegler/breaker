# CLAUDE Instructions — explorer

## Project overview
Live trading dashboard — Vite + React SPA that visualizes exchange positions, orders, and equity curve. Consumes APIs from @breaker/exchange via Vite dev proxy.

## Project structure
```
├── src/
│   ├── main.tsx            # React root
│   ├── app.tsx             # App shell: per-coin state, WS routing, chart filtering
│   ├── components/
│   │   ├── candlestick-chart.tsx   # Chart orchestrator (~250 lines), delegates to hooks
│   │   ├── coin-chart-toolbar.tsx  # Coin tabs + strategy toggles above chart
│   │   ├── position-card.tsx       # Position card with PnL
│   │   ├── order-table.tsx         # Sortable order table
│   │   ├── signal-popover.tsx      # Quick signal popover (multi-coin)
│   │   ├── candle-countdown.tsx    # Countdown timer to next candle close
│   │   ├── timeframe-switcher.tsx  # Interval pill buttons (1m..1d) with LIVE badge
│   │   ├── range-selector.tsx      # Brushable mini-chart for visible range control
│   │   └── ...
│   ├── lib/
│   │   ├── api.ts                  # Fetch wrapper for exchange APIs
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
- Vite 6 + React 19 + TypeScript
- Tailwind CSS 3 for styling (custom colors: terminal-*, profit, loss, amber)
- recharts for equity curve, lightweight-charts v5.1 for candlestick chart
- Fonts: Outfit (display) + JetBrains Mono (data) via Google Fonts

## Data flow
- Hybrid HTTP+WS model: initial HTTP fetch + WebSocket push updates
- Vite dev proxy: `/api/*` → `http://localhost:3200/*`, `/ws` with `ws: true`
- Exchange endpoints: /health, /positions, /orders, /equity, /config, /open-orders, /candles, /signals, /strategy-signals
- WS events: "candle" (routed by `coin`), "prices" (routed by `coin`), "signals" replaces signals array
- **Per-coin state**: `coinCandles`, `coinReplaySignals`, `coinPrices` keyed by coin name
- `selectedCoinRef` (useRef) prevents stale closures in WS handlers
- Derived data (`filteredSignals`, `filteredReplaySignals`, `coinPositions`) computed via `useMemo`

## Build and test
- `pnpm dev` — Vite dev server on port 5173
- `pnpm build` — tsc + vite build (output in dist/)
- `pnpm test` — vitest (passWithNoTests, frontend is manually tested)

## Key patterns
- useWebSocket hook with auto-reconnect (3s), WS status indicator in header
- "Tactical Terminal" dark aesthetic: terminal-bg (#0a0a0f), noise overlay via SVG feTurbulence
- Entry markers: blue (auto) / yellow (manual), "L"/"S" text, size 1
- Strategy abbreviations: `[B]` donchian-adx, `[MR]` keltner-rsi2, `[PB]` ema-pullback, `[M]` manual — centralized in `strategy-abbreviations.ts`
- CandlestickChart is an orchestrator (~250 lines) that delegates to 4 specialized hooks: `useChartInstance`, `useChartCandles`, `useChartMarkers`, `useChartPriceLines`
- Smart delta detection via refs: `update()` for incremental WS ticks (O(1)), `setData()` only for full dataset (init, coin switch, load more)
- Coin switch reuses same chart instance (no `key` remount) — `setData()` + `scrollToRealTime()` handles the transition
- Canvas primitives use `ISeriesPrimitive<Time>` from lightweight-charts v5.1, drawing via `useBitmapCoordinateSpace()`. Local `canvas-types.ts` provides structural types (fancy-canvas types not directly exported)
- lw-charts v5.1 subscribe/unsubscribe: `subscribeVisibleLogicalRangeChange(handler)` returns void — use separate `unsubscribeVisibleLogicalRangeChange(handler)` for cleanup
- RangeSelector ↔ CandlestickChart sync uses imperative refs (not React state) to avoid App re-renders on every scroll frame
- Session/VPVR primitives only recalculate when `candles.length` changes (not on every in-progress tick update)
- Shared helpers: `toChartTime()`, `toOhlcData()`, `toOhlcvData()` in `lib/to-chart-time.ts`; `INTERVAL_MS` in `lib/interval-ms.ts`
- Timeframe switcher: `selectedInterval: string | null` (null = streaming interval); alt candles fetched via `api.candles({ interval })`
- API interfaces in `src/types/api.ts`; `src/lib/api.ts` exports the `api` object
- `ToastProvider` in `lib/toast-provider.tsx`; `useToasts` hook in `lib/use-toasts.ts`
- No backend server needed — Vite proxy handles API routing in dev
