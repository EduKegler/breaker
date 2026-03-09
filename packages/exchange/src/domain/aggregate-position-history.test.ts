import { describe, it, expect } from "vitest";
import { aggregatePositionHistory, type PositionHistoryRow } from "./aggregate-position-history.js";

function row(overrides: Partial<PositionHistoryRow>): PositionHistoryRow {
  return {
    signal_id: 1,
    asset: "BTC",
    side: "LONG",
    strategy_name: "test-strat",
    entry_price: 95000,
    created_at: "2024-01-10T10:00:00",
    funding_paid: null,
    order_id: 1,
    tag: "entry",
    status: "filled",
    price: 95000,
    size: 0.01,
    order_side: "buy",
    order_type: "market",
    mode: "testnet",
    order_created_at: "2024-01-10T10:00:01",
    filled_at: "2024-01-10T10:00:02",
    fill_price: 95010,
    fill_size: 0.01,
    fee: 0.5,
    fill_ts: "2024-01-10T10:00:02",
    ...overrides,
  };
}

describe("aggregatePositionHistory", () => {
  it("aggregates a LONG position closed by SL (negative PnL)", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01, order_side: "buy", fill_price: 95000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: 94000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:03", filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
      row({ order_id: 3, tag: "tp1", status: "cancelled", price: 97000, size: 0.005, order_side: "sell", order_type: "limit", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:00:03", filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.signalId).toBe(1);
    expect(pos.coin).toBe("BTC");
    expect(pos.direction).toBe("LONG");
    expect(pos.strategy).toBe("test-strat");
    expect(pos.status).toBe("CLOSED");
    expect(pos.size).toBe(0.01);
    expect(pos.entryPrice).toBe(95000);
    expect(pos.exitPrice).toBe(94000);
    // PnL: (94000 - 95000) * 0.01 - 1.0 fees = -10 - 1 = -11
    expect(pos.realizedPnl).toBeCloseTo(-11, 2);
    expect(pos.totalFees).toBeCloseTo(1, 2);
    expect(pos.pnlPercent).toBeCloseTo(-1.158, 1); // -11 / 950 * 100
    expect(pos.openedAt).toBe("2024-01-10T10:00:02");
    expect(pos.closedAt).toBe("2024-01-10T10:05:00");
    expect(pos.durationMs).toBeGreaterThan(0);
  });

  it("aggregates a SHORT position closed by TP (positive PnL)", () => {
    const rows: PositionHistoryRow[] = [
      row({ signal_id: 2, asset: "ETH", side: "SHORT", strategy_name: "test-strat-mr", created_at: "2024-01-10T12:00:00", order_id: 10, tag: "entry", status: "filled", price: 3000, size: 0.1, order_side: "sell", fill_price: 3000, fill_size: 0.1, fee: 0.3, order_created_at: "2024-01-10T12:00:01", filled_at: "2024-01-10T12:00:02", fill_ts: "2024-01-10T12:00:02" }),
      row({ signal_id: 2, asset: "ETH", side: "SHORT", strategy_name: "test-strat-mr", created_at: "2024-01-10T12:00:00", order_id: 11, tag: "tp1", status: "filled", price: 2900, size: 0.1, order_side: "buy", order_type: "limit", fill_price: 2900, fill_size: 0.1, fee: 0.3, order_created_at: "2024-01-10T12:00:03", filled_at: "2024-01-10T12:30:00", fill_ts: "2024-01-10T12:30:00" }),
      row({ signal_id: 2, asset: "ETH", side: "SHORT", strategy_name: "test-strat-mr", created_at: "2024-01-10T12:00:00", order_id: 12, tag: "sl", status: "cancelled", price: 3100, size: 0.1, order_side: "buy", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T12:00:03", filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.direction).toBe("SHORT");
    expect(pos.status).toBe("CLOSED");
    expect(pos.entryPrice).toBe(3000);
    expect(pos.exitPrice).toBe(2900);
    // PnL SHORT: (3000 - 2900) * 0.1 - 0.6 fees = 10 - 0.6 = 9.4
    expect(pos.realizedPnl).toBeCloseTo(9.4, 2);
    expect(pos.totalFees).toBeCloseTo(0.6, 2);
  });

  it("marks position as OPEN when no exit fills exist", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "pending", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
      row({ order_id: 3, tag: "tp1", status: "pending", price: 97000, size: 0.005, order_side: "sell", order_type: "limit", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.status).toBe("OPEN");
    expect(pos.exitPrice).toBeNull();
    expect(pos.realizedPnl).toBeNull();
    expect(pos.pnlPercent).toBeNull();
    expect(pos.closedAt).toBeNull();
    expect(pos.durationMs).toBeNull();
  });

  it("detects trailing SL moved events (cancelled + new pending)", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "trailing-sl", status: "cancelled", price: 94500, size: 0.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:10:00", filled_at: null }),
      row({ order_id: 3, tag: "trailing-sl", status: "pending", price: 95500, size: 0.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:20:00", filled_at: null }),
      row({ order_id: 4, tag: "sl", status: "pending", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:00:03", filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    const events = result[0].events;

    const trailingPlaced = events.filter((e) => e.type === "trailing_sl_placed");
    const trailingMoved = events.filter((e) => e.type === "trailing_sl_moved");

    expect(trailingPlaced).toHaveLength(1);
    expect(trailingMoved).toHaveLength(1);
    expect(trailingMoved[0].details).toContain("94500");
    expect(trailingMoved[0].details).toContain("95500");
  });

  it("sorts OPEN positions before CLOSED positions", () => {
    const closedRows: PositionHistoryRow[] = [
      row({ signal_id: 1, created_at: "2024-01-10T10:00:00", order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ signal_id: 1, created_at: "2024-01-10T10:00:00", order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", fill_price: 94000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
    ];
    const openRows: PositionHistoryRow[] = [
      row({ signal_id: 2, created_at: "2024-01-10T11:00:00", order_id: 10, tag: "entry", status: "filled", fill_price: 96000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T11:00:02", fill_ts: "2024-01-10T11:00:02" }),
      row({ signal_id: 2, created_at: "2024-01-10T11:00:00", order_id: 11, tag: "sl", status: "pending", price: 95000, size: 0.01, order_side: "sell", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
    ];

    const result = aggregatePositionHistory([...closedRows, ...openRows]);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe("OPEN");
    expect(result[1].status).toBe("CLOSED");
  });

  it("calculates fees correctly from all fills", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "tp1", status: "filled", price: 97000, size: 0.005, order_side: "sell", order_type: "limit", fill_price: 97000, fill_size: 0.005, fee: 0.25, filled_at: "2024-01-10T10:30:00", fill_ts: "2024-01-10T10:30:00" }),
      row({ order_id: 3, tag: "sl", status: "filled", price: 94500, size: 0.005, order_side: "sell", order_type: "stop", fill_price: 94500, fill_size: 0.005, fee: 0.25, filled_at: "2024-01-10T11:00:00", fill_ts: "2024-01-10T11:00:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result[0].totalFees).toBeCloseTo(1.0, 2); // 0.5 + 0.25 + 0.25
  });

  it("handles partial TP (50% TP1 + 50% SL)", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "tp1", status: "filled", price: 97000, size: 0.005, order_side: "sell", order_type: "limit", fill_price: 97000, fill_size: 0.005, fee: 0.25, filled_at: "2024-01-10T10:30:00", fill_ts: "2024-01-10T10:30:00" }),
      row({ order_id: 3, tag: "sl", status: "filled", price: 94500, size: 0.005, order_side: "sell", order_type: "stop", fill_price: 94500, fill_size: 0.005, fee: 0.25, filled_at: "2024-01-10T11:00:00", fill_ts: "2024-01-10T11:00:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    const pos = result[0];

    expect(pos.status).toBe("CLOSED");
    expect(pos.size).toBe(0.01);
    // Exit: weighted avg = (97000*0.005 + 94500*0.005) / 0.01 = 95750
    expect(pos.exitPrice).toBeCloseTo(95750, 0);
    // PnL LONG: (97000*0.005 + 94500*0.005) - 95000*0.01 - fees
    // = (485 + 472.5) - 950 - 1.0 = 957.5 - 950 - 1 = 6.5
    expect(pos.realizedPnl).toBeCloseTo(6.5, 2);
  });

  it("falls back to order price/size when fill record is missing (legacy data)", () => {
    const rows: PositionHistoryRow[] = [
      row({
        order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01,
        fill_price: null, fill_size: null, fee: null, fill_ts: null,
        filled_at: "2024-01-10T10:00:02",
      }),
      row({
        order_id: 2, tag: "sl", status: "pending", price: 94000, size: 0.01,
        order_side: "sell", order_type: "stop",
        fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null,
      }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.status).toBe("OPEN");
    expect(pos.entryPrice).toBe(95000);
    expect(pos.size).toBe(0.01);
  });

  it("returns empty array for empty input", () => {
    expect(aggregatePositionHistory([])).toEqual([]);
  });

  it("generates correct event timeline", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: 94000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:03", filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
      row({ order_id: 3, tag: "tp1", status: "cancelled", price: 97000, size: 0.005, order_side: "sell", order_type: "limit", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:00:03", filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    const events = result[0].events;

    const types = events.map((e) => e.type);
    expect(types).toContain("signal_received");
    expect(types).toContain("entry_placed");
    expect(types).toContain("entry_filled");
    expect(types).toContain("sl_placed");
    expect(types).toContain("tp_placed");
    expect(types).toContain("sl_filled");

    // Events should be sorted by timestamp
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp >= events[i - 1].timestamp).toBe(true);
    }
  });

  it("includes signal price in signal_received event", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", entry_price: 95200, fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "pending", price: 94000, size: 0.01, order_side: "sell", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
    ];

    const events = aggregatePositionHistory(rows)[0].events;
    const signalEvent = events.find((e) => e.type === "signal_received")!;
    expect(signalEvent.details).toBe("Signal received @ 95200");
  });

  it("closes position via strategy exit order (tag=exit)", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "cancelled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
      row({ order_id: 3, tag: "exit", status: "filled", price: 94500, size: 0.01, order_side: "sell", order_type: "market", fill_price: 94500, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T11:00:00", filled_at: "2024-01-10T11:00:00", fill_ts: "2024-01-10T11:00:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);
    const pos = result[0];
    expect(pos.status).toBe("CLOSED");
    expect(pos.exitPrice).toBe(94500);
    // PnL: (94500 - 95000) * 0.01 - 1.0 = -5 - 1 = -6
    expect(pos.realizedPnl).toBeCloseTo(-6, 2);

    const exitEvent = pos.events.find((e) => e.type === "exit_filled");
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.details).toContain("94500");
  });

  it("aggregates multiple partial fills for the same order (LEFT JOIN rows)", () => {
    // Regression: SQL LEFT JOIN produces one row per fill.
    // An exit order with 3 partial fills must sum sizes/fees and compute VWAP.
    const rows: PositionHistoryRow[] = [
      // Entry: single fill
      row({ order_id: 1, tag: "entry", status: "filled", price: 85, size: 1.01, order_side: "buy", fill_price: 85.203, fill_size: 1.01, fee: 0.04, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      // SL cancelled
      row({ order_id: 2, tag: "sl", status: "cancelled", price: 83, size: 1.01, order_side: "sell", order_type: "stop", fill_price: null, fill_size: null, fee: null, fill_ts: null, order_created_at: "2024-01-10T10:00:03", filled_at: null }),
      // Exit: 3 partial fills (same order_id = 3, different fill rows from LEFT JOIN)
      row({ order_id: 3, tag: "exit", status: "filled", price: 86.5, size: 1.01, order_side: "sell", order_type: "market", fill_price: 86.50, fill_size: 0.40, fee: 0.02, order_created_at: "2024-01-10T15:00:00", filled_at: "2024-01-10T15:00:00", fill_ts: "2024-01-10T15:00:00" }),
      row({ order_id: 3, tag: "exit", status: "filled", price: 86.5, size: 1.01, order_side: "sell", order_type: "market", fill_price: 86.60, fill_size: 0.50, fee: 0.02, order_created_at: "2024-01-10T15:00:00", filled_at: "2024-01-10T15:00:00", fill_ts: "2024-01-10T15:00:01" }),
      row({ order_id: 3, tag: "exit", status: "filled", price: 86.5, size: 1.01, order_side: "sell", order_type: "market", fill_price: 86.70, fill_size: 0.11, fee: 0.01, order_created_at: "2024-01-10T15:00:00", filled_at: "2024-01-10T15:00:00", fill_ts: "2024-01-10T15:00:02" }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.status).toBe("CLOSED");
    expect(pos.size).toBe(1.01);
    expect(pos.entryPrice).toBeCloseTo(85.203, 3);

    // Exit VWAP: (86.50*0.40 + 86.60*0.50 + 86.70*0.11) / (0.40+0.50+0.11) = 86.5871.../1.01
    const expectedExitValue = 86.50 * 0.40 + 86.60 * 0.50 + 86.70 * 0.11;
    const expectedExitVwap = expectedExitValue / 1.01;
    expect(pos.exitPrice).toBeCloseTo(expectedExitVwap, 2);

    // Total fees: entry 0.04 + exit (0.02+0.02+0.01)
    expect(pos.totalFees).toBeCloseTo(0.09, 4);

    // PnL LONG: exitValue - entryValue - fees
    const entryValue = 85.203 * 1.01;
    const expectedPnl = expectedExitValue - entryValue - 0.09;
    expect(pos.realizedPnl).toBeCloseTo(expectedPnl, 2);
    // Must be POSITIVE (exit > entry for a LONG)
    expect(pos.realizedPnl!).toBeGreaterThan(0);
  });

  it("aggregates multiple partial fills for entry order too", () => {
    // Entry with 2 partial fills + single SL exit
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01, order_side: "buy", fill_price: 95000, fill_size: 0.006, fee: 0.3, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01, order_side: "buy", fill_price: 95100, fill_size: 0.004, fee: 0.2, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:03" }),
      row({ order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: 94000, fill_size: 0.01, fee: 0.5, order_created_at: "2024-01-10T10:00:03", filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    const pos = result[0];

    // Entry VWAP: (95000*0.006 + 95100*0.004) / 0.01 = (570+380.4)/0.01 = 95040
    expect(pos.entryPrice).toBeCloseTo(95040, 0);
    expect(pos.size).toBeCloseTo(0.01, 6);
    // Total fees: 0.3 + 0.2 + 0.5 = 1.0
    expect(pos.totalFees).toBeCloseTo(1.0, 2);
  });

  it("includes funding_paid in PnL calculation for closed positions", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01, order_side: "buy", fill_price: 95000, fill_size: 0.01, fee: 0.5, funding_paid: -3.5, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: 94000, fill_size: 0.01, fee: 0.5, funding_paid: -3.5, order_created_at: "2024-01-10T10:00:03", filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.fundingPaid).toBe(-3.5);
    // PnL without funding: (94000 - 95000) * 0.01 - 1.0 fees = -10 - 1 = -11
    // PnL with funding: -11 + (-3.5) = -14.5
    expect(pos.realizedPnl).toBeCloseTo(-14.5, 2);
  });

  it("defaults fundingPaid to 0 when funding_paid is null", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", status: "filled", price: 95000, size: 0.01, order_side: "buy", fill_price: 95000, fill_size: 0.01, fee: 0.5, funding_paid: null, order_created_at: "2024-01-10T10:00:01", filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", status: "filled", price: 94000, size: 0.01, order_side: "sell", order_type: "stop", fill_price: 94000, fill_size: 0.01, fee: 0.5, funding_paid: null, order_created_at: "2024-01-10T10:00:03", filled_at: "2024-01-10T10:05:00", fill_ts: "2024-01-10T10:05:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    const pos = result[0];
    expect(pos.fundingPaid).toBe(0);
    // PnL: (94000 - 95000) * 0.01 - 1.0 = -11 (no funding deduction)
    expect(pos.realizedPnl).toBeCloseTo(-11, 2);
  });

  it("applies positive funding_paid (received) to PnL for SHORT positions", () => {
    const rows: PositionHistoryRow[] = [
      row({ signal_id: 5, asset: "ETH", side: "SHORT", strategy_name: "test-strat-mr", created_at: "2024-01-10T12:00:00", order_id: 10, tag: "entry", status: "filled", price: 3000, size: 0.1, order_side: "sell", fill_price: 3000, fill_size: 0.1, fee: 0.3, funding_paid: 2.0, order_created_at: "2024-01-10T12:00:01", filled_at: "2024-01-10T12:00:02", fill_ts: "2024-01-10T12:00:02" }),
      row({ signal_id: 5, asset: "ETH", side: "SHORT", strategy_name: "test-strat-mr", created_at: "2024-01-10T12:00:00", order_id: 11, tag: "tp1", status: "filled", price: 2900, size: 0.1, order_side: "buy", order_type: "limit", fill_price: 2900, fill_size: 0.1, fee: 0.3, funding_paid: 2.0, order_created_at: "2024-01-10T12:00:03", filled_at: "2024-01-10T12:30:00", fill_ts: "2024-01-10T12:30:00" }),
    ];

    const result = aggregatePositionHistory(rows);
    const pos = result[0];
    expect(pos.fundingPaid).toBe(2.0);
    // PnL SHORT without funding: (3000 - 2900) * 0.1 - 0.6 = 10 - 0.6 = 9.4
    // PnL SHORT with funding: 9.4 + 2.0 = 11.4
    expect(pos.realizedPnl).toBeCloseTo(11.4, 2);
  });

  it("SHORT exit with partial WS fills only (no placeholder) computes correct PnL", () => {
    // Regression: strategy-runner used to insert a placeholder fill (fee=0, full size)
    // alongside real WS fills, doubling the exit value and producing wrong PnL.
    // Real bug data: SOL SHORT signal_id=3, entry size=1.1, exit order_id=10
    // 3 WS partial fills: 0.95 + 0.14 + 0.01 = 1.1 (correct total)
    const rows: PositionHistoryRow[] = [
      // Entry: single fill
      row({
        signal_id: 3, asset: "SOL", side: "SHORT", strategy_name: "orb-daily",
        created_at: "2024-02-01T10:00:00", entry_price: 84.66,
        order_id: 5, tag: "entry", status: "filled", price: 84.66, size: 1.1,
        order_side: "sell", order_type: "market", mode: "mainnet",
        fill_price: 84.66, fill_size: 1.1, fee: 0.042,
        order_created_at: "2024-02-01T10:00:01",
        filled_at: "2024-02-01T10:00:02", fill_ts: "2024-02-01T10:00:02",
      }),
      // SL cancelled
      row({
        signal_id: 3, asset: "SOL", side: "SHORT", strategy_name: "orb-daily",
        created_at: "2024-02-01T10:00:00", entry_price: 84.66,
        order_id: 6, tag: "sl", status: "cancelled", price: 87.0, size: 1.1,
        order_side: "buy", order_type: "stop", mode: "mainnet",
        fill_price: null, fill_size: null, fee: null, fill_ts: null,
        order_created_at: "2024-02-01T10:00:03", filled_at: null,
      }),
      // Exit: 3 partial WS fills (NO placeholder) — same order_id=10
      row({
        signal_id: 3, asset: "SOL", side: "SHORT", strategy_name: "orb-daily",
        created_at: "2024-02-01T10:00:00", entry_price: 84.66,
        order_id: 10, tag: "exit", status: "filled", price: 84.62, size: 1.1,
        order_side: "buy", order_type: "market", mode: "mainnet",
        fill_price: 84.62, fill_size: 0.95, fee: 0.036,
        order_created_at: "2024-02-01T14:00:00",
        filled_at: "2024-02-01T14:00:00", fill_ts: "2024-02-01T14:00:00",
      }),
      row({
        signal_id: 3, asset: "SOL", side: "SHORT", strategy_name: "orb-daily",
        created_at: "2024-02-01T10:00:00", entry_price: 84.66,
        order_id: 10, tag: "exit", status: "filled", price: 84.62, size: 1.1,
        order_side: "buy", order_type: "market", mode: "mainnet",
        fill_price: 84.63, fill_size: 0.14, fee: 0.005,
        order_created_at: "2024-02-01T14:00:00",
        filled_at: "2024-02-01T14:00:00", fill_ts: "2024-02-01T14:00:01",
      }),
      row({
        signal_id: 3, asset: "SOL", side: "SHORT", strategy_name: "orb-daily",
        created_at: "2024-02-01T10:00:00", entry_price: 84.66,
        order_id: 10, tag: "exit", status: "filled", price: 84.62, size: 1.1,
        order_side: "buy", order_type: "market", mode: "mainnet",
        fill_price: 84.63, fill_size: 0.01, fee: 0.0004,
        order_created_at: "2024-02-01T14:00:00",
        filled_at: "2024-02-01T14:00:00", fill_ts: "2024-02-01T14:00:02",
      }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result).toHaveLength(1);

    const pos = result[0];
    expect(pos.direction).toBe("SHORT");
    expect(pos.status).toBe("CLOSED");
    expect(pos.size).toBeCloseTo(1.1, 4);

    // Exit VWAP from 3 partial fills
    const exitValue = 84.62 * 0.95 + 84.63 * 0.14 + 84.63 * 0.01;
    const exitVwap = exitValue / 1.1;
    expect(pos.exitPrice).toBeCloseTo(exitVwap, 2);

    // Total fees: entry 0.042 + exit (0.036 + 0.005 + 0.0004) = 0.0834
    const totalFees = 0.042 + 0.036 + 0.005 + 0.0004;
    expect(pos.totalFees).toBeCloseTo(totalFees, 4);

    // PnL SHORT: entryValue - exitValue - fees
    const entryValue = 84.66 * 1.1;
    const expectedPnl = entryValue - exitValue - totalFees;
    expect(pos.realizedPnl).toBeCloseTo(expectedPnl, 2);
    // PnL should be near zero (small spread minus fees), NOT -93 (the doubled-exit bug)
    expect(Math.abs(pos.realizedPnl!)).toBeLessThan(1);
    expect(pos.realizedPnl!).toBeGreaterThan(-1);
  });

  it("extracts mode from entry order", () => {
    const rows: PositionHistoryRow[] = [
      row({ order_id: 1, tag: "entry", mode: "mainnet", status: "filled", fill_price: 95000, fill_size: 0.01, fee: 0.5, filled_at: "2024-01-10T10:00:02", fill_ts: "2024-01-10T10:00:02" }),
      row({ order_id: 2, tag: "sl", mode: "mainnet", status: "pending", price: 94000, size: 0.01, order_side: "sell", fill_price: null, fill_size: null, fee: null, fill_ts: null, filled_at: null }),
    ];

    const result = aggregatePositionHistory(rows);
    expect(result[0].mode).toBe("mainnet");
  });
});
