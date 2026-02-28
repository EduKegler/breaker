# CLAUDE Instructions — explorer

## Project overview
Live trading dashboard — Vite + React SPA that visualizes exchange positions, orders, and equity curve. Consumes APIs from @breaker/exchange via Vite dev proxy.

## Project structure
```
├── src/
│   ├── main.tsx            # React root
│   ├── app.tsx             # App shell with nav (Dashboard/Orders/Equity)
│   ├── pages/
│   │   ├── dashboard.tsx   # Positions + equity + status bar
│   │   ├── orders.tsx      # Order history table
│   │   └── equity.tsx      # Full equity chart
│   ├── components/
│   │   ├── position-card.tsx  # Position card with PnL
│   │   ├── order-table.tsx    # Sortable order table
│   │   └── equity-chart.tsx   # recharts line chart
│   ├── lib/
│   │   ├── api.ts          # Fetch wrapper for exchange APIs
│   │   └── use-poll.ts     # Generic polling hook
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
- Exchange endpoints: /health, /positions, /orders, /equity, /config, /open-orders
- WS events: "candle" appends new candle, "signals" replaces signals array

## Build and test
- `pnpm dev` — Vite dev server on port 5173
- `pnpm build` — tsc + vite build (output in dist/)
- `pnpm test` — vitest (passWithNoTests, frontend is manually tested)

## Key patterns
- useWebSocket hook with auto-reconnect (3s), WS status indicator in header
- "Tactical Terminal" dark aesthetic: terminal-bg (#0a0a0f), noise overlay via SVG feTurbulence
- Entry markers: blue (auto) / yellow (manual), "L"/"S" text, size 1
- API interfaces in `src/types/api.ts`; `src/lib/api.ts` exports the `api` object
- `ToastProvider` in `lib/toast-provider.tsx`; `useToasts` hook in `lib/use-toasts.ts`
- No backend server needed — Vite proxy handles API routing in dev
