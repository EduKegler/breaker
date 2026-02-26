# AGENTS Instructions — explorer

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
- Tailwind CSS 3 for styling
- recharts for equity curve
- Polling every 5-10s (no WebSocket)

## Data flow
- Vite dev proxy: `/api/*` → `http://localhost:3200/*`
- Exchange endpoints: /health, /positions, /orders, /equity, /config

## Build and test
- `pnpm dev` — Vite dev server on port 5173
- `pnpm build` — tsc + vite build (output in dist/)
- `pnpm test` — vitest (passWithNoTests, frontend is manually tested)

## Key patterns
- usePoll hook: auto-refresh with configurable interval, error/loading state
- No backend server needed — Vite proxy handles API routing in dev
- Dark theme (gray-950 bg, gray-100 text) — consistent with terminal aesthetic
