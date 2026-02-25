---
name: chart-help
description: Visual guide for the TradingView chart. Use when the user says "chart help", "what's on the chart", "explain the chart", "guia do grafico", "o que aparece no grafico", or wants to understand what they see on the TradingView chart.
argument-hint: ""
disable-model-invocation: true
allowed-tools: "Read"
---

# Chart Help — TradingView Chart Visual Guide

## Purpose

Answer questions about what appears on the TradingView chart when the strategy "Solana STR" / "Bitcoin STR" / "Ethereum STR" is active. Use this guide as a quick reference.

## Instructions

When the user asks something about the chart, consult the sections below and answer directly and concisely. If the question isn't covered here, read the Pine script of the relevant asset at `assets/{ASSET}/strategy.pine` to find the answer.

---

## Order Labels (Strategy)

TradingView automatically places labels when the strategy executes orders:

| Label | Meaning |
|---|---|
| **L +7.325** | LONG entry of 7.325 units (qty). "+" = bought/opened position |
| **S +7.325** | SHORT entry of 7.325 units. "+" = sold/opened position |
| **L-SL -7.321** | LONG stop loss. "-" = closed position. Name comes from `strategy.exit("L-SL")` |
| **S-SL -7.321** | SHORT stop loss |
| **L-TP1 -3.66** | LONG take profit 1 (partial exit, e.g.: 50% of position) |
| **L-TP2 -3.66** | LONG take profit 2 (closes remaining position) |
| **S-TP1 -3.66** | SHORT take profit 1 (partial exit) |
| **S-TP2 -3.66** | SHORT take profit 2 (closes remaining) |
| **TimeStopNoTP1** | Time stop — closed because TP1 was not hit within X bars |

**Note:** The number after +/- is always the contract quantity (qty), not dollars.

---

## Chart Lines

| Color | Line | Meaning |
|---|---|---|
| **Purple (thick)** | EMA HTF | Exponential moving average from the higher timeframe (e.g.: 1h). Regime filter — price above = bullish, below = bearish |
| **Blue (thick)** | EMA Daily | Daily chart EMA (only appears if `useDailyTrend=true`). Macro trend filter |
| **Green (semi-transparent)** | Donchian Upper | Top of the Donchian channel (highest high of the last N candles). Breakout upward = LONG signal |
| **Red (semi-transparent)** | Donchian Lower | Bottom of the Donchian channel (lowest low). Breakout downward = SHORT signal |
| **Orange (thick)** | VWAP | Volume Weighted Average Price. Only appears if `useVwap=true` |
| **Green/Red (thin, alternating)** | SuperTrend | 15m SuperTrend indicator. Green = bullish, red = bearish. Only appears if `useSuper=true` |
| **White (during position)** | Entry | Entry price of the current position |
| **Red (during position)** | SL | Current stop loss. May move to breakeven after TP1 is hit |
| **Yellow (during position)** | TP1 | Take profit 1 (partial exit) |
| **Green (during position)** | TP2 | Take profit 2 (full exit of remaining) |

**Note:** Entry/SL/TP1/TP2 lines only appear while a position is open (and `showLevels=true`).

---

## Shapes (Triangles)

| Shape | Color | Meaning |
|---|---|---|
| **Triangle pointing up** below the bar, with "L" | Lime green | LONG signal generated (all conditions met on that candle) |
| **Triangle pointing down** above the bar, with "S" | Red | SHORT signal generated |

**Note:** The triangle appears on the candle that generated the signal. Order execution happens at that candle's close (`process_orders_on_close=true`).

---

## Background (Fill)

| Background Color | Meaning |
|---|---|
| **Light red (transparent)** | Guardrails blocking entries. Could be: bad UTC hour (`useSessionFilter`), bad day of week (`useDayFilter`), cooldown between trades, or daily entry limit reached |
| **No color** | Entries allowed (all guardrails OK) |

---

## Volume Bars (bottom)

The colored bars at the bottom of the chart are the volume of each 15-minute candle. Green = bullish candle, red = bearish candle. Height indicates relative volume.

---

## Top-Left Corner Info

| Text | Meaning |
|---|---|
| **SOL / USDC PERPETUAL CONTRACT · 15** | Pair, contract type, and timeframe (15 minutes) |
| **+0.008 (+0.01%)** | Price change in the period |
| **Vol · SOL** | Active volume indicator |
| **Solana STR** | Name of the active strategy on the chart |

---

## Horizontal Dashed Lines

- **Gray dashed line** with price label (e.g.: 85,190): current price / last traded price
- **Red dotted line** with red label (e.g.: 84,770): marks a relevant price level (could be SL, alert, or manual drawing)

---

## Special Icons

| Icon | Meaning |
|---|---|
| **Purple lightning bolt** (bottom) | TradingView alert fired on that candle |
| **Blue/purple arrows** | Strategy entry/exit arrows plotted by TradingView |

---

## Trade Flow on the Chart

1. **Clean background** (no red) → guardrails OK, entries allowed
2. **Green triangle "L"** appears below a candle → LONG signal generated
3. **Label "L +7.325"** → strategy executed entry, bought 7.325 units
4. **White/red/yellow/green lines** appear → Entry, SL, TP1, TP2
5. Price rises and hits TP1 → **Label "L-TP1 -3.66"** → sold 50% of position
6. SL moves to breakeven (if `useBreakEvenAfterTp1=true`)
7. Price hits TP2 → **Label "L-TP2 -3.66"** → closed remaining
8. Or price drops to SL → **Label "L-SL -7.321"** → stop loss, position closed
9. Lines disappear (position zeroed)

---

## Quick Tips

- **Zoom out** to see more trades and identify patterns
- **Hover** over any order label to see details (price, qty, P&L)
- **Strategy Tester** (bottom tab) shows full trade list, metrics, and equity curve
- **Constant red background** = blocked hour/day. Normal — the strategy avoids bad periods
- If you don't see TP/SL lines, check if `Show Entry/SL/TP` is enabled in the strategy inputs ("Visual" group)
