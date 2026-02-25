# Alert Schema v2 (Semi-Auto: TradingView -> Webhook -> WhatsApp)

Updated: 2026-02-24

Source: `assets/{ASSET}/strategy.pine` (the `alert()` blocks inside `canLongEntry` / `canShortEntry`)

## Single type: ENTRY

Fires on bar close when signal is confirmed (`alert.freq_once_per_bar_close`).

## JSON Payload

```json
{
  "alert_id": "BTC-L-1709312400000",
  "event_type": "ENTRY",
  "asset": "BTC",
  "side": "LONG",
  "entry": 97500.00,
  "sl": 95200.00,
  "tp1": 98650.00,
  "tp2": 103000.00,
  "tp1_pct": 50,
  "qty": 0.012,
  "leverage": 5,
  "risk_usd": 10.00,
  "notional_usdc": 1170.00,
  "margin_usdc": 234.00,
  "signal_ts": 1709312400,
  "bar_ts": 1709312400,
  "secret": "your-webhook-secret"
}
```

## Fields

| Field | Type | Description |
|---|---|---|
| alert_id | string | `{ASSET}-{L|S}-{time_ms}` — idempotency key |
| event_type | string | Always `"ENTRY"` |
| asset | string | `syminfo.basecurrency` (BTC, ETH, SOL) |
| side | string | `"LONG"` or `"SHORT"` |
| entry | float | Entry price (close of confirmed candle) |
| sl | float | Stop loss (entry +/- atrMult * ATR) |
| tp1 | float | Take profit 1 (entry +/- rr1 * stopDist) |
| tp2 | float | Take profit 2 (entry +/- rr2 * stopDist) |
| tp1_pct | int | % of position to close at TP1 |
| qty | float | Quantity (asset units) |
| leverage | int | Configured leverage (BTC=5, ETH=5, SOL=3) |
| risk_usd | float | Risk per trade in USD |
| notional_usdc | float | Total position value (qty * entry) |
| margin_usdc | float | Required margin (notional / leverage) |
| signal_ts | int | Unix timestamp (seconds) of the signal |
| bar_ts | int | Unix timestamp (seconds) of the bar |
| secret | string? | Shared secret for authentication (must match WEBHOOK_SECRET) |

## Usage rules (webhook)

- `alert_id` must be used for idempotency (ignore duplicates)
- If `signal_ts` > 1200s (20min) ago: ignore (TTL expired). TTL is high because signal_ts uses candle open time on 15m, and the alert fires at close (~900s later).
- If current price drift > 0.25R from `entry`: discard
- Exits (SL/TP) are managed manually at the time of entry
