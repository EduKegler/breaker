# CLAUDE Instructions — explorer

## Project overview
Live trading dashboard — Vite + React SPA that visualizes exchange positions, orders, and equity curve. Consumes APIs from @breaker/exchange via Vite dev proxy.

## Project structure
```
├── src/
│   ├── main.tsx            # React root
│   ├── app.tsx             # App shell: per-coin state, WS routing, chart filtering
│   ├── components/
│   │   ├── candlestick-chart.tsx   # lightweight-charts v5.1 candlestick + markers
│   │   ├── coin-chart-toolbar.tsx  # Coin tabs + strategy toggles above chart
│   │   ├── position-card.tsx       # Position card with PnL
│   │   ├── order-table.tsx         # Sortable order table
│   │   ├── signal-popover.tsx      # Quick signal popover (multi-coin)
│   │   ├── candle-countdown.tsx   # Countdown timer to next candle close
│   │   └── ...
│   ├── lib/
│   │   ├── api.ts                  # Fetch wrapper for exchange APIs
│   │   ├── strategy-abbreviations.ts # [B], [MR], [PB] abbreviation map
│   │   ├── parse-utc.ts            # UTC date parser for SQLite datetimes
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
- CandlestickChart uses `update()` for incremental WS ticks (O(1)) and `setData()` only for full dataset (init, coin switch, load more) — smart delta detection via refs
- Coin switch reuses same chart instance (no `key` remount) — `setData()` + `scrollToRealTime()` handles the transition; markers and price lines effects have proper dependency arrays for cleanup
- API interfaces in `src/types/api.ts`; `src/lib/api.ts` exports the `api` object
- `ToastProvider` in `lib/toast-provider.tsx`; `useToasts` hook in `lib/use-toasts.ts`
- No backend server needed — Vite proxy handles API routing in dev
